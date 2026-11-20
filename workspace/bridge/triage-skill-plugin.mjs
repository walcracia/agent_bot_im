import { writeFile } from 'node:fs/promises';
import { replaceOwnedFile } from './file-replace.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeExecutionLimits, executionLimitSummary } from './triage-limits.mjs';

export const name = 'teamplay-triage-skill-policy';
export const inject = ['tools', 'llm'];
export const SKILL_TOOL_NAMES = Object.freeze(['load_skill', 'list_inputs', 'read_evidence', 'run_parser'].map(name => 'mcp__triage__' + name));

/** Capabilities are fixed by the adapter, never by skill text, inputs or model output. */
export function apply(ctx, config) {
  const limits = normalizeExecutionLimits(config.executionLimits);
  const allowed = new Set(SKILL_TOOL_NAMES);
  let requests = 0;
  const inputs = [];
  if (typeof ctx.tools.guard !== 'function') throw new Error('This DSH has no final tool guard.');
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'This skill can use only its task log tools.');
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function') throw new Error('This DSH has no scoped tool restriction.');
    // Headless agent creation and asynchronous stdio startup can overlap.
    // Hold the first turn until all four trusted tools have registered.
    const deadline = Date.now() + 15000;
    while (!SKILL_TOOL_NAMES.every(name => ctx.tools.definitions().some(tool => tool.name === name))) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('Task log tools did not become ready.');
      await delay(50, undefined, { signal });
    }
    agent.ctx.tools.restrict({ allow: SKILL_TOOL_NAMES });
  });
  ctx.on('agent/request', async (_position, next) => ({ ...await next(), maxTokens: limits.maxTokens }));
  ctx.on('llm/stream', async function* (options, next) {
    if (!Array.isArray(options.tools) || options.tools.length !== 4
      || new Set(options.tools.map(tool => tool.name)).size !== 4 || options.tools.some(tool => !allowed.has(tool.name))
      || !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > limits.maxTokens || requests >= limits.modelRequests)
      throw new Error('Skill execution request exceeds its tool or model budget.');
    const characters = JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools }).length;
    if (characters > limits.inputCharacters) throw new Error('Skill execution input budget exceeded.');
    requests++; inputs.push(characters);
    const temporary = config.receiptPath + '.tmp';
    await writeFile(temporary, JSON.stringify({ requests, tools: SKILL_TOOL_NAMES, guard: true, inputCharacters: inputs,
      limits: executionLimitSummary(limits) }), { mode: 0o600, flush: true });
    await replaceOwnedFile(temporary, config.receiptPath);
    yield* next();
  });
}
