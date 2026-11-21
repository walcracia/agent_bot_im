import { isAbsolute, resolve } from 'node:path';
import { WorkerRegistry } from './worker-registry.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const path = (base, value) => {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new Error('Business paths require trusted configuration.');
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
};

/** Resource paths and executable choices come from deployment, never the Router. */
export function normalizeBusinessConfig(raw, base) {
  if (!raw?.enabled) return null;
  if (!record(raw) || !Array.isArray(raw.agents) || !raw.agents.length || !Array.isArray(raw.workers) || !raw.workers.length)
    throw new Error('Business routing needs registered Workers and Agents.');
  const root = path(base, raw.root);
  const maxWorkers = raw.maxWorkers ?? 2;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) throw new Error('Invalid business concurrency.');
  const agents = raw.agents.map(agent => {
    if (!record(agent) || !['dsh', 'hermes', 'pi'].includes(agent.backend)) throw new Error('Unsupported trusted business backend.');
    return { ...agent, command: path(base, agent.command), ...(agent.dataHome ? { dataHome: path(base, agent.dataHome) } : {}) };
  });
  new WorkerRegistry({ workers: raw.workers, agents: agents.map(({ id, label, description, capabilities, available = true }) => ({ id, label, description, capabilities, available })) });
  return { ...raw, root, maxWorkers, agents };
}
