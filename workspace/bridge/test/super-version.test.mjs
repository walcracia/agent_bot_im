import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { stampVersion } from '../super-version.mjs';

const execute = promisify(execFile);
const jsonFiles = ['workspace/package.json', 'workspace/package-lock.json', 'workspace/bridge/package.json', 'workspace/bridge/package-lock.json'];
const pythonFiles = ['workspace/server/app.py'];
async function fixture(t, { base = '0.3.0', current = base } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-version-')), cwd = join(root, 'project');
  await mkdir(join(cwd, 'workspace/bridge'), { recursive: true }); await mkdir(join(cwd, 'workspace/server'), { recursive: true });
  const git = async args => (await execute('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim();
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Synthetic Version Test']); await git(['config', 'user.email', 'version@example.invalid']);
  for (const path of jsonFiles) {
    const value = { name: 'fixture', version: base, description: 'Keep this literal 0.3.0 and braces { unchanged }',
      ...(path.includes('lock') ? { lockfileVersion: 3, packages: { '': { name: 'fixture', version: base }, 'node_modules/dep': { version: '7.8.9' } } } : {}),
      dependencies: { dep: '7.8.9' } };
    await writeFile(join(cwd, path), JSON.stringify(value, null, 2) + '\n');
  }
  await writeFile(join(cwd, pythonFiles[0]), `# fixed version metadata\r\nVERSION = '${base}'  # keep comment\r\nOTHER = '0.3.0'\r\n`);
  await git(['add', '--', ...jsonFiles, ...pythonFiles]); await git(['commit', '-m', 'base version fixture']);
  if (current !== base) {
    const primary = JSON.parse(await readFile(join(cwd, jsonFiles[0]), 'utf8')); primary.version = current;
    await writeFile(join(cwd, jsonFiles[0]), JSON.stringify(primary, null, 2) + '\n');
  }
  const options = { cwd, baseRef: await git(['rev-parse', 'HEAD']), versionFile: jsonFiles[0], jsonVersionFiles: jsonFiles, pythonVersionFiles: pythonFiles };
  t.after(async () => { const absolute = await realpath(root); assert.ok(absolute.startsWith(tmpdir() + sep)); await rm(absolute, { recursive: true, force: true }); });
  const snapshot = async () => Promise.all([...jsonFiles, ...pythonFiles].map(path => readFile(join(cwd, path), 'utf8')));
  return { root, cwd, git, options, snapshot };
}

for (const [base, current, expected] of [['0.3.0', '0.3.0', '0.3.1'], ['0.3.1', '0.3.0', '0.3.2'], ['0.3.1', '0.3.1', '0.3.2'], ['0.3.0', '0.4.0', '0.4.0'], ['0.3.0', '0.4.0-rc.1', '0.4.0-rc.1'], ['0.3.1-rc.1', '0.3.1-rc.1', '0.3.1']]) {
  test(`stamp ${base} base and ${current} worktree as ${expected} without changing unrelated bytes`, async t => {
    const f = await fixture(t, { base, current }), before = await f.snapshot();
    const result = await stampVersion(f.options); assert.equal(result.version, expected);
    const after = await f.snapshot();
    for (let index = 0; index < jsonFiles.length; index++) {
      const parsed = JSON.parse(after[index]); assert.equal(parsed.version, expected); assert.equal(parsed.dependencies.dep, '7.8.9');
      if (parsed.packages) { assert.equal(parsed.packages[''].version, expected); assert.equal(parsed.packages['node_modules/dep'].version, '7.8.9'); }
      const old = JSON.parse(before[index]);
      const expectedText = before[index].replace('"version": "' + old.version + '"', '"version": "' + expected + '"')
        .replace('"version": "' + old.version + '"', '"version": "' + expected + '"');
      assert.equal(after[index], expectedText);
    }
    assert.equal(after[4], before[4].replace(`VERSION = '${base}'`, `VERSION = '${expected}'`));
    assert.deepEqual(result.files, [...jsonFiles, ...pythonFiles].filter((path, index) => before[index] !== after[index]));
    assert.equal(await f.git(['rev-parse', 'HEAD']), f.options.baseRef, 'Stamping must not commit.');
  });
}

test('minified JSON and all-in-sync explicit higher versions preserve formatting and return only changed files', async t => {
  const f = await fixture(t, { current: '0.4.0' });
  for (const path of jsonFiles) {
    const value = JSON.parse(await readFile(join(f.cwd, path), 'utf8')); value.version = '0.4.0'; if (value.packages) value.packages[''].version = '0.4.0';
    await writeFile(join(f.cwd, path), JSON.stringify(value));
  }
  await writeFile(join(f.cwd, pythonFiles[0]), 'VERSION="0.4.0"\n');
  const before = await f.snapshot(), result = await stampVersion(f.options);
  assert.equal(result.version, '0.4.0'); assert.deepEqual(result.files, []); assert.deepEqual(await f.snapshot(), before);
});

test('missing fields or duplicated Python VERSION reject the complete plan before any file changes', async t => {
  const f = await fixture(t);
  const manifest = join(f.cwd, jsonFiles[2]);
  await writeFile(manifest, '{"name":"missing-version"}');
  let before = await f.snapshot(); await assert.rejects(stampVersion(f.options), /Version|version/); assert.deepEqual(await f.snapshot(), before);
  await writeFile(manifest, '{"version":"0.3.0"}');
  await writeFile(join(f.cwd, pythonFiles[0]), 'VERSION = "0.3.0"\nVERSION = "0.3.1"\n');
  before = await f.snapshot(); await assert.rejects(stampVersion(f.options), /exactly one/); assert.deepEqual(await f.snapshot(), before);
  assert.ok(!(await readdir(f.cwd, { recursive: true })).some(path => path.includes('.version-')));
});

test('malformed lockfile root, duplicate JSON keys and invalid SemVer cannot be silently repaired', async t => {
  const f = await fixture(t), target = join(f.cwd, jsonFiles[1]);
  for (const content of ['{"version":"0.3.0","packages":{}}', '{"version":"0.3.0","version":"0.3.0"}', '{"version":"0.03.0"}', '{"version":"0.3.0-rc.01"}', '{"version":"0.3.0+build"}']) {
    await writeFile(target, content); const before = await f.snapshot();
    await assert.rejects(stampVersion(f.options)); assert.deepEqual(await f.snapshot(), before);
  }
});

test('trusted Git base object controls the next patch even when the checkout differs', async t => {
  const f = await fixture(t), original = f.options.baseRef;
  const target = join(f.cwd, jsonFiles[0]);
  const changed = JSON.parse(await readFile(target, 'utf8')); changed.version = '0.3.1'; await writeFile(target, JSON.stringify(changed));
  await f.git(['add', jsonFiles[0]]); await f.git(['commit', '-m', 'new merged version']);
  const latest = await f.git(['rev-parse', 'HEAD']);
  changed.version = '0.3.0'; await writeFile(target, JSON.stringify(changed));
  assert.notEqual(latest, original);
  assert.equal((await stampVersion({ ...f.options, baseRef: latest })).version, '0.3.2');
});

test('malicious, duplicate and symbolic-link paths cannot escape or partially stamp the project', async t => {
  const f = await fixture(t), before = await f.snapshot();
  for (const path of ['../outside.json', '/outside.json', 'C:\\outside.json', '.git/config', 'workspace/../package.json']) {
    await assert.rejects(stampVersion({ ...f.options, jsonVersionFiles: [...jsonFiles, path] })); assert.deepEqual(await f.snapshot(), before);
  }
  await assert.rejects(stampVersion({ ...f.options, jsonVersionFiles: [...jsonFiles, jsonFiles[0]] }), /more than once/);
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'package.json'), '{"version":"0.3.0"}');
  await symlink(outside, join(f.cwd, 'workspace', 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stampVersion({ ...f.options, jsonVersionFiles: [...jsonFiles, 'workspace/escaped/package.json'] }), /symbolic links/);
  await link(join(outside, 'package.json'), join(f.cwd, 'workspace', 'linked.json'));
  await assert.rejects(stampVersion({ ...f.options, jsonVersionFiles: [...jsonFiles, 'workspace/linked.json'] }), /independent regular file/);
  assert.deepEqual(await f.snapshot(), before); assert.equal(await readFile(join(outside, 'package.json'), 'utf8'), '{"version":"0.3.0"}');
});
