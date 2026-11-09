import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ManagedRuntime } from '../managed-runtime.mjs';

const options = { concurrency: false, timeout: 5000 };
const fault = code => Object.assign(new Error(`Synthetic ${code} during status publication.`), { code });
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay managed runtime '));
  const path = join(directory, 'runtime.json');
  const runtime = new ManagedRuntime(path, randomUUID(), join(directory, 'config.json'));
  await runtime.start(() => {});
  t.after(async () => {
    clearInterval(runtime.timer);
    await runtime.checking?.catch(() => {});
    const target = resolve(directory);
    const remainder = relative(resolve(tmpdir()), target);
    assert.ok(remainder && !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`));
    assert.ok(basename(target).startsWith('relay managed runtime '));
    await rm(target, { recursive: true, force: true });
  });
  return { directory, path, runtime };
}

async function withRenameFault(replacement, action) {
  const original = fs.promises.rename;
  try {
    fs.promises.rename = (...args) => replacement(original, ...args);
    syncBuiltinESMExports();
    return await action();
  } finally {
    fs.promises.rename = original;
    syncBuiltinESMExports();
  }
}

test('managed publication retries transient rename denial while preserving the complete old owner record', options, async t => {
  const { directory, path, runtime } = await fixture(t);
  const before = await json(path);
  const attempts = [];
  const started = performance.now();
  await withRenameFault(async (rename, from, to) => {
    assert.equal(to, path);
    assert.deepEqual(await json(path), before, 'An incomplete or premature status replaced the old record.');
    const pending = await json(from);
    assert.equal(pending.instanceId, before.instanceId);
    assert.equal(pending.pid, before.pid);
    assert.equal(pending.status, 'listening');
    attempts.push(performance.now());
    if (attempts.length <= 2) throw fault('EPERM');
    return rename(from, to);
  }, () => runtime.publish('listening', { taskStatus: 'ready' }));
  assert.equal(attempts.length, 3);
  assert.ok(attempts[2] - started >= 60, 'Transient retries should yield with bounded backoff.');
  const after = await json(path);
  assert.equal(after.instanceId, before.instanceId);
  assert.equal(after.pid, before.pid);
  assert.equal(after.status, 'listening');
  assert.equal(after.taskStatus, 'ready');
  assert.deepEqual(await readdir(directory), ['runtime.json']);
});

test('a permanent publish error rejects that call without poisoning subsequent publications', options, async t => {
  const { directory, path, runtime } = await fixture(t);
  const before = await json(path);
  let attempts = 0;
  await withRenameFault(async (rename, from, to) => {
    attempts++;
    if (attempts === 1) throw fault('EIO');
    return rename(from, to);
  }, async () => {
    await assert.rejects(runtime.publish('listening', { taskStatus: 'ready' }), { code: 'EIO' });
    assert.deepEqual(await json(path), before);
    await runtime.publish('listening', { taskStatus: 'paused' });
  });
  assert.equal(attempts, 2, 'EIO should not be retried, and the next publication must run.');
  const after = await json(path);
  assert.equal(after.instanceId, before.instanceId);
  assert.equal(after.pid, before.pid);
  assert.equal(after.status, 'listening');
  assert.equal(after.taskStatus, 'paused');
  assert.deepEqual(await readdir(directory), ['runtime.json']);
});

test('a changed owner after a transient denial prevents retry from overwriting another instance', options, async t => {
  const { directory, path, runtime } = await fixture(t);
  const foreign = { ...await json(path), instanceId: randomUUID(), status: 'listening', marker: 'foreign-owned' };
  let attempts = 0;
  await withRenameFault(async (_rename, _from, to) => {
    attempts++;
    assert.equal(to, path);
    await writeFile(path, JSON.stringify(foreign), { flush: true });
    throw fault('EPERM');
  }, () => assert.rejects(runtime.publish('listening', { taskStatus: 'ready' }), /ownership changed/));
  assert.equal(attempts, 1, 'Ownership must be checked before another rename is attempted.');
  assert.deepEqual(await json(path), foreign);
  assert.deepEqual(await readdir(directory), ['runtime.json']);
});

test('persistent transient denial exhausts a finite retry budget and leaves the original record intact', options, async t => {
  const { directory, path, runtime } = await fixture(t);
  const before = await json(path);
  let attempts = 0;
  await withRenameFault(async () => {
    attempts++;
    throw fault('EPERM');
  }, () => assert.rejects(runtime.publish('listening'), { code: 'EPERM' }));
  assert.equal(attempts, 7, 'One initial attempt and six bounded retry delays are expected.');
  assert.deepEqual(await json(path), before);
  assert.deepEqual(await readdir(directory), ['runtime.json']);
});
