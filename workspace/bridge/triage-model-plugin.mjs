import { writeFile } from 'node:fs/promises';

export const name = 'teamplay-triage-report-only';
export const inject = ['tools', 'llm'];

/** This plugin is only mounted in a fresh, owned headless report process. */
export function apply(ctx, config) {
  let requests = 0;
  if (typeof ctx.tools.guard !== 'function') throw new Error('This DSH has no monotonic tool guard.');
  ctx.tools.guard(() => 'Log reports have no tool execution permission.');
  ctx.on('agent/created', ({ agent }) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function') throw new Error('This DSH has no scoped tool restriction.');
    agent.ctx.tools.restrict({ allow: [] });
  });
  ctx.on('agent/request', async (_position, next) => ({ ...await next(), maxTokens: config.maxTokens }));
  ctx.on('llm/stream', async function* (options, next) {
    // Fail before provider I/O if composition still exposes any scoped tool.
    if ((options.tools !== undefined && !Array.isArray(options.tools)) || (options.tools?.length ?? 0) !== 0
      || !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > config.maxTokens || requests !== 0)
      throw new Error('Report-only request policy refused tools, output budget or another turn.');
    requests++;
    await writeFile(config.receiptPath, JSON.stringify({ requests, tools: 0, guard: true }), { flag: 'wx', mode: 0o600, flush: true });
    yield* next();
  });
}
