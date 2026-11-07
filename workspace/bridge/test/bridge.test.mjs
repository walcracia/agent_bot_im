import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, link, symlink, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Bridge, selected, replyParts, attachmentInput } from '../core.mjs';
import { StateStore } from '../state.mjs';

const human = { id: 'u1', username: 'alice', is_bot: false };
const event = { id: 8, conversation_id: 'c1', sender: human, text: '@dsh 请检查', attachment: null };
const config = { botUsername: 'dsh', conversationIds: ['c1'], senderIds: ['u1'], harness: { cwd: tmpdir() } };

test('explicit mention/direct, sender+conversation allowlists, and bot-loop exclusion', () => {
  const yes = selected(event, { is_direct: false }, config, 'b1');
  assert.equal(yes, true);
  for (const text of ['@dsh-other', '@dshx', '@dsh测试', 'abc@dsh'])
    assert.equal(selected({ ...event, text }, { is_direct: false }, config, 'b1'), false);
  assert.equal(selected({ ...event, text: '你好' }, { is_direct: true }, config, 'b1'), true);
  assert.equal(selected(event, { is_direct: true }, { ...config, senderIds: [] }, 'b1'), false);
  assert.equal(selected(event, { is_direct: true }, { ...config, conversationIds: [] }, 'b1'), false);
  assert.equal(selected({ ...event, sender: { ...human, is_bot: true } }, { is_direct: true }, config, 'b1'), false);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(join(directory, 'state.json'));
  const state = await store.read('test-bot');
  let runs = 0, failReply = true;
  const replies = new Map();
  const api = { request: async path => path === '/api/conversations' ? [{ id: 'c1', is_direct: false }] : { events: state.cursor ? [] : [event] },
    reply: async (input, text, suffix) => {
      replies.set(`${input.id}-${suffix}`, text);
      if (failReply) { failReply = false; throw new Error('remote received; response lost'); }
    },
  };
  // Deterministic fake for reliability tests only; never presented as real Harness execution.
  const executor = { start: async () => {}, session: async () => ({ run: async () => {
    runs++; return { finalResponse: '测试执行器结果', finishReason: 'completed' };
  } }) };
  const bridge = new Bridge({ config, api, store, state, executor, bot: { id: 'b1' } });
  return { bridge, state, store, executor, replies, runs: () => runs };
}

test('lost reply response resends saved result with same id, does not rerun task, advances cursor only on acknowledgement', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.poll(), /response lost/);
  assert.equal(f.state.cursor, 0); assert.equal(f.state.current.phase, 'reply'); assert.equal(f.runs(), 1);
  const recovered = await f.store.read('test-bot');
  f.bridge.state = recovered;
  await f.bridge.poll();
  assert.equal(recovered.cursor, 8); assert.equal(recovered.current, null);
  assert.equal(f.runs(), 1); assert.equal(f.replies.size, 1);
});

test('interrupted model execution requires explicit retry or skip', async t => {
  const f = await fixture(t);
  f.executor.session = async () => ({ run: async () => { throw new Error('transport lost'); } });
  await assert.rejects(f.bridge.poll(), /no automatic rerun/);
  assert.equal(f.state.current.phase, 'uncertain'); assert.equal(f.state.cursor, 0);
  await assert.rejects(f.bridge.resolveCurrent(), /may already have executed/);
  await f.bridge.resolveCurrent(undefined, '8');
  assert.equal(f.state.cursor, 8); assert.equal(f.state.current, null);
});

test('pre-model startup failure is safe to retry, config changes can revoke queued work', async t => {
  const f = await fixture(t);
  f.executor.start = async () => { throw new Error('bad model configuration'); };
  await assert.rejects(f.bridge.poll(), /bad model/);
  assert.equal(f.state.current.phase, 'pending');
  f.bridge.config = { ...config, senderIds: [] };
  await f.bridge.poll(); assert.equal(f.state.cursor, 8); assert.equal(f.runs(), 0);
});

test('state identity mismatch and live lock prevent sharing a cursor', async t => {
  const f = await fixture(t); await f.store.write(f.state);
  await assert.rejects(f.store.read('other-bot'), /another server/);
  await f.store.lock();
  const other = new StateStore(f.store.path);
  await assert.rejects(other.lock(), /Another bridge/); await f.store.unlock();
});

test('concurrent fresh lock contenders produce exactly one owner', async t => {
  const f = await fixture(t);
  const contenders = Array.from({ length: 12 }, () => new StateStore(f.store.path));
  const results = await Promise.allSettled(contenders.map(store => store.lock()));
  const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : []);
  assert.equal(winners.length, 1);
  assert.ok(results.every(result => result.status === 'fulfilled' || /never removed automatically/.test(result.reason.message)));
  const before = await readFile(f.store.lockPath, 'utf8');
  for (let i = 0; i < contenders.length; i++) if (i !== winners[0]) await contenders[i].unlock();
  assert.equal(await readFile(f.store.lockPath, 'utf8'), before);
  await contenders[winners[0]].unlock();
});

test('concurrent stale-lock contenders all fail without deleting or replacing the lock', async t => {
  const f = await fixture(t);
  const stale = JSON.stringify({ pid: 2147483647 });
  await writeFile(f.store.lockPath, stale);
  const contenders = Array.from({ length: 12 }, () => new StateStore(f.store.path));
  const results = await Promise.allSettled(contenders.map(store => store.lock()));
  assert.ok(results.every(result => result.status === 'rejected' && /never removed automatically/.test(result.reason.message)));
  for (const contender of contenders) await contender.unlock();
  assert.equal(await readFile(f.store.lockPath, 'utf8'), stale);
});

test('reply splitting preserves Unicode and server text bound', () => {
  const text = '测😀'.repeat(10000); const parts = replyParts(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every(part => Array.from(part).length <= 9000));
});

test('real HTTP attachment stream checks size/hash and refuses off-origin tickets', async t => {
  const data = Buffer.from('private attachment');
  const server = createServer((_, response) => response.end(data));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = await mkdtemp(join(tmpdir(), 'relay-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = { baseUrl: origin, request: async () => ({ url: '/media' }) };
  const withFile = { ...event, attachment: { id: 'f1', size: data.length, name: '../cannot-escape.txt',
    sha256: createHash('sha256').update(data).digest('hex'), kind: 'file', mime: 'application/octet-stream' } };
  const result = await attachmentInput(api, withFile, directory);
  assert.equal(await readFile(result.metadata.local_path, 'utf8'), data.toString());
  assert.equal(dirname(dirname(result.metadata.local_path)), await realpath(directory));
  assert.ok(basename(dirname(result.metadata.local_path)).startsWith('.team-relay-incoming-'));
  assert.equal(basename(result.metadata.local_path), 'f1');
  const existingDirectories = await readdir(directory);
  await assert.rejects(attachmentInput(api, { ...withFile, attachment: { ...withFile.attachment, size: 1 } }, directory), /exceeds/);
  assert.deepEqual(await readdir(directory), existingDirectories);
  api.request = async () => ({ url: 'https://example.com/private' });
  await assert.rejects(attachmentInput(api, withFile, directory), /outside/);
});

test('pre-existing hardlinked .part cannot overwrite a file outside executor cwd', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-hardlink-cwd-'));
  const outside = await mkdtemp(join(tmpdir(), 'relay-hardlink-outside-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const victim = join(outside, 'important.txt');
  await writeFile(victim, 'preserve-outside-file');
  const legacyFolder = join(directory, 'incoming', String(event.id));
  await mkdir(legacyFolder, { recursive: true });
  const legacyPart = join(legacyFolder, 'f1.part'); await link(victim, legacyPart);
  const data = Buffer.from('attachment');
  const server = createServer((_, response) => response.end(data));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = { baseUrl: `http://127.0.0.1:${server.address().port}`, request: async () => ({ url: '/file' }) };
  const input = { ...event, attachment: { id: 'f1', name: 'data.txt', size: data.length, kind: 'file',
    mime: 'text/plain', sha256: createHash('sha256').update(data).digest('hex') } };
  const result = await attachmentInput(api, input, directory);
  assert.equal(await readFile(victim, 'utf8'), 'preserve-outside-file');
  assert.equal(await readFile(legacyPart, 'utf8'), 'preserve-outside-file');
  assert.equal(await readFile(result.metadata.local_path, 'utf8'), 'attachment');
  assert.notEqual(dirname(result.metadata.local_path), legacyFolder);
});

test('pre-existing incoming directory symlink/junction is not followed for attachment writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-symlink-cwd-'));
  const outside = await mkdtemp(join(tmpdir(), 'relay-symlink-outside-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(directory, 'incoming'), 'junction');
  const legacyFolder = join(outside, String(event.id)); await mkdir(legacyFolder);
  const victim = join(legacyFolder, 'f1.part'); await writeFile(victim, 'preserve-link-target');
  const data = Buffer.from('attachment');
  const server = createServer((_, response) => response.end(data));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = { baseUrl: `http://127.0.0.1:${server.address().port}`, request: async () => ({ url: '/file' }) };
  const input = { ...event, attachment: { id: 'f1', name: 'data.txt', size: data.length, kind: 'file',
    mime: 'text/plain', sha256: createHash('sha256').update(data).digest('hex') } };
  const result = await attachmentInput(api, input, directory);
  assert.equal(await readFile(victim, 'utf8'), 'preserve-link-target');
  assert.deepEqual(await readdir(outside), [String(event.id)]);
  assert.equal(dirname(dirname(result.metadata.local_path)), await realpath(directory));
  assert.equal(await readFile(result.metadata.local_path, 'utf8'), 'attachment');
});
