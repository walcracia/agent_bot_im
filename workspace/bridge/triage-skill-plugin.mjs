import { writeFile } from 'node:fs/promises';
import { replaceOwnedFile } from './file-replace.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export const name = 'teamplay-triage-skill-policy';
export const inject = ['tools', 'llm'];
export const SKILL_TOOL_NAMES = Object.freeze(['load_skill', 'list_inputs', 'read_evidence', 'run_parser'].map(name => 'mcp__triage__' + name));

/** Capabilities are fixed by the adapter, never by skill text, inputs or model output. */
export function apply(ctx, config) {
  const allowed = new Set(SKILL_TOOL_NAMES);
  let requests = 0, saveQueue = Promise.resolve();
  const inputs = [], tokens = {}, started = Date.now();
  const save = () => {
    const snapshot = JSON.stringify({ version: 2, requests, tools: SKILL_TOOL_NAMES, guard: true, inputCharacters: [...inputs],
      usage: { elapsedMs: Date.now() - started, providerRequests: requests, ...(Object.keys(tokens).length ? { tokens: { ...tokens } } : {}) } });
    saveQueue = saveQueue.then(async () => {
      const temporary = config.receiptPath + '.tmp';
      await writeFile(temporary, snapshot, { mode: 0o600, flush: true });
      await replaceOwnedFile(temporary, config.receiptPath);
    });
    return saveQueue;
  };
  if (typeof ctx.tools.guard !== 'function') throw new Error('This DSH has no final tool guard.');
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'This skill can use only its task log tools.');
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function') throw new Error('This DSH has no scoped tool restriction.');
    // Headless agent creation and asynchronous stdio startup can overlap.
    // Hold the first turn until all four trusted tools have registered.
    while (!SKILL_TOOL_NAMES.every(name => ctx.tools.definitions().some(tool => tool.name === name))) {
      signal?.throwIfAborted();
      await delay(50, undefined, { signal });
    }
    agent.ctx.tools.restrict({ allow: SKILL_TOOL_NAMES });
  });
  ctx.on('llm/stream', async function* (options, next) {
    if (!Array.isArray(options.tools) || options.tools.length !== 4
      || new Set(options.tools.map(tool => tool.name)).size !== 4 || options.tools.some(tool => !allowed.has(tool.name)))
      throw new Error('Skill execution can use only its task log tools.');
    const characters = JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools }).length;
    requests++; inputs.push(characters);
    await save();
    const observed = {};
    try {
      for await (const chunk of next()) {
        const usage = chunk?.usage;
        for (const [canonical, aliases] of Object.entries({ inputTokens: ['inputTokens', 'promptTokens', 'prompt_tokens', 'input_tokens'],
          outputTokens: ['outputTokens', 'completionTokens', 'completion_tokens', 'output_tokens'], totalTokens: ['totalTokens', 'total_tokens'],
          reasoningTokens: ['reasoningTokens', 'reasoning_tokens'] })) {
          for (const key of aliases) if (Number.isSafeInteger(usage?.[key]) && usage[key] >= 0) { observed[canonical] = usage[key]; break; }
        }
        yield chunk;
      }
    } finally {
      for (const [key, value] of Object.entries(observed)) tokens[key] = (tokens[key] ?? 0) + value;
      await save();
    }
  });
}
