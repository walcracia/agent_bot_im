import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Bridge, ImApi } from '../core.mjs';
import { StateStore } from '../state.mjs';

// Genuine HTTP + SQLite server, deliberately fake model executor. No paid model is called.
test('real FastAPI/SQLite event → bridge → attachment → idempotent reply after lost HTTP acknowledgement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-bridge-http-'));
  const workspace = fileURLToPath(new URL('../../', import.meta.url));
  const python = process.env.IM_TEST_PYTHON ?? fileURLToPath(new URL('../../../environment/venv/Scripts/python.exe', import.meta.url));
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const password = randomBytes(20).toString('hex');
  const child = spawn(python, ['-c', [
    'import os,uvicorn', 'from server.db import Store',
    's=Store(); s.create_user("admin","Admin",os.environ["IM_TEST_PASSWORD"],is_admin=True); s.conn.close()',
    `uvicorn.run("server.app:app",host="127.0.0.1",port=${port},log_level="error")`,
  ].join('\n')], { cwd: workspace, env: { ...process.env, IM_DATA_DIR: join(directory, 'data'), IM_TEST_PASSWORD: password },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const closed = once(child, 'close');
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await closed;
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('relay-bridge-http-')) throw new Error('Unexpected fixture cleanup target.');
    // Windows can release SQLite/WAL mappings just after process/stdio close.
    // Retry only cleanup of this exact isolated fixture; never repeat the test.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${baseUrl}/api/health`)).ok; if (ready) break; } catch {}
    if (child.exitCode !== null) throw new Error(`Server exited: ${diagnostic}`);
    await delay(100);
  }
  assert.ok(ready, `Server did not start: ${diagnostic}`);
  const anonymous = new ImApi(baseUrl, '');
  const adminLogin = await anonymous.request('/api/login', { username: 'admin', password });
  const admin = new ImApi(baseUrl, adminLogin.token);
  const bot = await admin.request('/api/admin/users', { username: 'dsh', display_name: 'DSH', password, is_bot: true });
  const human = await admin.request('/api/admin/users', { username: 'alice', display_name: 'Alice', password, is_bot: false });
  const botToken = await admin.request(`/api/admin/users/${bot.id}/token`, {});
  const humanLogin = await anonymous.request('/api/login', { username: 'alice', password });
  const sender = new ImApi(baseUrl, humanLogin.token);
  const conversation = await sender.request('/api/conversations', { title: 'Bridge HTTP integration', member_ids: [bot.id], is_direct: false });
  const body = new FormData(); body.set('file', new Blob(['input-for-dsh'], { type: 'text/plain' }), 'task.txt');
  const uploaded = await fetch(`${baseUrl}/api/conversations/${conversation.id}/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${humanLogin.token}` }, body,
  });
  assert.ok(uploaded.ok); const attachment = await uploaded.json();
  const event = await sender.request(`/api/conversations/${conversation.id}/messages`, { text: '@dsh 请处理附件',
    attachment_id: attachment.id, client_id: 'http-integration-input' });
  const api = new ImApi(baseUrl, botToken.token);
  let runs = 0;
  const executor = { start: async () => {}, session: async () => ({ run: async blocks => {
    runs++;
    assert.ok(blocks[0].text.includes('local_path'));
    return { finishReason: 'completed', finalResponse: 'TEST_EXECUTOR_ONLY: attachment handled' };
  } }) };
  const statePath = join(directory, 'bridge.json'), store = new StateStore(statePath);
  const identity = `${baseUrl}|${bot.id}`, state = await store.read(identity);
  const config = { botUsername: 'dsh', conversationIds: [conversation.id], senderIds: [human.id], harness: { cwd: directory } };
  const realReply = api.reply.bind(api); let first = true;
  api.reply = async (...args) => {
    const value = await realReply(...args);
    if (first) { first = false; throw new Error('simulated lost HTTP response after commit'); }
    return value;
  };
  const bridge = new Bridge({ api, store, state, config, executor, bot });
  await assert.rejects(bridge.poll(), /lost HTTP response/);
  assert.equal(state.cursor, 0); assert.equal(state.current.phase, 'reply');
  bridge.state = await store.read(identity);
  await bridge.poll();
  assert.equal(bridge.state.cursor, event.id); assert.equal(runs, 1);
  const messages = await sender.request(`/api/conversations/${conversation.id}/messages`);
  assert.equal(messages.filter(item => item.sender.is_bot).length, 1);
  assert.equal(messages.find(item => item.sender.is_bot).client_id, `dsh-${event.id}-0`);
  const events = await api.request(`/api/agent/events?after=${event.id}`);
  assert.equal(events.events.length, 0);
});
