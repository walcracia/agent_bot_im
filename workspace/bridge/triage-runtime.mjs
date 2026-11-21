import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QaMcpClient, QaAdapter } from './qa-mcp.mjs';
import { QaSource } from './qa-source.mjs';
import { LogTriageWorker } from './log-triage-worker.mjs';
import { triageModelEnvironment } from './triage-model.mjs';
import { DshSkillRunner } from './dsh-skill-runner.mjs';
import { SkillExecutionService } from './skill-execution.mjs';

/** The only autonomous source transport; credentials never reach the report process. */
export async function createTriageRuntime(options, harness) {
  const env = triageModelEnvironment();
  for (const name of options.mcp.envNames) if (process.env[name]) env[name] = process.env[name];
  if (options.mcp.envFile) {
    const contents = JSON.parse(await readFile(options.mcp.envFile, 'utf8'));
    if (!contents || Array.isArray(contents) || typeof contents !== 'object'
      || Object.entries(contents).some(([key, value]) => !/^QA_[A-Z0-9_]+$/u.test(key) || typeof value !== 'string'))
      throw new Error('QA envFile must contain only QA_ string values.');
    Object.assign(env, contents);
  }
  const client = new QaMcpClient({ ...options.mcp, env });
  const adapter = new QaAdapter({ client, ...options.sourceLimits });
  const { executionLimits: _legacyLimits, ...reportHarness } = harness ?? {};
  const runner = new DshSkillRunner({ harness: { ...reportHarness, modelSelection: options.modelSelection }, root: join(options.root, 'agent-runs'), timeoutMs: 0 });
  const executionService = new SkillExecutionService({ backend: options.backend ?? 'dsh', runner, root: options.root });
  const worker = new LogTriageWorker({ adapter, root: join(options.root, 'attempts'), skillRoot: options.skillRoot,
    python: options.python, downloadOrigins: options.allowedDownloadOrigins, limits: { runTimeoutMs: 0 }, executionService });
  const sourceStop = new AbortController();
  return {
    adapter, worker,
    sourceFactory: settings => {
      const source = new QaSource(settings);
      return { poll: checkpoint => source.poll(checkpoint, { signal: sourceStop.signal, timeoutMs: options.scanTimeoutMs ?? 180000 }) };
    },
    stopSources() { sourceStop.abort(); },
    async close() { sourceStop.abort(); try { await runner.close(); } finally { await client.close(); } },
  };
}
