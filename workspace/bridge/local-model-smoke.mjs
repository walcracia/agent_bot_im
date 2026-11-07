// Explicit opt-in real, local model test. Never part of the default test suite.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { OfficialExecutor } from './harness.mjs';
const root = fileURLToPath(new URL('../../environment/tools/dsh/', import.meta.url));
const cwd = `${root}local-model-tasks`, dshHome = `${root}local-model-home`;
await mkdir(cwd, { recursive: true }); await mkdir(dshHome, { recursive: true });
const allowedEnvironment = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'ELECTRON_RUN_AS_NODE'];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.some(name => name.toLowerCase() === key.toLowerCase())));
const options = { profile: 'sdk-minimal', dshHome, cwd, provider: 'local-ollama', model: 'qwen2.5:3b', maxTokens: 64,
  initializeTimeoutMs: 30000, patches: [fileURLToPath(new URL('local-ollama.patch.yml', import.meta.url))], env };
const executor = new OfficialExecutor(options);
const started = performance.now();
let timer;
try {
  await executor.start();
  const session = await executor.session(`local-model-${randomUUID()}`, false);
  const result = await Promise.race([
    session.run([{ type: 'text', text: 'Reply exactly LOCAL_DSH_OK. Do not call tools.' }]),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local model smoke exceeded 120 seconds; stopping.')), 120000); }),
  ]);
  if (result.finishReason !== 'completed' || result.finalResponse.trim() !== 'LOCAL_DSH_OK')
    throw new Error(`Unexpected local model result: ${JSON.stringify({ finishReason: result.finishReason, text: result.finalResponse })}`);
  const report = { status: 'passed', provider: options.provider, model: options.model, text: result.finalResponse,
    finishReason: result.finishReason, milliseconds: Math.round(performance.now() - started),
    realHarness: true, realModel: true, paidApiRequests: 0, toolsEnabled: false };
  await writeFile(`${root}local-model-result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { clearTimeout(timer); await executor.close(); }
