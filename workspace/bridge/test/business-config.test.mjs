import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { normalizeBusinessConfig } from '../business-config.mjs';
import { createBusinessRuntime } from '../business-runtime.mjs';

test('disabled business routing leaves the existing deployment untouched', () => {
  assert.equal(normalizeBusinessConfig(undefined, resolve('.')), null);
  assert.equal(normalizeBusinessConfig({ enabled: false }, resolve('.')), null);
});

test('registered model choices cannot introduce commands and executable paths stay in trusted deployment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-business-config-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const command = join(root, 'synthetic-pi.exe'); await writeFile(command, 'fixture, never execute');
  const raw = { enabled: true, root: './business', agents: [{ id: 'pi', backend: 'pi', command, dataHome: root,
    provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high',
    label: '资料助理', description: 'Read supplied material', available: true, capabilities: ['files'] }],
    workers: [{ id: 'material', label: '整理资料', description: 'Organize provided files', allowedAgents: ['pi'], requiredCapabilities: ['files'] }] };
  const options = normalizeBusinessConfig(raw, root);
  assert.equal(options.root, join(root, 'business')); assert.equal(options.maxWorkers, 2);
  const runtime = await createBusinessRuntime(options, {});
  try {
    assert.equal(runtime.executors.size, 1);
    const patch = await readFile(join(options.root, 'router.patch.yml'), 'utf8');
    assert.match(patch, /reasoningEffort: "high"/u); assert.doesNotMatch(patch, /maxTokens/u);
    const snapshot = runtime.registry.snapshot(); assert.deepEqual(snapshot.workers[0].availableAgents, ['pi']);
    assert.equal(JSON.stringify(snapshot).includes(command), false);
    assert.equal(JSON.stringify(snapshot).includes('dataHome'), false);
  } finally { await runtime.close(); }
  const missing = await createBusinessRuntime({ ...options, agents: [{ ...options.agents[0], command: join(root, 'missing.exe') }] }, {});
  try { assert.equal(missing.executors.size, 0); assert.deepEqual(missing.registry.snapshot().workers[0].availableAgents, []); }
  finally { await missing.close(); }
  assert.throws(() => normalizeBusinessConfig({ ...raw, agents: [{ ...raw.agents[0], backend: 'shell' }] }, root));
});
