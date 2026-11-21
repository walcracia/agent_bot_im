const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
};
function fields(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid trusted ${label} fields.`);
}
function text(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /\0/u.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid registry ID.'); return value; }
function list(value, predicate, label) {
  if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string' || !predicate(item))
    || new Set(value).size !== value.length) throw new Error(`Invalid ${label}.`);
  return [...value];
}
const ids = value => list(value, item => ID.test(item), 'registered Agent list');
const capabilities = value => list(value, item => CAPABILITY.test(item), 'capability list');

/** Deployment-owned descriptions, never executable configuration from a model. */
export class WorkerRegistry {
  constructor(options = {}) {
    fields(options, ['workers', 'agents'], 'registry');
    const { workers = [], agents = [] } = options;
    if (!Array.isArray(workers) || !Array.isArray(agents) || workers.length > 100 || agents.length > 100) throw new Error('Invalid trusted registry.');
    this.workers = new Map(); this.agents = new Map();
    for (const item of agents) {
      fields(item, ['id', 'label', 'description', 'capabilities', 'available'], 'Agent');
      const entry = { id: id(item.id), label: text(item.label, 120, 'Agent label'), description: text(item.description, 3000, 'Agent description'),
        capabilities: capabilities(item.capabilities), available: item.available };
      if (typeof entry.available !== 'boolean' || this.agents.has(entry.id)) throw new Error('Duplicate or invalid registered Agent.');
      this.agents.set(entry.id, freeze(entry));
    }
    for (const item of workers) {
      fields(item, ['id', 'label', 'description', 'requiredCapabilities', 'allowedAgents', 'skills', 'mcp'], 'Worker');
      const entry = { id: id(item.id), label: text(item.label, 120, 'Worker label'), description: text(item.description, 3000, 'Worker description'),
        requiredCapabilities: capabilities(item.requiredCapabilities ?? []), allowedAgents: ids(item.allowedAgents),
        skills: capabilities(item.skills ?? []), mcp: capabilities(item.mcp ?? []) };
      if (this.workers.has(entry.id) || entry.allowedAgents.some(agentId => !this.agents.has(agentId))) throw new Error('Duplicate Worker or unknown allowed Agent.');
      this.workers.set(entry.id, freeze(entry));
    }
  }
  availableAgents(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error('Worker is not registered.');
    return worker.allowedAgents.filter(agentId => {
      const agent = this.agents.get(agentId);
      return agent.available && worker.requiredCapabilities.every(capability => agent.capabilities.includes(capability));
    });
  }
  resolve(workerId, agentId) {
    if (!this.availableAgents(workerId).includes(agentId)) throw new Error('Agent is unavailable or outside the Worker capability allowlist.');
    return structuredClone({ worker: this.workers.get(workerId), agent: this.agents.get(agentId) });
  }
  snapshot() {
    return { workers: [...this.workers.values()].map(worker => ({ ...structuredClone(worker), availableAgents: this.availableAgents(worker.id) })),
      agents: structuredClone([...this.agents.values()]) };
  }
}
