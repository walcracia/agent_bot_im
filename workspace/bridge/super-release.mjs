import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StateStore } from './state.mjs';
import { configuredGithubCommand } from './super-github.mjs';

const SHA = /^[a-f0-9]{40,64}$/i;
const TASK = /^[A-Za-z0-9_-]{1,80}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function relativePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\r\n\0:*?]/.test(value)
      || value.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '.git')) throw new Error('Release needs fixed relative paths.');
  return value;
}
const inside = (root, target) => { const path = relative(root, target); return path && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };
async function assetInfo(workspace, path) {
  const full = await realpath(join(workspace, path));
  if (!inside(workspace, full)) throw new Error('Release artifact escaped its dedicated checkout.');
  const info = await lstat(full);
  if (!info.isFile() || info.size < 1) throw new Error('Release artifact is missing or empty.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(full)) hash.update(chunk);
  return { path, name: basename(path), size: info.size, sha256: hash.digest('hex'), full };
}

export class ReleasePipeline {
  constructor(options) {
    this.options = options; this.command = configuredGithubCommand(options); this.queue = Promise.resolve();
    this.repository = options.repository;
    if (typeof this.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(this.repository)) throw new Error('Release repository must be fixed.');
    for (const key of ['repositoryPath', 'worktreesPath', 'statePath']) if (typeof options[key] !== 'string' || !isAbsolute(options[key])) throw new Error(`Release ${key} must be absolute.`);
    this.versionFile = relativePath(options.versionFile ?? 'workspace/package.json');
    this.artifacts = (options.artifacts ?? []).map(relativePath);
    if (new Set(this.artifacts.map(path => basename(path))).size !== this.artifacts.length || this.artifacts.some(path => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basename(path)))) throw new Error('Release artifact names must be unique safe file names.');
    this.buildCommands = options.buildCommands ?? [];
    if (!Array.isArray(this.buildCommands) || this.buildCommands.some(argv => !Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg)))) throw new Error('Release buildCommands must be trusted argv arrays.');
    if (options.publishRelease === true && (!this.artifacts.length || !this.buildCommands.length)) throw new Error('Published release requires build commands and fixed artifacts.');
    this.timeoutMs = options.buildTimeoutMs ?? 7200000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 86400000) throw new Error('Invalid release build timeout.');
    this.policy = fingerprint({ repository: this.repository, versionFile: this.versionFile, artifacts: this.artifacts, commands: this.buildCommands });
  }
  run(task) {
    if (this.options.publishRelease !== true) return Promise.resolve({ skipped: true, reason: 'Publishing is not enabled by trusted configuration.' });
    const next = this.queue.then(() => this.perform(task)); this.queue = next.catch(() => {}); return next;
  }
  async output(file, args, options = {}) {
    let result;
    try { result = await this.command(file, args, options); }
    catch (cause) {
      const error = new Error('Release command failed; inspect the local release environment.', { cause });
      if (cause.diagnosticPath) error.diagnosticPath = cause.diagnosticPath;
      throw error;
    }
    if (typeof result === 'string') return result;
    if (typeof result?.stdout !== 'string' || (result.exitCode !== undefined && result.exitCode !== 0)) throw new Error('Release command did not succeed.');
    return result.stdout;
  }
  async api(endpoint, pages = false) {
    let data;
    try { data = JSON.parse(await this.output('gh', ['api', '--method', 'GET', endpoint,
      ...(pages ? ['--paginate', '--slurp'] : []), '-H', 'Accept: application/vnd.github+json'])); }
    catch (cause) {
      const error = new Error('Release GitHub state could not be verified.', { cause });
      if (cause.diagnosticPath) error.diagnosticPath = cause.diagnosticPath;
      throw error;
    }
    if (pages) {
      if (!Array.isArray(data) || data.some(page => !Array.isArray(page))) throw new Error('Invalid release pagination.');
      return data.flat();
    }
    return data;
  }
  async perform(task) {
    if (!TASK.test(task?.id) || !Number.isSafeInteger(task.delivery?.number) || task.delivery.number < 1) throw new Error('Release needs a persisted task PR binding.');
    const store = new StateStore(this.options.statePath); await store.lock();
    try {
      const state = await store.read(`super-agent-release:${this.repository}`); state.releases ??= {};
      const pr = await this.api(`repos/${this.repository}/pulls/${task.delivery.number}`);
      if (pr?.number !== task.delivery.number || pr.merged !== true || !SHA.test(pr.merge_commit_sha)
          || pr.base?.repo?.full_name?.toLowerCase() !== this.repository.toLowerCase()) throw new Error('PR merge has not been confirmed in the configured repository.');
      const merge = pr.merge_commit_sha;
      let record = state.releases[task.id];
      if (record && (record.merge !== merge || record.number !== pr.number || record.policy !== this.policy)) throw new Error('Release task, merge or trusted policy changed; preserve its ledger.');
      if (record?.phase === 'complete') return record.result;
      if (record?.phase === 'building' || record?.phase === 'build-uncertain') {
        record.phase = 'build-uncertain'; await store.write(state);
        throw new Error('Previous build has uncertain side effects. Inspect its checkout and ledger; it will not be rebuilt automatically.');
      }
      const repository = await realpath(this.options.repositoryPath);
      await mkdir(this.options.worktreesPath, { recursive: true });
      const root = await realpath(this.options.worktreesPath), workspace = join(root, task.id);
      const git = (cwd, ...args) => this.output('git', ['-c', 'core.hooksPath=' + join(root, '.disabled-hooks'), '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { cwd });
      const remote = (await git(repository, 'remote', 'get-url', 'origin')).trim();
      const remoteMatch = new RegExp('^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)' + this.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\.git)?$', 'i');
      if (!remoteMatch.test(remote) || !remoteMatch.test((await git(repository, 'remote', 'get-url', '--push', 'origin')).trim())) throw new Error('Release repository remote does not match trusted GitHub configuration.');
      if (!record) {
        record = state.releases[task.id] = { taskId: task.id, number: pr.number, merge, policy: this.policy, workspace, phase: 'preparing', at: new Date().toISOString() };
        await store.write(state);
      }
      if (record.workspace !== workspace) throw new Error('Release checkout ownership changed.');
      let exists = true;
      try { await lstat(workspace); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (!exists) {
        if (record.phase !== 'preparing') throw new Error('Existing release checkout is missing; preserve the ledger instead of rebuilding.');
        try { await git(repository, 'cat-file', '-e', merge + '^{commit}'); }
        catch { await git(repository, 'fetch', 'origin', merge); }
        await git(repository, 'worktree', 'add', '--detach', workspace, merge);
      }
      if (await realpath(workspace) !== workspace || (await git(workspace, 'rev-parse', 'HEAD')).trim() !== merge
          || (await git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim() !== (await git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim()) throw new Error('Release checkout identity does not match its pinned merge.');
      const versionPath = await realpath(join(workspace, this.versionFile));
      if (!inside(workspace, versionPath)) throw new Error('Version file escaped the release checkout.');
      const version = JSON.parse(await readFile(versionPath, 'utf8')).version;
      if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error('Package version is not strict SemVer.');
      const tag = 'v' + version, marker = `<!-- team-relay-release:${this.repository}:${merge} -->`;
      if (record.tag && record.tag !== tag) throw new Error('Version changed after release preparation.');
      record.tag = tag;
      const remoteTag = async () => {
        const refs = (await git(repository, 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`)).trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
        if (!refs.length) return null;
        const target = refs.find(([, name]) => name.endsWith('^{}'))?.[0];
        if (target !== merge) throw new Error('Published tag conflicts with this merge or is not annotated; no tag will be moved.');
        return refs.find(([, name]) => name === 'refs/tags/' + tag)?.[0];
      };
      // Conflicts are found before expensive or potentially side-effectful builds.
      let publishedTag = await remoteTag();
      if (record.phase === 'preparing') {
        if ((await git(workspace, 'status', '--porcelain=v1', '--untracked-files=all')).trim()) throw new Error('New release checkout is dirty; inspect rather than reset it.');
        record.phase = 'building'; await store.write(state);
        try {
          for (const argv of this.buildCommands) await this.output(argv[0], argv.slice(1), { cwd: workspace, timeoutMs: this.timeoutMs });
          if ((await git(workspace, 'diff', '--no-ext-diff', '--name-only', 'HEAD', '--')).trim()) throw new Error('Build changed tracked release source.');
          record.artifacts = [];
          for (const path of this.artifacts) { const { full, ...asset } = await assetInfo(workspace, path); record.artifacts.push(asset); }
          record.phase = 'built'; await store.write(state);
        } catch (error) { record.phase = 'build-uncertain'; await store.write(state); throw error; }
      }
      for (const expected of record.artifacts ?? []) {
        const actual = await assetInfo(workspace, expected.path);
        if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error('Built release artifact changed after verification.');
      }
      if (!record.artifacts?.length) throw new Error('Release artifact evidence is missing.');
      if (!publishedTag) {
        if (record.effect?.kind === 'push-tag') throw new Error('Previous tag push remains unconfirmed; inspect remote before authorizing another attempt.');
        let localTag;
        try { localTag = (await git(repository, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`)).trim(); } catch { /* Not created yet. */ }
        if (localTag && localTag !== merge) throw new Error('Local tag points at another commit; it will not be moved.');
        if (!localTag) await git(repository, 'tag', '-a', tag, merge, '-m', `Task ${task.id} release ${tag}`);
        if ((await git(repository, 'cat-file', '-t', 'refs/tags/' + tag)).trim() !== 'tag') throw new Error('Release tag is not annotated.');
        record.effect = { kind: 'push-tag' }; await store.write(state);
        try { await git(repository, 'push', 'origin', 'refs/tags/' + tag); } catch { /* Prove remote state before deciding. */ }
        publishedTag = await remoteTag();
        if (!publishedTag) throw new Error('Tag push was not confirmed; publication paused.');
      }
      if (record.effect?.kind === 'push-tag') { delete record.effect; await store.write(state); }
      const findRelease = async () => {
        const all = await this.api(`repos/${this.repository}/releases?per_page=100`, true), matches = all.filter(item => item.tag_name === tag);
        if (matches.length > 1) throw new Error('More than one release uses the fixed tag.');
        const release = matches[0];
        if (release && (!Number.isSafeInteger(release.id) || !String(release.body ?? '').includes(marker))) throw new Error('Existing release is not owned by this pinned merge.');
        return release;
      };
      let release = await findRelease();
      if (!release) {
        if (record.effect?.kind === 'create-release') throw new Error('Previous release creation is unconfirmed; no automatic repeat.');
        const notes = join(root, `${task.id}-release-notes.md`);
        await writeFile(notes, [marker, '', `Task ${task.id}, merged PR #${pr.number}.`, `Pinned merge: ${merge}`, '',
          ...record.artifacts.map(item => `${item.name}: ${item.size} bytes, SHA256 ${item.sha256}`)].join('\n'), 'utf8');
        record.effect = { kind: 'create-release' }; await store.write(state);
        try { await this.output('gh', ['release', 'create', tag, '--repo', this.repository, '--verify-tag', '--draft', '--title', tag, '--notes-file', notes]); } catch { /* Query the stable release tag after a lost acknowledgement. */ }
        release = await findRelease();
        if (!release) throw new Error('Release creation was not confirmed; publication paused.');
      }
      if (record.effect?.kind === 'create-release') { delete record.effect; await store.write(state); }
      const assets = () => this.api(`repos/${this.repository}/releases/${release.id}/assets?per_page=100`, true);
      const verifyAsset = (items, expected) => {
        const matches = items.filter(item => item.name === expected.name);
        if (!matches.length) return false;
        if (matches.length !== 1 || matches[0].size !== expected.size || matches[0].digest !== 'sha256:' + expected.sha256 || matches[0].state !== 'uploaded') throw new Error('Existing release asset conflicts or cannot be verified; it will not be overwritten.');
        return true;
      };
      for (const expected of record.artifacts) {
        if (!verifyAsset(await assets(), expected)) {
          if (record.effect?.kind === 'upload' && record.effect.name === expected.name) throw new Error('Previous asset upload is unconfirmed; no automatic repeat.');
          record.effect = { kind: 'upload', name: expected.name }; await store.write(state);
          try { await this.output('gh', ['release', 'upload', tag, join(workspace, expected.path), '--repo', this.repository]); } catch { /* Never clobber; compare the server digest. */ }
          if (!verifyAsset(await assets(), expected)) throw new Error('Asset upload was not confirmed; publication paused.');
        }
        if (record.effect?.kind === 'upload' && record.effect.name === expected.name) { delete record.effect; await store.write(state); }
      }
      if (release.draft) {
        if (record.effect?.kind === 'publish') throw new Error('Release publication remains unconfirmed; no automatic repeat.');
        record.effect = { kind: 'publish' }; await store.write(state);
        try { await this.output('gh', ['release', 'edit', tag, '--repo', this.repository, '--draft=false']); } catch { /* Query rather than assume success. */ }
        release = await findRelease();
        if (!release || release.draft) throw new Error('Release publication was not confirmed; retain the draft and ledger.');
      }
      const result = { tag, version, merge, url: release.html_url, assets: record.artifacts, taskId: task.id };
      record.phase = 'complete'; record.result = result; delete record.effect; await store.write(state);
      return result;
    } finally { await store.unlock(); }
  }
}
