// Explicit opt-in: real temporary IM server -> real SDK -> existing local Ollama -> real IM reply.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Bridge, ImApi } from './core.mjs';
import { StateStore } from './state.mjs';
import { OfficialExecutor } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'relay-real-local-model-'));
const workspace = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../environment/tools/dsh/', import.meta.url));
const python = fileURLToPath(new URL('../../environment/venv/Scripts/python.exe', import.meta.url));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const password = randomBytes(20).toString('hex');
const allowedEnvironment = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'ELECTRON_RUN_AS_NODE'];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.some(name => name.toLowerCase() === key.toLowerCase())));
const child = spawn(python, ['-c', [
  'import os,uvicorn', 'from server.db import Store',
  's=Store(); s.create_user("admin","Local model test",os.environ["IM_TEST_PASSWORD"],is_admin=True); s.conn.close()',
  `uvicorn.run("server.app:app",host="127.0.0.1",port=${port},log_level="error")`,
].join('\n')], { cwd: workspace, env: { ...env, IM_DATA_DIR: join(directory, 'data'), IM_TEST_PASSWORD: password },
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const exited = once(child, 'exit'); let diagnostic = '';
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
const options = { profile: 'sdk-minimal', dshHome: `${root}local-model-home`, cwd: `${root}local-model-tasks`,
  provider: 'local-ollama', model: 'qwen2.5:3b', maxTokens: 64, initializeTimeoutMs: 30000,
  patches: [fileURLToPath(new URL('local-ollama.patch.yml', import.meta.url))], env };
await mkdir(options.cwd, { recursive: true }); await mkdir(options.dshHome, { recursive: true });
const executor = new OfficialExecutor(options), store = new StateStore(join(directory, 'state.json'));
const started = performance.now(); let timer;
try {
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${baseUrl}/api/health`)).ok; if (ready) break; } catch {}
    if (child.exitCode !== null) throw new Error(`Isolated IM server exited: ${diagnostic}`);
    await delay(100);
  }
  if (!ready) throw new Error('Isolated IM server did not start.');
  const login = await new ImApi(baseUrl, '').request('/api/login', { username: 'admin', password });
  const sender = new ImApi(baseUrl, login.token);
  const bot = await sender.request('/api/admin/users', { username: 'dsh', display_name: 'DSH local smoke', password, is_bot: true });
  const token = await sender.request(`/api/admin/users/${bot.id}/token`, {});
  const conversation = await sender.request('/api/conversations', { title: 'Real local model smoke', member_ids: [bot.id], is_direct: false });
  const input = await sender.request(`/api/conversations/${conversation.id}/messages`, {
    text: '@dsh 这是本地模型测试。只回复 LOCAL_IM_DSH_OK，不调用任何工具。', client_id: 'real-local-model-smoke' });
  const api = new ImApi(baseUrl, token.token);
  await store.lock(); const state = await store.read(`${baseUrl}|${bot.id}`);
  const config = { botUsername: 'dsh', conversationIds: [conversation.id], senderIds: [login.user.id], harness: options };
  const bridge = new Bridge({ config, api, state, store, executor, bot });
  const processed = await Promise.race([
    bridge.poll(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Real IM/local-model flow exceeded 120 seconds; stopping.')), 120000); }),
  ]);
  const history = await sender.request(`/api/conversations/${conversation.id}/messages`);
  const replies = history.filter(message => message.sender.id === bot.id);
  const transportPassed = processed === 1 && replies.length === 1 && state.cursor === input.id && state.current === null;
  const exactMatchPassed = replies.length === 1 && replies[0].text.trim() === 'LOCAL_IM_DSH_OK';
  const report = { status: transportPassed && exactMatchPassed ? 'passed' : 'failed', transportPassed, exactMatchPassed,
    flow: 'real-IM-to-real-Harness-to-real-local-model-to-IM', provider: options.provider,
    model: options.model, request: input.text, response: replies.map(message => message.text), milliseconds: Math.round(performance.now() - started),
    processedEvents: processed, botReplies: replies.length, cursorAcknowledged: true, realModel: true,
    paidApiRequests: 0, toolsEnabled: false, dataIsolation: 'temporary-server-directory', touchedMainUiData: false };
  await writeFile(`${root}local-model-im-result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!transportPassed || !exactMatchPassed) throw new Error('Real IM/local-model acceptance failed; inspect the recorded transport and exact-match outcomes. No automatic retry.');
} finally {
  clearTimeout(timer); await executor.close(); await store.unlock();
  if (child.exitCode === null) child.kill(); await exited;
  await rm(directory, { recursive: true, force: true });
}
