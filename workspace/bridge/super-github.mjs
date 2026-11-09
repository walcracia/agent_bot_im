import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const TASK = /^[A-Za-z0-9_-]{1,80}$/;
const SHA = /^[a-f0-9]{40,64}$/i;
const login = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value);

export async function githubCommand(file, args, options = {}) {
  return executeFile(file, args, { cwd: options.cwd, windowsHide: true, shell: false,
    timeout: options.timeoutMs ?? 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...options.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });
}

/** A trusted deployment proxy belongs to this Git call, never global Git or process settings. */
export function configuredGithubCommand(options = {}) {
  const command = options.command ?? githubCommand;
  let configured = options.gitProxy;
  if (options.proxyEnv !== undefined) {
    if (typeof options.proxyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.proxyEnv)) throw new Error('Invalid Git proxy environment name.');
    if (configured === undefined) configured = process.env[options.proxyEnv];
    if (configured === undefined) throw new Error('Configured Git proxy environment variable is missing.');
  }
  if (configured === undefined) return command;
  let url;
  try { url = new URL(configured); } catch { throw new Error('Git proxy must be an HTTP(S) origin without credentials.'); }
  if (typeof configured !== 'string' || !/^https?:\/\/[^/?#\\]+\/?$/i.test(configured) || /\s|[\0\r\n]/.test(configured) || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Git proxy must be an HTTP(S) origin without credentials.');
  const proxy = url.origin;
  return (file, args, call = {}) => {
    if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(file)) return command(file, args, call);
    return command(file, ['-c', 'http.proxy=' + proxy, ...args], { ...call,
      env: { ...call.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } });
  };
}

function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value)
      || value.split('/')[1] === '.' || value.split('/')[1] === '..') throw new Error('A fixed owner/repository is required.');
  return value;
}
function actors(value = []) {
  if (!Array.isArray(value) || value.some(item => !login(item))) throw new Error('GitHub actors must be explicit login names.');
  return new Set(value.map(item => item.toLowerCase()));
}
function actor(user) {
  return { id: String(user?.id ?? ''), username: user?.login ?? '', is_bot: user?.type === 'Bot' || /\[bot\]$/i.test(user?.login ?? '') };
}
async function output(command, file, args, options) {
  let result;
  try { result = await command(file, args, options); }
  catch { throw new Error('GitHub, Git or verification command failed; inspect the local task environment.'); }
  if (result && typeof result === 'object' && result.exitCode !== undefined && result.exitCode !== 0) throw new Error(`${file} exited unsuccessfully.`);
  const text = typeof result === 'string' ? result : result?.stdout;
  if (typeof text !== 'string') throw new Error(`${file} returned no text output.`);
  return text;
}
async function api(command, endpoint, { pages = false, cwd } = {}) {
  const raw = await output(command, 'gh', ['api', '--method', 'GET', endpoint,
    ...(pages ? ['--paginate', '--slurp'] : []), '-H', 'Accept: application/vnd.github+json'], { cwd });
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('GitHub returned malformed JSON.'); }
  if (pages) {
    if (!Array.isArray(value) || value.some(page => !Array.isArray(page))) throw new Error('GitHub returned malformed pages.');
    return value.flat();
  }
  return value;
}
function validPr(pr, repository, number) {
  if (!pr || pr.number !== number || !['open', 'closed'].includes(pr.state) || !SHA.test(pr.head?.sha)
      || pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error('GitHub PR identity does not match its binding.');
  return pr;
}
function latestChecks(data, head) {
  if (!data || !Array.isArray(data.check_runs)) throw new Error('GitHub returned malformed check runs.');
  const checks = new Map();
  for (const item of data.check_runs) {
    if (typeof item.name !== 'string' || !Number.isSafeInteger(item.id) || item.head_sha !== head) continue;
    const old = checks.get(item.name);
    if (!old || item.id > old.id) checks.set(item.name, { id: item.id, name: item.name, head,
      status: item.status, conclusion: item.conclusion ?? null, url: item.html_url ?? '',
      at: item.completed_at ?? item.started_at ?? '' });
  }
  return [...checks.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Only bound PRs can produce events. Its returned cursor commits with the coordinator's inbox. */
export class GitHubSource {
  constructor(options) {
    const { repository, allowedActors = [], now = () => new Date().toISOString() } = options;
    this.repository = repositoryName(repository); this.allowed = actors(allowedActors);
    Object.assign(this, { command: configuredGithubCommand(options), now });
  }

  async poll(bindings, cursor = {}) {
    if (!Array.isArray(bindings) || !cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('Invalid GitHub bindings or cursor.');
    if (cursor.version !== undefined && cursor.version !== 1) throw new Error('Unknown GitHub cursor version.');
    if (cursor.repository !== undefined && cursor.repository !== this.repository) throw new Error('GitHub cursor belongs to another repository.');
    if (cursor.objects !== undefined && (!cursor.objects || typeof cursor.objects !== 'object' || Array.isArray(cursor.objects)
        || Object.values(cursor.objects).some(item => typeof item !== 'string'))) throw new Error('Invalid GitHub object cursor.');
    const objects = {}, events = [], emitted = new Set(), seenBindings = new Set();
    for (const binding of bindings) {
      const { taskId, number, conversationId } = binding;
      if (!TASK.test(taskId) || !Number.isSafeInteger(number) || number < 1 || (conversationId !== undefined && typeof conversationId !== 'string'))
        throw new Error('Invalid bound task or PR number.');
      const bindingKey = `${taskId}:${number}`;
      if (seenBindings.has(bindingKey)) continue;
      seenBindings.add(bindingKey);
      for (const [key, value] of Object.entries(cursor.objects ?? {})) {
        if (key.startsWith(bindingKey + ':')) objects[key] = value;
      }
      const prefix = `repos/${this.repository}`, threadId = `github:${this.repository}:pr:${number}`;
      const pr = validPr(await api(this.command, `${prefix}/pulls/${number}`), this.repository, number);
      const make = (kind, key, version, text, user, at, url, meta = {}) => {
        const canonical = `${bindingKey}:${key}`, fingerprint = digest(version);
        objects[canonical] = fingerprint;
        if (cursor.objects?.[canonical] === fingerprint) return;
        const id = `github:${this.repository}:${key}:${fingerprint}`;
        if (emitted.has(`${taskId}:${id}`)) return;
        emitted.add(`${taskId}:${id}`);
        events.push({ id, source: 'github', threadId, taskId, ...(conversationId === undefined ? {} : { conversationId }),
          number, kind, text, actor: actor(user), at: at || this.now(), url: url ?? pr.html_url, meta: { ...meta, head: pr.head.sha } });
      };
      // Closing is a terminal lifecycle event, not a fresh code-work request.
      if (pr.state === 'closed') {
        make('closed', `pr:${number}:closed`, [pr.state, pr.merged, pr.closed_at, pr.merge_commit_sha],
          pr.merged ? 'Pull request merged.' : 'Pull request closed without merging.', pr.merged_by ?? pr.user,
          pr.merged_at ?? pr.closed_at, pr.html_url, { state: 'closed', merged: Boolean(pr.merged), mergeCommit: pr.merge_commit_sha ?? null });
        continue;
      }
      const groups = [
        ['comment', 'issue-comment', `${prefix}/issues/${number}/comments?per_page=100`],
        ['comment', 'review-comment', `${prefix}/pulls/${number}/comments?per_page=100`],
        ['review', 'review', `${prefix}/pulls/${number}/reviews?per_page=100`],
      ];
      for (const [kind, namespace, endpoint] of groups) {
        for (const item of await api(this.command, endpoint, { pages: true })) {
          const who = actor(item.user);
          if (!this.allowed.has(who.username.toLowerCase()) || who.is_bot || !Number.isSafeInteger(item.id)) continue;
          if (kind === 'review' && (!item.submitted_at || item.state === 'PENDING')) continue;
          const text = String(item.body ?? '');
          make(kind, `${namespace}:${item.id}`, [item.updated_at ?? item.submitted_at, text, item.state], text, item.user,
            item.updated_at ?? item.submitted_at ?? item.created_at, item.html_url,
            { state: item.state ?? null, path: item.path ?? null, line: item.line ?? null, commit: item.commit_id ?? null });
        }
      }
      const checks = await this.readChecks(pr.head.sha);
      for (const check of checks) make('ci', `${check.kind ?? 'check'}:${check.id}`, [check.head, check.status, check.conclusion],
        `CI ${check.name}: ${check.status}${check.conclusion ? ` / ${check.conclusion}` : ''}.`, { login: 'github-actions', type: 'Bot' },
        check.at, check.url, { ...check });
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return { events, cursor: { version: 1, repository: this.repository, objects } };
  }

  async readChecks(head, cwd) {
    // --paginate --slurp returns objects for this endpoint, rather than array pages.
    const endpoint = `repos/${this.repository}/commits/${head}/check-runs?per_page=100&filter=latest`;
    const raw = await output(this.command, 'gh', ['api', '--method', 'GET', endpoint, '--paginate', '--slurp',
      '-H', 'Accept: application/vnd.github+json'], { cwd });
    let pages;
    try { pages = JSON.parse(raw); } catch { throw new Error('GitHub returned malformed check pages.'); }
    if (!Array.isArray(pages)) throw new Error('GitHub returned malformed check pages.');
    const all = pages.flatMap(page => {
      if (!page || !Array.isArray(page.check_runs)) throw new Error('GitHub returned malformed check pages.');
      return page.check_runs;
    });
    const checks = latestChecks({ check_runs: all }, head).map(check => ({ ...check, kind: 'check' }));
    // Commit Status contexts are still used by older CI providers and branch protection.
    const statusRaw = await output(this.command, 'gh', ['api', '--method', 'GET',
      `repos/${this.repository}/commits/${head}/status?per_page=100`, '--paginate', '--slurp',
      '-H', 'Accept: application/vnd.github+json'], { cwd });
    let statusPages;
    try { statusPages = JSON.parse(statusRaw); } catch { throw new Error('GitHub returned malformed status pages.'); }
    if (!Array.isArray(statusPages) || statusPages.some(page => !Array.isArray(page?.statuses))) throw new Error('GitHub returned malformed status pages.');
    const statuses = new Map();
    for (const item of statusPages.flatMap(page => page.statuses)) {
      if (!Number.isSafeInteger(item.id) || typeof item.context !== 'string' || !['pending', 'success', 'failure', 'error'].includes(item.state)) continue;
      const old = statuses.get(item.context);
      if (!old || item.id > old.id) statuses.set(item.context, { kind: 'status', id: item.id, name: item.context,
        head, status: item.state === 'pending' ? 'in_progress' : 'completed', conclusion: item.state === 'pending' ? null : item.state,
        url: item.target_url ?? '', at: item.updated_at ?? item.created_at ?? '' });
    }
    return [...checks, ...statuses.values()];
  }
}

function matchesRepository(url, repository) {
  return [
    `https://github.com/${repository}`, `https://github.com/${repository}.git`,
    `git@github.com:${repository}`, `git@github.com:${repository}.git`,
    `ssh://git@github.com/${repository}`, `ssh://git@github.com/${repository}.git`,
  ].some(candidate => url.toLowerCase() === candidate.toLowerCase());
}
function sensitiveFile(path) {
  return path.split('/').some(part => /^\.team-relay-incoming-/i.test(part))
    || path.split('/').some(part => /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|node_modules|\.dsh|\.codex)$/i.test(part)
      && !/^\.env\.(?:example|sample)$/i.test(part))
    || /\.(?:pem|p12|pfx|key|sqlite3?|db|log)$/i.test(path)
    || /(?:^|\/)(?:auth|credentials|secrets?|demo-accounts|server-process|dsh-process)\.json$/i.test(path)
    || /^environment\/(?:data|logs|verification|tools|venv)\//i.test(path)
    || /^environment\/config\/.*(?:\.local\.json|credential)/i.test(path);
}
function commandList(value, label) {
  if (!Array.isArray(value) || value.some(argv => !Array.isArray(argv) || !argv.length
      || argv.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg)))) throw new Error(`${label} must contain trusted argv arrays.`);
  return value.map(argv => [...argv]);
}

/** Tests and ordinary Git pushes are scoped to one task worktree; no merge policy comes from chat. */
export class GitDelivery {
  constructor(options) {
    this.repository = repositoryName(options.repository);
    this.base = options.base ?? 'main'; this.remote = options.remote ?? 'origin';
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(this.base) || this.base.includes('..')
        || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(this.remote)) throw new Error('Invalid trusted Git base or remote.');
    this.testCommands = commandList(options.testCommands ?? [], 'testCommands');
    this.requiredChecks = options.requiredChecks ?? [];
    if (!Array.isArray(this.requiredChecks) || this.requiredChecks.some(name => typeof name !== 'string' || !name.trim())) throw new Error('Invalid requiredChecks.');
    this.reviewers = actors(options.reviewers ?? []);
    this.autoMerge = options.autoMerge === true;
    if (this.autoMerge && (!this.requiredChecks.length || !this.reviewers.size)) throw new Error('Automatic merge needs required checks and trusted reviewers.');
    this.command = configuredGithubCommand(options);
    this.worktreesPath = options.worktreesPath;
    this.testTimeoutMs = options.testTimeoutMs ?? 7200000;
    if (!Number.isSafeInteger(this.testTimeoutMs) || this.testTimeoutMs < 100 || this.testTimeoutMs > 86400000) throw new Error('Invalid test timeout.');
    this.active = new Map();
    this.source = new GitHubSource({ repository: this.repository, command: this.command });
  }

  deliver(task) {
    if (!TASK.test(task?.id)) return Promise.reject(new Error('Invalid delivery task.'));
    if (this.active.has(task.id)) return this.active.get(task.id);
    const promise = this.perform(task).finally(() => this.active.delete(task.id));
    this.active.set(task.id, promise);
    return promise;
  }
  sync(task) { return this.deliver(task); }

  async perform(task) {
    const assertActive = typeof task.assertActive === 'function' ? task.assertActive : async () => {};
    await assertActive();
    if (!this.testCommands.length) throw new Error('Code delivery requires configured verification commands.');
    if (typeof task.workspace !== 'string' || !isAbsolute(task.workspace)
        || typeof task.branch !== 'string' || !/^codex\/[A-Za-z0-9][A-Za-z0-9._/-]{0,170}$/.test(task.branch)
        || task.branch.includes('..')) throw new Error('Delivery needs an absolute task worktree and codex/ branch.');
    const cwd = await realpath(task.workspace);
    if (this.worktreesPath) {
      const parent = await realpath(this.worktreesPath), remainder = relative(parent, cwd);
      if (!remainder || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) throw new Error('Delivery worktree escaped its configured root.');
    }
    const scratch = await mkdtemp(join(tmpdir(), 'team-relay-delivery-'));
    const git = (...args) => output(this.command, 'git', ['-c', `core.hooksPath=${scratch}`, '-c', 'core.fsmonitor=false', ...args], { cwd });
    const gh = (...args) => output(this.command, 'gh', args, { cwd });
    try {
      if (resolve((await git('rev-parse', '--show-toplevel')).trim()) !== resolve(cwd)) throw new Error('Task workspace is not its Git root.');
      if ((await git('symbolic-ref', '--quiet', '--short', 'HEAD')).trim() !== task.branch) throw new Error('Task branch changed before delivery.');
      await git('check-ref-format', '--branch', task.branch);
      if (!matchesRepository((await git('remote', 'get-url', this.remote)).trim(), this.repository)
          || !matchesRepository((await git('remote', 'get-url', '--push', this.remote)).trim(), this.repository))
        throw new Error('Task remote does not match the configured GitHub repository.');
      const initial = await git('status', '--porcelain=v1', '-z', '--untracked-files=all');
      const contentSnapshot = async () => {
        const hash = createHash('sha256').update(await git('diff', '--no-ext-diff', '--binary', 'HEAD', '--'));
        for (const name of (await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)) {
          const path = join(cwd, name), info = await lstat(path);
          hash.update(name); hash.update(info.isSymbolicLink() ? await readlink(path) : await readFile(path));
        }
        return hash.digest('hex');
      };
      const beforeContent = await contentSnapshot();
      const tests = [];
      for (const argv of this.testCommands) {
        await output(this.command, argv[0], argv.slice(1), { cwd, timeoutMs: this.testTimeoutMs });
        tests.push({ command: argv, exitCode: 0 });
      }
      if (initial !== await git('status', '--porcelain=v1', '-z', '--untracked-files=all') || beforeContent !== await contentSnapshot())
        throw new Error('Verification changed the worktree; inspect generated changes before delivery.');
      const files = [...new Set([
        ...((await git('diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--')).split('\0')),
        ...((await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0')),
      ].filter(Boolean))];
      for (const path of files) {
        if (/[\r\n]/.test(path) || path.startsWith('/') || path.split('/').includes('..') || sensitiveFile(path))
          throw new Error('Delivery contains a sensitive or invalid file path; inspect the task worktree.');
      }
      if (files.length) {
        await assertActive();
        await git('add', '--', ...files);
        const staged = await git('diff', '--cached', '--no-ext-diff', '--name-only', '-z');
        if (staged.split('\0').filter(Boolean).some(path => !files.includes(path) || sensitiveFile(path))) throw new Error('Staging includes files outside the verified task change.');
        await assertActive();
        await git('commit', '-m', `Task ${task.id}: ${String(task.summary ?? 'code update').replace(/[\r\n\0]/g, ' ').slice(0, 120)}`);
      }
      const head = (await git('rev-parse', 'HEAD')).trim();
      if (!SHA.test(head)) throw new Error('Invalid task HEAD.');
      // A retry after a lost push response can use the proved remote ref.
      let pushError;
      await assertActive();
      try { await git('push', this.remote, `${head}:refs/heads/${task.branch}`); } catch (error) { pushError = error; }
      const remoteHead = (await git('ls-remote', '--heads', this.remote, `refs/heads/${task.branch}`)).trim().split(/\s+/)[0];
      if (remoteHead !== head) throw new Error(pushError ? 'Push failed and the task head is not present remotely.' : 'Remote task head does not match delivery.');
      const marker = `<!-- team-relay-task:${task.id} -->`;
      const body = [marker, `Task ${task.id}: ${String(task.summary ?? '').slice(0, 200)}`, '',
        'Implemented in the dedicated task worktree. Verification completed before this delivery:',
        ...tests.map(entry => `- ${JSON.stringify(entry.command)}: exit 0`), '', `Head: ${head}`].join('\n');
      const bodyFile = join(scratch, 'pull-request.md'); await writeFile(bodyFile, body, 'utf8');
      const find = async () => {
        const list = await api(this.command, `repos/${this.repository}/pulls?state=all&head=${encodeURIComponent(this.repository.split('/')[0] + ':' + task.branch)}&base=${encodeURIComponent(this.base)}&per_page=100`, { pages: true, cwd });
        const matched = list.filter(pr => pr.head?.ref === task.branch && pr.base?.ref === this.base
          && pr.head?.repo?.full_name?.toLowerCase() === this.repository.toLowerCase());
        if (matched.length > 1) throw new Error('Task branch has multiple pull requests; inspect its delivery history.');
        return matched[0];
      };
      let pr = await find();
      if (pr && !String(pr.body ?? '').includes(marker)) throw new Error('Existing PR belongs to another task.');
      if (!pr) {
        let createError;
        await assertActive();
        try { await gh('pr', 'create', '--repo', this.repository, '--base', this.base, '--head', task.branch,
          '--title', `Task ${task.id}: ${String(task.summary ?? 'code update').replace(/[\r\n\0]/g, ' ').slice(0, 120)}`, '--body-file', bodyFile); }
        catch (error) { createError = error; }
        pr = await find();
        if (!pr) throw new Error(createError ? 'PR creation was not confirmed; retain the task delivery for retry.' : 'Created PR could not be found.');
        if (!String(pr.body ?? '').includes(marker)) throw new Error('Created PR task marker does not match.');
      } else if (pr.state === 'open') {
        await assertActive();
        await gh('pr', 'edit', String(pr.number), '--repo', this.repository, '--body-file', bodyFile);
      }
      pr = validPr(await api(this.command, `repos/${this.repository}/pulls/${pr.number}`, { cwd }), this.repository, pr.number);
      if (pr.head.sha !== head || pr.head.ref !== task.branch || pr.base.ref !== this.base) throw new Error('PR head/base changed during delivery.');
      const checks = await this.source.readChecks(head, cwd);
      const merged = pr.merged === true || (pr.state === 'open' && await this.maybeMerge(pr, head, checks, gh, cwd, assertActive));
      // Release commands run only after confirmed merge, and are not auto-retried after uncertainty.
      // The coordinator should execute a named release job, not re-enter deliver(), to publish artifacts.
      return { number: pr.number, url: pr.html_url, branch: task.branch, head,
        threadId: `github:${this.repository}:pr:${pr.number}`, checks, merged, tests };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }

  async maybeMerge(pr, head, checks, gh, cwd, assertActive) {
    if (!this.autoMerge || pr.draft || pr.mergeable !== true) return false;
    if (!this.requiredChecks.every(name => {
      const matching = checks.filter(check => check.name === name);
      return matching.length > 0 && matching.every(check => check.head === head && check.status === 'completed' && check.conclusion === 'success');
    })) return false;
    const reviews = await api(this.command, `repos/${this.repository}/pulls/${pr.number}/reviews?per_page=100`, { pages: true, cwd });
    const latest = new Map();
    for (const review of reviews) {
      const who = actor(review.user);
      if (who.is_bot || !this.reviewers.has(who.username.toLowerCase()) || review.state === 'COMMENTED' || review.state === 'PENDING') continue;
      const old = latest.get(who.username.toLowerCase());
      if (!old || review.id > old.id) latest.set(who.username.toLowerCase(), review);
    }
    const verdicts = [...latest.values()];
    if (verdicts.some(review => review.state === 'CHANGES_REQUESTED')
        || !verdicts.some(review => review.state === 'APPROVED' && review.commit_id === head)) return false;
    await assertActive();
    await gh('pr', 'merge', String(pr.number), '--repo', this.repository, '--squash', '--match-head-commit', head);
    const updated = validPr(await api(this.command, `repos/${this.repository}/pulls/${pr.number}`, { cwd }), this.repository, pr.number);
    if (!updated.merged || updated.head.sha !== head) throw new Error('PR merge was not confirmed at the reviewed head.');
    return true;
  }
}
