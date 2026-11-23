import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkerRegistry } from './worker-registry.mjs';
import { BusinessRouter } from './business-router.mjs';
import { InstalledHeadlessExecutor } from './installed-headless.mjs';
import { triageModelEnvironment } from './triage-model.mjs';
import { DshExecutor } from './dsh-executor.mjs';
import { HermesExecutor } from './hermes-executor.mjs';
import { PiExecutor } from './pi-executor.mjs';
import { dshModelPatch, dshModelSelection } from './dsh-model-selection.mjs';

const POLICY = fileURLToPath(new URL('./business-route-policy.mjs', import.meta.url));
const FACTORIES = { dsh: DshExecutor, hermes: HermesExecutor, pi: PiExecutor };

export async function createBusinessRuntime(options, harness) {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const executors = new Map(), agents = [];
  for (const config of options.agents) {
    const present = await lstat(config.command).then(info => info.isFile()).catch(() => false);
    const available = config.available !== false && present;
    const { id, label, description, capabilities } = config;
    agents.push({ id, label, description, capabilities, available });
    if (available) executors.set(id, new FACTORIES[config.backend]({ ...config, harness, runsPath: join(options.root, 'runs', id) }));
  }
  const registry = new WorkerRegistry({ workers: options.workers, agents });
  const patchPath = join(options.root, 'router.patch.yml');
  const selection = dshModelSelection(options.routerModel ?? harness?.modelSelection);
  const model = dshModelPatch(selection);
  await writeFile(patchPath, model + '- insert:\n    - id: teamplay-business-router-readonly\n      name: ' + JSON.stringify(pathToFileURL(POLICY).href) + '\n', { mode: 0o600 });
  const classifier = new InstalledHeadlessExecutor({ ...harness, cwd: options.root, runsPath: join(options.root, 'router-runs'),
    sessionMapPath: join(options.root, 'router-sessions.json'), env: triageModelEnvironment(harness?.env),
    permissionMode: 'read-only', runTimeoutMs: 0, classificationTimeoutMs: 0, extraPatches: [patchPath] });
  const router = new BusinessRouter({ registry, classify: prompt => classifier.classify(prompt) });
  return { options, registry, executors, router,
    async close() { await Promise.allSettled([classifier.close(), ...[...executors.values()].map(executor => executor.close())]); } };
}
