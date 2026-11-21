export const name = 'teamplay-business-router-readonly';
export const inject = ['tools', 'llm'];
export function apply(ctx) {
  if (typeof ctx.tools.guard !== 'function') throw new Error('DSH has no tool guard.');
  ctx.tools.guard(() => 'The business Router only selects registered capabilities.');
  ctx.on('agent/created', ({ agent }) => agent.ctx.tools.restrict({ allow: [] }));
  ctx.on('llm/stream', async function* (options, next) {
    if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length)) throw new Error('The business Router cannot execute tools.');
    yield* next();
  });
}
