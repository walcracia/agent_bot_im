import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, unlink, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { publishTriageArtifact } from '../triage-attachments.mjs';
import { ImApi } from '../core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const content = Buffer.from('{"conclusion":"合成初排报告，无真实日志或模型。"}');
function ledger(item) {
  let data = { outbox: { [item.key]: structuredClone(item) } }, writes = Promise.resolve();
  return { read: () => data, transaction(change) {
    const job = writes.then(async () => { const next = structuredClone(data); const result = await change(next); data = next; return result; });
    writes = job.catch(() => {}); return job;
  } };
}
async function makeArtifact(directory) {
  const root = join(directory, 'reports'); await mkdir(root, { recursive: true });
  const file = join(root, 'report.json'); await writeFile(file, content);
  const item = { key: 'triage-artifact-T000001-r1-json', kind: 'log-triage', category: 'artifact', clientId: 'triage-T000001-r1-json',
    artifact: { name: 'report.json', mime: 'application/json', size: content.length, sha256: hash(content), pathPrivate: file },
    event: { conversation_id: 'chat-demo', id: 'triage' }, text: '日志初排报告', taskId: 'T000001', reportRevision: 1 };
  return { root, item };
}
async function temporary() { return mkdtemp(join(tmpdir(), 'teamplay-artifact-')); }
async function cleanup(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('teamplay-artifact-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function httpFixture(t, { loseUpload = false, mismatch = false } = {}) {
  const directory = await temporary(), artifact = await makeArtifact(directory), state = ledger(artifact.item);
  const stats = { uploads: 0, messages: 0, conversations: 0 }, sent = new Map(); let allowed = true;
  const server = createServer(async (req, res) => {
    if (req.url === '/api/conversations') { stats.conversations++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ id: 'chat-demo', allowed }])); return; }
    if (req.url.endsWith('/attachments')) {
      for await (const _chunk of req) { /* Consume the real multipart request without storing credentials/body. */ }
      stats.uploads++;
      if (loseUpload) { req.socket.destroy(); return; }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'attachment-' + stats.uploads, name: 'report.json', size: content.length, sha256: mismatch ? '0'.repeat(64) : hash(content) })); return;
    }
    if (req.url.endsWith('/messages')) {
      let value = ''; for await (const chunk of req) value += chunk;
      const message = JSON.parse(value), previous = sent.get(message.client_id);
      if (previous && (previous.text !== message.text || previous.attachment_id !== message.attachment_id)) { res.writeHead(409); res.end(); return; }
      if (!previous) { sent.set(message.client_id, { ...message, id: ++stats.messages }); }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(sent.get(message.client_id))); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await cleanup(directory); });
  const api = new ImApi(`http://127.0.0.1:${server.address().port}`, 'synthetic-artifact-test-token');
  const beforeSend = (_item, conversations) => conversations.find(c => c.id === 'chat-demo')?.allowed ? 'send' : 'pause';
  const args = { api, ...artifact, transaction: state.transaction, beforeSend };
  return { args, state, api, stats, sent, directory, allow: value => { allowed = value; } };
}

test('multipart upload metadata is persisted and retry reuses attachment plus stable message clientId', async t => {
  const f = await httpFixture(t);
  const first = await publishTriageArtifact(f.args); assert.equal(first.attachmentId, 'attachment-1');
  const stored = f.state.read().outbox[f.args.item.key];
  assert.equal(stored.attachmentId, 'attachment-1'); assert.equal(stored.uploadAttempts, 1);
  assert.deepEqual(stored.attachmentMetadata, { id: 'attachment-1', name: 'report.json', size: content.length, sha256: hash(content) });
  await publishTriageArtifact(f.args);
  assert.equal(f.stats.uploads, 1); assert.equal(f.stats.messages, 1); assert.equal(f.sent.size, 1);
  assert.ok(f.stats.conversations >= 4);
});

test('fresh authorization/revision gate after upload pauses sending while preserving uploaded metadata', async t => {
  const f = await httpFixture(t); let checks = 0;
  f.args.beforeSend = () => ++checks === 1 ? 'send' : 'drop';
  const result = await publishTriageArtifact(f.args); assert.equal(result.paused, true); assert.equal(result.verdict, 'drop');
  assert.equal(f.stats.uploads, 1); assert.equal(f.stats.messages, 0);
  assert.equal(f.state.read().outbox[f.args.item.key].attachmentId, 'attachment-1');
  f.args.beforeSend = () => 'send'; await publishTriageArtifact(f.args); assert.equal(f.stats.uploads, 1); assert.equal(f.stats.messages, 1);
});

test('upload acknowledgement loss has at most three attempts and no analysis/model re-execution', async t => {
  const f = await httpFixture(t, { loseUpload: true });
  for (let i = 0; i < 3; i++) await assert.rejects(publishTriageArtifact(f.args), error => !error.message.includes(f.directory) && !error.message.includes(f.api.token));
  const stopped = await publishTriageArtifact(f.args);
  assert.equal(stopped.paused, true); assert.equal(stopped.verdict, 'upload-limit');
  assert.equal(f.stats.uploads, 3); assert.equal(f.stats.messages, 0); assert.equal(f.state.read().outbox[f.args.item.key].uploadAttempts, 3);
});

test('wrong upload hashes and persisted attachment IDs without matching original metadata cannot publish', async t => {
  const wrong = await httpFixture(t, { mismatch: true });
  assert.equal((await publishTriageArtifact(wrong.args)).paused, true); assert.equal(wrong.stats.messages, 0);
  const f = await httpFixture(t);
  await f.state.transaction(data => { data.outbox[f.args.item.key].attachmentId = 'invented-by-untrusted-input'; });
  assert.equal((await publishTriageArtifact(f.args)).paused, true); assert.equal(f.stats.uploads, 0); assert.equal(f.stats.messages, 0);
});

test('report allowlist, real bytes, root bounds, parent links and hardlinks are enforced without path/token disclosure', async t => {
  const f = await httpFixture(t);
  const original = structuredClone(f.args.item), expectPause = async item => {
    const state = ledger(item), result = await publishTriageArtifact({ ...f.args, item, transaction: state.transaction });
    assert.equal(result.paused, true); assert.ok(!JSON.stringify(result).includes(f.directory) && !JSON.stringify(result).includes(f.api.token));
  };
  for (const changes of [{ name: 'raw.log' }, { size: 256 * 1024 + 1 }, { mime: 'text/html' }, { sha256: '1'.repeat(64) },
    { pathPrivate: join(f.directory, 'report.json') }]) await expectPause({ ...original, artifact: { ...original.artifact, ...changes } });
  const hardlink = join(f.args.root, 'hardlink.json'); await link(original.artifact.pathPrivate, hardlink);
  await expectPause(original); await unlink(hardlink);
  const alias = join(f.args.root, 'alias'); await symlink(f.args.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expectPause({ ...original, artifact: { ...original.artifact, pathPrivate: join(alias, 'report.json') } });
  assert.equal(f.stats.uploads, 0); assert.equal(f.stats.messages, 0);
});

test('HTTP 409 remains a fixed safe conflict for the shared Outbox pause policy', async t => {
  const f = await httpFixture(t);
  await f.api.request('/api/conversations/chat-demo/messages', { text: 'other content', client_id: f.args.item.clientId });
  await assert.rejects(publishTriageArtifact(f.args), error => error.status === 409 && /HTTP 409/.test(error.message)
    && !error.message.includes(f.directory) && !error.message.includes(f.api.token));
  assert.equal(f.stats.uploads, 1); assert.equal(f.stats.messages, 1);
});

test('REAL isolated FastAPI multipart/file hash + lost message ACK recovers to one message/clientId, zero model calls', async t => {
  const directory = await temporary(), artifact = await makeArtifact(directory), state = ledger(artifact.item);
  const python = process.env.IM_TEST_PYTHON ?? join(ROOT, 'environment/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const password = randomBytes(24).toString('hex');
  const child = spawn(python, ['-c', [
    'import os,socket,json,uvicorn', 'from server.db import Store',
    's=Store(); s.create_user("admin","Synthetic Admin",os.environ["IM_TEST_PASSWORD"],is_admin=True); s.conn.close()',
    'sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM); sock.bind(("127.0.0.1",0)); sock.listen(128)',
    'print(json.dumps({"port":sock.getsockname()[1]}),flush=True)',
    'uvicorn.Server(uvicorn.Config("server.app:app",log_level="error")).run(sockets=[sock])'
  ].join('\n')], { cwd: join(ROOT, 'workspace'), env: { ...process.env, IM_DATA_DIR: join(directory, 'data'), IM_TEST_PASSWORD: password },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; await cleanup(directory); });
  let startup = '', diagnostic = ''; child.stdout.on('data', chunk => { startup += chunk.toString(); }); child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1500); });
  let port;
  for (let i = 0; i < 100; i++) {
    const found = /"port":\s*(\d+)/.exec(startup); if (found) { port = Number(found[1]); break; }
    if (child.exitCode !== null) throw new Error('Isolated fixture exited before startup'); await delay(50);
  }
  assert.ok(port, 'Isolated fixture did not bind');
  const baseUrl = `http://127.0.0.1:${port}`; let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(baseUrl + '/api/health')).ok; } catch {} if (ready) break; await delay(50); }
  assert.ok(ready, 'Isolated fixture did not become healthy');
  const login = await new ImApi(baseUrl, '').request('/api/login', { username: 'admin', password });
  const admin = new ImApi(baseUrl, login.token);
  const bot = await admin.request('/api/admin/users', { username: 'triage', display_name: 'Synthetic Analyst', password, is_bot: true });
  const token = await admin.request(`/api/admin/users/${bot.id}/token`, {});
  const conversation = await admin.request('/api/conversations', { title: 'Synthetic report artifacts', member_ids: [bot.id], is_direct: false });
  artifact.item.event.conversation_id = conversation.id;
  const durable = ledger(artifact.item), api = new ImApi(baseUrl, token.token), request = api.request.bind(api); let lost = false;
  api.request = async (path, body) => {
    const response = await request(path, body);
    if (body && path.endsWith('/messages') && !lost) { lost = true; throw new Error('Synthetic dropped message acknowledgement'); }
    return response;
  };
  const args = { api, ...artifact, transaction: durable.transaction,
    beforeSend: (_item, conversations) => conversations.some(c => c.id === conversation.id && c.members.some(m => m.id === bot.id)) ? 'send' : 'pause' };
  await assert.rejects(publishTriageArtifact(args));
  assert.ok(durable.read().outbox[artifact.item.key].attachmentId);
  await publishTriageArtifact(args);
  const messages = await admin.request(`/api/conversations/${conversation.id}/messages`);
  assert.equal(messages.length, 1); assert.equal(messages[0].client_id, artifact.item.clientId); assert.equal(messages[0].attachment.sha256, hash(content));
  assert.equal(durable.read().outbox[artifact.item.key].uploadAttempts, 1);
  const textBytes = Buffer.from('合成初排结果，仍需人工验证。');
  const textPath = join(artifact.root, '报告.txt'); await writeFile(textPath, textBytes);
  const textItem = { ...artifact.item, key: 'triage-artifact-T000001-r1-text', clientId: 'triage-T000001-r1-text',
    artifact: { pathPrivate: textPath, name: '报告.txt', mime: 'text/plain', size: textBytes.length, sha256: hash(textBytes) } };
  const textLedger = ledger(textItem);
  await publishTriageArtifact({ ...args, item: textItem, transaction: textLedger.transaction });
  await publishTriageArtifact({ ...args, item: textItem, transaction: textLedger.transaction });
  const both = await admin.request(`/api/conversations/${conversation.id}/messages`);
  assert.equal(both.length, 2); assert.equal(both.filter(message => message.client_id === textItem.clientId).length, 1);
  assert.equal(both.find(message => message.client_id === textItem.clientId).attachment.name, '报告.txt');
  assert.equal(both.find(message => message.client_id === textItem.clientId).attachment.sha256, hash(textBytes));
  assert.equal(state.read().outbox[artifact.item.key].attachmentId, undefined); // Separate untouched ledger cannot inject an ID.
});
