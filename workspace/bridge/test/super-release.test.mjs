import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleasePipeline } from '../super-release.mjs';

const exec = promisify(execFile), repository = 'owner/project';
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'team-relay-release-test-')), repo = join(root, 'repository'), bare = join(root, 'remote.git');
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '--bare', bare], { windowsHide: true });
  await exec('git', ['init', '--initial-branch=main', repo], { windowsHide: true });
  const git = args => exec('git', ['-C', repo, ...args], { windowsHide: true });
  await git(['config', 'user.name', 'Synthetic Release']); await git(['config', 'user.email', 'synthetic@example.invalid']);
  await mkdir(join(repo, 'workspace')); await writeFile(join(repo, 'workspace/package.json'), JSON.stringify({ version: extra.version ?? '0.3.1' }));
  await writeFile(join(repo, '.gitignore'), 'outputs/\n');
  await git(['add', '--', '.gitignore', 'workspace/package.json']); await git(['commit', '-m', 'synthetic merged source']);
  await git(['remote', 'add', 'origin', bare]); await git(['push', 'origin', 'main']);
  const merge = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const f = { root, repo, bare, merge, git, builds: 0, creates: 0, uploads: 0, publishes: 0, assets: [], release: null, ...extra };
  const build = 'const fs=require("node:fs");fs.mkdirSync("outputs",{recursive:true});fs.writeFileSync("outputs/application.zip","synthetic portable package");';
  f.options = { repository, repositoryPath: repo, worktreesPath: join(root, 'releases'), statePath: join(root, 'ledger/state.json'),
    versionFile: 'workspace/package.json', publishRelease: true, buildCommands: [[process.execPath, '-e', build]], artifacts: ['outputs/application.zip'] };
  f.command = async (file, args, options = {}) => {
    if (file === 'git') {
      const actual = args.slice(args.indexOf('-C') + 2);
      if (actual[0] === 'remote' && actual[1] === 'get-url') return { stdout: `https://github.com/${repository}.git\n` };
      const result = await exec(file, args, { cwd: options.cwd, windowsHide: true });
      if (actual[0] === 'push' && f.loseTagPush) { f.loseTagPush = false; throw new Error('lost tag push acknowledgement'); }
      return result;
    }
    if (file !== 'gh') {
      f.builds++;
      const result = await exec(file, args, { cwd: options.cwd, windowsHide: true });
      if (f.failBuild) throw new Error('build wrote files then failed');
      return result;
    }
    if (args[0] === 'api') {
      const endpoint = args.find(value => value.startsWith('repos/'));
      if (endpoint.endsWith('/pulls/7')) return { stdout: JSON.stringify({ number: 7, merged: !f.unmerged, merge_commit_sha: f.merge,
        base: { repo: { full_name: repository } } }) };
      if (endpoint.includes('/releases?')) return { stdout: JSON.stringify([f.release ? [f.release] : []]) };
      if (endpoint.includes('/releases/101/assets?')) return { stdout: JSON.stringify([f.assets]) };
      throw new Error('Unexpected release endpoint ' + endpoint);
    }
    if (args[0] === 'release' && args[1] === 'create') {
      f.creates++; assert.ok(args.includes('--draft')); assert.ok(args.includes('--verify-tag'));
      f.release = { id: 101, tag_name: args[2], draft: true, html_url: `https://github.com/${repository}/releases/tag/${args[2]}`,
        body: await readFile(args[args.indexOf('--notes-file') + 1], 'utf8') };
      if (f.assetConflict) f.assets.push({ name: 'application.zip', size: 1, digest: 'sha256:wrong', state: 'uploaded' });
      if (f.loseCreate) { f.loseCreate = false; throw new Error('lost create acknowledgement'); }
      return { stdout: f.release.html_url };
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      f.uploads++; assert.ok(!args.includes('--clobber'));
      if (f.noUploadEffect) throw new Error('unknown network failure');
      const content = await readFile(args[3]);
      f.assets.push({ name: 'application.zip', size: content.length, digest: 'sha256:' + createHash('sha256').update(content).digest('hex'), state: 'uploaded' });
      if (f.loseUpload) { f.loseUpload = false; throw new Error('lost upload acknowledgement'); }
      return { stdout: '' };
    }
    if (args[0] === 'release' && args[1] === 'edit') {
      f.publishes++; assert.ok(args.includes('--draft=false')); f.release.draft = false;
      if (f.losePublish) { f.losePublish = false; throw new Error('lost publish acknowledgement'); }
      return { stdout: '' };
    }
    throw new Error('Unexpected release operation');
  };
  f.options.command = f.command; f.pipeline = new ReleasePipeline(f.options);
  f.task = { id: 'T000001', delivery: { number: 7 }, branch: 'codex/super/T000001' };
  return f;
}

test('merged task builds pinned source in a separate checkout and publishes verified artifacts once', async t => {
  const f = await fixture(t), result = await f.pipeline.run(f.task);
  assert.equal(result.tag, 'v0.3.1'); assert.equal(result.merge, f.merge); assert.equal(f.builds, 1);
  assert.equal(f.creates, 1); assert.equal(f.uploads, 1); assert.equal(f.publishes, 1); assert.equal(f.release.draft, false);
  assert.equal(result.assets[0].sha256, f.assets[0].digest.slice(7));
  assert.equal((await f.git(['branch', '--show-current'])).stdout.trim(), 'main');
  assert.equal((await f.git(['status', '--porcelain'])).stdout, '');
  assert.equal((await f.git(['cat-file', '-t', 'refs/tags/v0.3.1'])).stdout.trim(), 'tag');
  assert.deepEqual(await f.pipeline.run(f.task), result); assert.equal(f.builds, 1); assert.equal(f.uploads, 1);
});

test('lost tag/create/upload/publish acknowledgements are proved remotely, without duplicate builds or assets', async t => {
  const f = await fixture(t, { loseTagPush: true, loseCreate: true, loseUpload: true, losePublish: true });
  const result = await f.pipeline.run(f.task);
  assert.equal(result.tag, 'v0.3.1'); assert.equal(f.builds, 1); assert.equal(f.creates, 1); assert.equal(f.uploads, 1);
  assert.equal(f.assets.length, 1); assert.equal(f.publishes, 1);
});

test('unmerged task and invalid SemVer cannot start a build', async t => {
  const f = await fixture(t, { unmerged: true });
  await assert.rejects(f.pipeline.run(f.task), /merge has not been confirmed/); assert.equal(f.builds, 0);
  const other = await fixture(t, { version: '0.3' });
  await assert.rejects(other.pipeline.run(other.task), /SemVer/); assert.equal(other.builds, 0);
});

test('uncertain build is never automatically run again, even after the next invocation uses a fresh pipeline', async t => {
  const f = await fixture(t, { failBuild: true });
  await assert.rejects(f.pipeline.run(f.task), /command failed/); assert.equal(f.builds, 1);
  f.failBuild = false;
  await assert.rejects(new ReleasePipeline(f.options).run(f.task), /uncertain side effects/);
  assert.equal(f.builds, 1); assert.equal(f.creates, 0);
});

test('unknown upload outcome pauses and does not upload again until the server proves that prior effect', async t => {
  const f = await fixture(t, { noUploadEffect: true });
  await assert.rejects(f.pipeline.run(f.task), /upload was not confirmed/);
  f.noUploadEffect = false;
  await assert.rejects(new ReleasePipeline(f.options).run(f.task), /upload is unconfirmed/);
  assert.equal(f.builds, 1); assert.equal(f.uploads, 1); assert.equal(f.publishes, 0); assert.equal(f.release.draft, true);
});

test('existing tag at another commit is rejected before building, and existing different assets are never clobbered', async t => {
  const f = await fixture(t);
  await f.git(['commit', '--allow-empty', '-m', 'different release commit']);
  await f.git(['tag', '-a', 'v0.3.1', '-m', 'different existing tag']); await f.git(['push', 'origin', 'refs/tags/v0.3.1']);
  await assert.rejects(f.pipeline.run(f.task), /Published tag conflicts/); assert.equal(f.builds, 0);
  const other = await fixture(t, { assetConflict: true });
  await assert.rejects(other.pipeline.run(other.task), /asset conflicts/);
  assert.equal(other.uploads, 0); assert.equal(other.publishes, 0);
});

test('trusted policy must enable publication and fixed artifact paths cannot escape or alias a remote asset name', async t => {
  const f = await fixture(t);
  const disabled = new ReleasePipeline({ ...f.options, publishRelease: false });
  assert.equal((await disabled.run(f.task)).skipped, true); assert.equal(f.builds, 0);
  assert.throws(() => new ReleasePipeline({ ...f.options, artifacts: ['../secret.zip'] }), /relative paths/);
  assert.throws(() => new ReleasePipeline({ ...f.options, artifacts: ['outputs/a.zip', 'other/a.zip'] }), /unique/);
});
