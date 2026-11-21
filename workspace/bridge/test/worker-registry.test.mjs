import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../worker-registry.mjs';

const config = () => ({
  agents: [
    { id: 'dsh', label: 'DSH', description: 'Installed native sessions', capabilities: ['native-session', 'ota-plugin'], available: true },
    { id: 'hermes', label: 'Hermes', description: 'Installed data tools', capabilities: ['data', 'mcp'], available: false },
    { id: 'pi', label: 'Pi', description: 'Installed text and data executor', capabilities: ['data'], available: true },
  ],
  workers: [
    { id: 'logs', label: '日志分析', description: 'Use the original OTA plugin', requiredCapabilities: ['ota-plugin'], allowedAgents: ['dsh', 'pi'], skills: ['ota-log-triage@1.3.2'] },
    { id: 'data', label: '数据整理', description: 'Summarize supplied business data', requiredCapabilities: ['data'], allowedAgents: ['hermes', 'pi'], mcp: ['qa-server'] },
  ],
});

test('only registered ready executors with a Worker capability match are selectable', () => {
  const registry = new WorkerRegistry(config());
  assert.deepEqual(registry.availableAgents('logs'), ['dsh']);
  assert.deepEqual(registry.availableAgents('data'), ['pi']);
  assert.equal(registry.resolve('logs', 'dsh').worker.id, 'logs');
  assert.throws(() => registry.resolve('logs', 'pi')); // Registered and ready, but cannot run the OTA plugin.
  assert.throws(() => registry.resolve('data', 'hermes')); // Registered capability, but currently unavailable.
  assert.throws(() => registry.resolve('data', 'dsh')); // Outside this Worker's allowed Agents.
  assert.throws(() => registry.resolve('invented', 'pi'));
});

test('caller mutations of supplied config or returned snapshots cannot change trusted registry entries', () => {
  const source = config(), registry = new WorkerRegistry(source);
  source.agents[1].available = true; source.workers[0].allowedAgents.push('hermes');
  const snapshot = registry.snapshot(); snapshot.agents[0].capabilities.length = 0;
  snapshot.workers[0].availableAgents.push('pi'); snapshot.workers[1].allowedAgents.push('dsh');
  const selected = registry.resolve('data', 'pi'); selected.agent.capabilities.push('ota-plugin');
  assert.deepEqual(registry.availableAgents('logs'), ['dsh']); assert.deepEqual(registry.availableAgents('data'), ['pi']);
  assert.equal(registry.snapshot().agents.find(agent => agent.id === 'hermes').available, false);
});

test('registry rejects executable policy fields, unknown references and duplicate identities', () => {
  for (const mutate of [
    value => value.command = 'arbitrary command',
    value => value.workers[0].command = 'arbitrary command', value => value.agents[0].permissionMode = 'danger-full-access',
    value => value.workers[0].allowedAgents.push('unknown'), value => value.agents.push(value.agents[0]),
    value => value.workers.push(value.workers[0]), value => value.agents[0].available = 'yes',
  ]) { const value = config(); mutate(value); assert.throws(() => new WorkerRegistry(value)); }
  assert.deepEqual(new WorkerRegistry().snapshot(), { workers: [], agents: [] });
});
