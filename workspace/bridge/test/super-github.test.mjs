import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredGithubCommand, GitDelivery, GitHubSource } from '../super-github.mjs';

const exec = promisify(execFile);
const repo = 'owner/project', sha = 'a'.repeat(40), when = '2026-11-09T08:00:00Z';
const human = { id: 1, login: 'alice', type: 'User' };
const basePr = (extra = {}) => ({ number: 7, state: 'open', merged: false, draft: false, mergeable: true,
  html_url: `https://github.com/${repo}/pull/7`, user: { id: 2, login: 'relay' },
  base: { ref: 'main', repo: { full_name: repo } },
  head: { sha, ref: 'codex/T000001', repo: { full_name: repo } }, ...extra });
const comment = (id, extra = {}) => ({ id, user: human, body: 'Please cover the empty input.', created_at: when, updated_at: when, ...extra });

test('trusted Git proxy is command-local, keeps gh direct and never changes global Git or parent environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-proxy-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const globalFile = join(root, 'synthetic-global.gitconfig'), original = '[user]\n\tname = Synthetic Test\n';
  await writeFile(globalFile, original);
  const before = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY }, calls = [];
  const command = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'gh') return { stdout: '{}' };
    return exec(file, args, { cwd: root, env: { ...process.env, ...options.env, GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: '1' }, windowsHide: true });
  };
  const run = configuredGithubCommand({ gitProxy: 'http://proxy.example.invalid:8080', command });
  assert.equal((await run('git', ['config', '--get', 'http.proxy'])).stdout.trim(), 'http://proxy.example.invalid:8080');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-c', 'http.proxy=http://proxy.example.invalid:8080']);
  assert.equal(await readFile(globalFile, 'utf8'), original);
  assert.deepEqual({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY }, before);
  await run('gh', ['api', 'repos/owner/project']);
  assert.deepEqual(calls.at(-1).args, ['api', 'repos/owner/project']); assert.equal(calls.at(-1).options.env.HTTP_PROXY, process.env.HTTP_PROXY);
  for (const gitProxy of ['http://user:password@proxy.invalid', 'http://proxy.invalid/path', 'http://proxy.invalid/a/../', 'http://proxy.invalid/?q=1', 'socks5://proxy.invalid', 'http://proxy.invalid/#fragment'])
    assert.throws(() => configuredGithubCommand({ gitProxy }), /proxy/);
});

test('failed GitHub commands keep private diagnostics locally while outward errors stay concise with a retained cause', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-private-diagnostics-')); t.after(() => rm(root, { recursive: true, force: true }));
  const diagnosticsPath = join(root, 'private-command-evidence');
  const source = new GitHubSource({ repository: repo, allowedActors: ['alice'], diagnosticsPath, command: async () => {
    throw Object.assign(new Error('PRIVATE synthetic stderr must stay local'), { code: 17, stdout: 'PRIVATE synthetic stdout', stderr: 'PRIVATE synthetic stderr' });
  } });
  let failure;
  try { await source.poll([{ taskId: 'T1', number: 7 }]); } catch (cause) { failure = cause; }
  assert.ok(failure); assert.ok(!failure.message.includes('PRIVATE'));
  assert.ok(failure.cause); assert.ok(failure.diagnosticPath.startsWith(diagnosticsPath));
  const evidence = JSON.parse(await readFile(failure.diagnosticPath, 'utf8'));
  assert.equal(evidence.code, 17); assert.equal(evidence.stdout, 'PRIVATE synthetic stdout'); assert.equal(evidence.stderr, 'PRIVATE synthetic stderr');
  assert.ok(evidence.argv.includes('repos/owner/project/pulls/7'));
  assert.throws(() => configuredGithubCommand({ diagnosticsPath: 'relative/path' }), /absolute/);
});

test('verification subprocess cannot inherit IM, controller, provider or GitHub tokens, while git keeps necessary auth', async () => {
  const run = configuredGithubCommand({ secretEnvNames: ['CUSTOM_TEST_CONNECTION'] });
  const names = ['TEAM_RELAY_BOT_TOKEN', 'SUPER_AGENT_CONTROL_TOKEN', 'SUPER_AGENT_DAEMON_TOKEN', 'SUPER_AGENT_CONTEXT_TOKEN',
    'SUPER_AGENT_ENVIRONMENT_TOKEN', 'SUPER_AGENT_RESTART_TOKEN_BUNDLE', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'CUSTOM_TEST_CONNECTION'];
  const env = { ...process.env, ...Object.fromEntries(names.map(name => [name, 'synthetic-private-test-value'])) };
  const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,process.env[name]??null]))))`;
  const result = await run(process.execPath, ['-e', script], { env });
  assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries(names.map(name => [name, null])));
  assert.equal(env.TEAM_RELAY_BOT_TOKEN, 'synthetic-private-test-value');
  let inherited;
  const git = configuredGithubCommand({ secretEnvNames: ['CUSTOM_TEST_CONNECTION'], command: async (file, args, options) => { inherited = options.env; return { stdout: '' }; } });
  await git('git', ['rev-parse', 'HEAD'], { env });
  assert.equal(inherited.GH_TOKEN, 'synthetic-private-test-value'); assert.equal(inherited.TEAM_RELAY_BOT_TOKEN, undefined); assert.equal(inherited.CUSTOM_TEST_CONNECTION, undefined);
});

function sourceFixture() {
  const calls = [], fixture = { pr: basePr(), comments: [comment(1)], lines: [comment(2, { path: 'app.js', line: 4 })],
    reviews: [comment(3, { state: 'CHANGES_REQUESTED', submitted_at: when, commit_id: sha })],
    checks: [{ id: 4, name: 'test', head_sha: sha, status: 'in_progress', conclusion: null, started_at: when }], calls };
  fixture.command = async (file, args) => {
    assert.equal(file, 'gh'); calls.push(args);
    const endpoint = args.find(arg => arg.startsWith('repos/'));
    if (fixture.fail && endpoint.includes(fixture.fail)) throw new Error('SECRET must not escape into error messages');
    let value;
    if (endpoint.endsWith('/pulls/7')) value = fixture.pr;
    else if (endpoint.includes('/issues/7/comments')) value = [fixture.comments];
    else if (endpoint.includes('/pulls/7/comments')) value = [fixture.lines];
    else if (endpoint.includes('/pulls/7/reviews')) value = [fixture.reviews];
    else if (endpoint.includes('/check-runs')) value = [{ check_runs: fixture.checks }];
    else if (endpoint.includes('/status?')) value = [{ statuses: fixture.statuses ?? [] }];
    else throw new Error('Unexpected source endpoint ' + endpoint);
    return { stdout: JSON.stringify(value) };
  };
  fixture.source = new GitHubSource({ repository: repo, allowedActors: ['alice'], command: fixture.command, now: () => when });
  return fixture;
}

test('bound PR comments, inline reviews and CI become original task events, with durable version deduplication', async () => {
  const f = sourceFixture(), bindings = [{ taskId: 'T000001', number: 7, conversationId: 'c1' }], original = {};
  const first = await f.source.poll(bindings, original);
  assert.deepEqual(original, {});
  assert.deepEqual(first.events.map(event => event.kind).sort(), ['ci', 'comment', 'comment', 'review']);
  assert.ok(first.events.every(event => event.taskId === 'T000001' && event.conversationId === 'c1'
    && event.threadId === 'github:owner/project:pr:7'));
  const second = await f.source.poll(bindings, first.cursor);
  assert.deepEqual(second.events, []);
  f.comments[0].body = 'Updated request: handle Unicode too.';
  f.comments[0].updated_at = '2026-11-09T08:01:00Z';
  f.checks[0].status = 'completed'; f.checks[0].conclusion = 'failure';
  const changed = await f.source.poll(bindings, second.cursor);
  assert.deepEqual(changed.events.map(event => event.kind).sort(), ['ci', 'comment']);
  assert.equal(changed.events.find(event => event.kind === 'ci').meta.conclusion, 'failure');
  assert.notEqual(changed.events.find(event => event.kind === 'comment').id, first.events.find(event => event.kind === 'comment' && !event.meta.path).id);
  assert.ok(f.calls.every(args => !args.some(arg => /pulls\/8|issues\/8/.test(arg))));
});

test('unlisted users and bots cannot inject code inputs, even if a bot login is allowed', async () => {
  const f = sourceFixture();
  f.comments = [comment(1, { user: { id: 3, login: 'outsider', type: 'User' } }),
    comment(2, { user: { id: 4, login: 'alice', type: 'Bot' } })];
  f.lines = []; f.reviews = []; f.checks = [];
  assert.deepEqual((await f.source.poll([{ taskId: 'T1', number: 7 }])).events, []);
  assert.deepEqual((await f.source.poll([])).events, []);
});

test('close and merge are terminal facts and do not replay historical work comments', async () => {
  const f = sourceFixture();
  f.pr.state = 'closed'; f.pr.closed_at = when;
  const closed = await f.source.poll([{ taskId: 'T1', number: 7 }]);
  assert.equal(closed.events.length, 1); assert.equal(closed.events[0].kind, 'closed');
  assert.equal(closed.events[0].meta.merged, false); assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.source.poll([{ taskId: 'T1', number: 7 }], closed.cursor)).events, []);
  f.pr.merged = true; f.pr.merge_commit_sha = 'b'.repeat(40);
  assert.equal((await f.source.poll([{ taskId: 'T1', number: 7 }], closed.cursor)).events[0].meta.merged, true);
});

test('source failure does not mutate committed cursor, and errors do not contain raw CLI secrets', async () => {
  const f = sourceFixture(), cursor = { version: 1, objects: { previous: 'fingerprint' } };
  f.fail = '/reviews';
  await assert.rejects(f.source.poll([{ taskId: 'T1', number: 7 }], cursor), error => !error.message.includes('SECRET'));
  assert.deepEqual(cursor, { version: 1, objects: { previous: 'fingerprint' } });
  await assert.rejects(f.source.poll([{ taskId: 'T1', number: '7;echo exploit' }]));
  await assert.rejects(f.source.poll([], { version: 9 }));
  await assert.rejects(f.source.poll([], { objects: [] }));
});

test('source retains only newest check run per name and does not confuse pending or stale checks with success', async () => {
  const f = sourceFixture(); f.comments = []; f.lines = []; f.reviews = [];
  f.checks = [{ id: 1, name: 'test', head_sha: sha, status: 'completed', conclusion: 'success' },
    { id: 2, name: 'test', head_sha: sha, status: 'queued', conclusion: null },
    { id: 3, name: 'lint', head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success' }];
  const result = await f.source.poll([{ taskId: 'T1', number: 7 }]);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].meta.status, 'queued');
});

test('legacy CI statuses and reopened PRs preserve the original task without replaying old comments', async () => {
  const f = sourceFixture(); f.lines = []; f.reviews = []; f.checks = [];
  f.statuses = [{ id: 1, context: 'legacy', state: 'pending', created_at: when }];
  const bindings = [{ taskId: 'T1', number: 7 }];
  const first = await f.source.poll(bindings);
  assert.equal(first.events.find(event => event.kind === 'ci').meta.status, 'in_progress');
  f.pr.state = 'closed'; f.pr.closed_at = when;
  const closed = await f.source.poll(bindings, first.cursor);
  f.pr.state = 'open'; f.statuses[0].state = 'success';
  const reopened = await f.source.poll(bindings, closed.cursor);
  assert.equal(reopened.events.length, 1); assert.equal(reopened.events[0].kind, 'ci');
  assert.equal(reopened.events[0].meta.conclusion, 'success');
});

async function realFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'team-relay-github-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'worktree'), remote = join(root, 'remote.git');
  const git = (args, cwd = workspace) => exec('git', args, { cwd, windowsHide: true });
  await exec('git', ['init', '--bare', remote], { windowsHide: true });
  await exec('git', ['init', '--initial-branch=main', workspace], { windowsHide: true });
  await git(['config', 'user.name', 'Synthetic Relay Test']); await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(workspace, 'app.js'), 'export const value = 1;\n');
  await git(['add', '--', 'app.js']); await git(['commit', '-m', 'initial fixture']);
  await git(['remote', 'add', 'origin', remote]); await git(['push', 'origin', 'main']);
  await git(['checkout', '-b', 'codex/T000001']);
  await writeFile(join(workspace, 'app.js'), 'export const value = 2;\n');
  const f = { root, workspace, remote, git, ghCalls: [], gitCalls: [], creates: 0, edits: 0, merges: 0, pr: null, ...overrides };
  f.command = async (file, args, options) => {
    if (file === 'git') {
      const plain = args.slice(4); f.gitCalls.push(plain);
      if (plain[0] === 'remote' && plain[1] === 'get-url') return { stdout: f.wrongRemote ? 'https://github.com/wrong/repo.git\n' : `https://github.com/${repo}.git\n` };
      const result = await exec(file, args, { cwd: options.cwd, windowsHide: true });
      if (plain[0] === 'push' && f.pr) f.pr.head.sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      if (plain[0] === 'push' && f.losePush) { f.losePush = false; throw new Error('lost push response'); }
      return result;
    }
    if (file !== 'gh') return exec(file, args, { cwd: options.cwd, windowsHide: true });
    f.ghCalls.push(args);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (args[0] === 'api') {
      const endpoint = args.find(arg => arg.startsWith('repos/'));
      if (endpoint.includes('/pulls?')) return { stdout: JSON.stringify([f.pr ? [f.pr] : []]) };
      if (endpoint.endsWith('/pulls/7')) return { stdout: JSON.stringify(f.pr) };
      if (endpoint.includes('/check-runs')) return { stdout: JSON.stringify([{ check_runs: [{ id: 1, name: 'test', head_sha: head,
        status: f.pending ? 'in_progress' : 'completed', conclusion: f.pending ? null : (f.checkConclusion ?? 'success') }] }]) };
      if (endpoint.includes('/status?')) return { stdout: '[{"statuses":[]}]' };
      if (endpoint.includes('/reviews')) return { stdout: JSON.stringify([[{ id: 1, user: human, state: f.reviewState ?? 'APPROVED',
        commit_id: f.staleReview ? sha : head }]]) };
      throw new Error('Unknown fake gh endpoint ' + endpoint);
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      f.creates++; const body = await readFile(args[args.indexOf('--body-file') + 1], 'utf8');
      assert.ok(body.includes('\n\n')); assert.ok(body.includes('exit 0'));
      f.pr = basePr({ head: { sha: head, ref: 'codex/T000001', repo: { full_name: repo } }, body });
      if (f.loseCreate) { f.loseCreate = false; throw new Error('lost creation response'); }
      return { stdout: f.pr.html_url };
    }
    if (args[0] === 'pr' && args[1] === 'edit') { f.edits++; return { stdout: '' }; }
    if (args[0] === 'pr' && args[1] === 'merge') {
      f.merges++; assert.equal(args[args.indexOf('--match-head-commit') + 1], head);
      f.pr.state = 'closed'; f.pr.merged = true; return { stdout: '' };
    }
    throw new Error('Unexpected fake gh call ' + args.join(' '));
  };
  f.options = { repository: repo, base: 'main', worktreesPath: root, command: f.command,
    testCommands: [['node', '-e', 'process.exit(0)']], ...overrides.options };
  f.task = { id: 'T000001', summary: 'Fix value; $(not a shell command)', workspace, branch: 'codex/T000001' };
  return f;
}

test('delivery verifies real code, commits explicit files, proves push, and creates only one PR across retries', async t => {
  const f = await realFixture(t, { loseCreate: true, losePush: true }), delivery = new GitDelivery(f.options);
  const result = await delivery.deliver(f.task);
  assert.equal(result.number, 7); assert.equal(result.branch, f.task.branch); assert.equal(f.creates, 1);
  const count = (await f.git(['rev-list', '--count', 'HEAD'])).stdout.trim(); assert.equal(count, '2');
  assert.equal(result.head, (await f.git(['rev-parse', 'HEAD'])).stdout.trim());
  assert.equal((await f.git(['status', '--porcelain'])).stdout, '');
  assert.ok(f.gitCalls.some(args => args[0] === 'add' && args[1] === '--' && args[2] === 'app.js'));
  assert.ok(!f.gitCalls.some(args => args.includes('--force')));
  const again = await delivery.sync(f.task);
  assert.equal(again.head, result.head); assert.equal(f.creates, 1); assert.equal(f.edits, 1);
  assert.equal((await f.git(['rev-list', '--count', 'HEAD'])).stdout.trim(), count);
});

test('failed configured verification never stages, commits, pushes or opens PR', async t => {
  const f = await realFixture(t); f.options.testCommands = [['node', '-e', 'process.exit(2)']];
  await assert.rejects(new GitDelivery(f.options).deliver(f.task), /command failed/);
  assert.equal(f.creates, 0); assert.ok(!f.gitCalls.some(args => ['push', 'commit', 'add'].includes(args[0])));
  assert.equal((await f.git(['rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
});

test('changed verification output, sensitive files and wrong remote each block delivery', async t => {
  const f = await realFixture(t);
  f.options.testCommands = [['node', '-e', 'require("node:fs").writeFileSync("generated.txt","test")']];
  await assert.rejects(new GitDelivery(f.options).deliver(f.task), /Verification changed/);
  f.options.testCommands = [['node', '-e', 'process.exit(0)']];
  await writeFile(join(f.workspace, '.env'), 'SYNTHETIC_SECRET=not-a-real-key');
  await assert.rejects(new GitDelivery(f.options).deliver(f.task), /sensitive/);
  f.wrongRemote = true;
  await assert.rejects(new GitDelivery(f.options).deliver(f.task), /remote/);
  assert.equal(f.creates, 0);
});

test('branch mismatch and escaped worktree cannot be delivered', async t => {
  const f = await realFixture(t);
  await assert.rejects(new GitDelivery(f.options).deliver({ ...f.task, branch: 'main' }), /codex/);
  await assert.rejects(new GitDelivery(f.options).deliver({ ...f.task, branch: 'codex/wrong' }), /branch changed/);
  await assert.rejects(new GitDelivery({ ...f.options, worktreesPath: f.remote }).deliver(f.task), /escaped/);
});

test('automatic merge requires explicit policy, fresh trusted review and successful exact-head required checks', async t => {
  assert.throws(() => new GitDelivery({ repository: repo, autoMerge: true }), /required checks/);
  const f = await realFixture(t, { pending: true });
  const delivery = new GitDelivery({ ...f.options, autoMerge: true, requiredChecks: ['test'], reviewers: ['alice'] });
  assert.equal((await delivery.deliver(f.task)).merged, false); assert.equal(f.merges, 0);
  f.pending = false; f.staleReview = true;
  assert.equal((await delivery.sync(f.task)).merged, false); assert.equal(f.merges, 0);
  f.staleReview = false; f.reviewState = 'CHANGES_REQUESTED';
  assert.equal((await delivery.sync(f.task)).merged, false); assert.equal(f.merges, 0);
  f.reviewState = 'APPROVED'; f.checkConclusion = 'failure';
  assert.equal((await delivery.sync(f.task)).merged, false); assert.equal(f.merges, 0);
  f.checkConclusion = 'success';
  assert.equal((await delivery.sync(f.task)).merged, true); assert.equal(f.merges, 1);
});

test('concurrent duplicate deliveries share one in-flight transaction', async t => {
  const f = await realFixture(t), delivery = new GitDelivery(f.options);
  const [one, two] = await Promise.all([delivery.deliver(f.task), delivery.deliver(f.task)]);
  assert.deepEqual(one, two); assert.equal(f.creates, 1);
  assert.equal((await f.git(['rev-list', '--count', 'HEAD'])).stdout.trim(), '2');
});

test('delivery rechecks cancellation before every write and prevents later push/PR creation', async t => {
  const f = await realFixture(t), delivery = new GitDelivery(f.options);
  let checks = 0;
  await assert.rejects(delivery.deliver({ ...f.task, assertActive: async () => {
    if (++checks === 3) throw new Error('Task cancelled');
  } }), /Task cancelled/);
  assert.ok(f.gitCalls.some(args => args[0] === 'add'));
  assert.ok(!f.gitCalls.some(args => args[0] === 'commit' || args[0] === 'push'));
  assert.equal(f.creates, 0);
});

test('incoming attachment directories cannot be published even if their ignore rule was removed', async t => {
  const f = await realFixture(t);
  const incoming = join(f.workspace, '.team-relay-incoming-synthetic'); await mkdir(incoming);
  await writeFile(join(incoming, 'attachment.txt'), 'synthetic private attachment');
  await assert.rejects(new GitDelivery(f.options).deliver(f.task), /sensitive/);
  assert.equal(f.creates, 0); assert.ok(!f.gitCalls.some(args => args[0] === 'add' || args[0] === 'push'));
});
