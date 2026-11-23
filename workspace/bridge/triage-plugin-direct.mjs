import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { replaceOwnedFile } from './file-replace.mjs';
import { dshReportControls, dshModelSelection } from './dsh-model-selection.mjs';

export const name = 'teamplay-chery-qa-plugin-direct';
export const inject = ['tools', 'llm'];
const digest = value => createHash('sha256').update(value).digest('hex');

/** A task-local wrapper for the installed plugin's direct prepareCall workflow.
 * The outer headless Agent transports the original stream; it never dispatches
 * its own prompt or tools to a provider. The prepared inner envelope is owned
 * here and recognized by identity, not by instructions supplied in logs.
 */
export function apply(ctx, config) {
  for (const field of ['requestPath', 'receiptPath', 'sourceReportPath'])
    if (typeof config[field] !== 'string' || !isAbsolute(config[field])) throw new Error('Direct analysis needs private absolute paths.');
  if (typeof ctx.tools.guard !== 'function') throw new Error('This DSH has no final tool guard.');
  ctx.tools.guard(() => 'Direct plugin reports do not execute Agent tools.');
  ctx.on('agent/created', ({ agent }) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function') throw new Error('This DSH has no scoped tool restriction.');
    agent.ctx.tools.restrict({ allow: [] });
  });
  const internal = new WeakSet();
  let job;
  const generate = async outer => {
    const input = JSON.parse(await readFile(config.requestPath, 'utf8'));
    if (input.recipe !== 'chery-qa-plugin' || typeof input.system !== 'string' || typeof input.user !== 'string'
      || !Number.isSafeInteger(input.maxTokens) || ![5000, 6000, 8000].includes(input.maxTokens)) throw new Error('Invalid plugin analysis input.');
    const llm = ctx.get?.('llm') ?? ctx.llm;
    const selection = dshModelSelection({ ...ctx.get?.('agentDefaultModel')?.currentSelection?.(), ...input.modelSelection });
    if (!selection?.provider || !selection?.model || typeof llm?.prepareCall !== 'function') throw new Error('No selected model is available.');
    const started = Date.now(), chunks = [];
    const receipt = { recipe: input.recipe, taskId: input.taskId, inputRevision: input.inputRevision, source: 'chery-qa',
      guard: true, tools: 0, requests: 0, completed: false, systemSha256: digest(input.system), userSha256: digest(input.user),
      provider: selection.provider, model: selection.model, recipeMaxTokens: input.maxTokens };
    const save = async () => {
      receipt.usage = { elapsedMs: Date.now() - started, providerRequests: receipt.requests, ...(receipt.tokens ? { tokens: receipt.tokens } : {}) };
      const temporary = config.receiptPath + '.tmp';
      await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flush: true });
      await replaceOwnedFile(temporary, config.receiptPath);
    };
    let text = '';
    try {
      const signal = outer.signal;
      signal?.throwIfAborted();
      const call = await llm.prepareCall({ provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }, signal, dshReportControls);
      receipt.reasoningEffort = call.config.reasoningEffort ?? null;
      receipt.maxTokens = call.config.maxTokens;
      receipt.maxTokensSource = 'native-model-default';
      if (receipt.reasoningEffort !== selection.reasoningEffort || !Number.isSafeInteger(receipt.maxTokens) || receipt.maxTokens < 1)
        throw new Error('The native DSH call did not retain the selected thinking effort and its output allowance.');
      const options = { ...call.config, system: input.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.user }], source: { kind: 'chery-qa' } }],
        sessionId: 'chery-qa-analyze-' + Date.now().toString(36), signal };
      internal.add(options);
      receipt.requests++; await save();
      for await (const chunk of call.stream(options)) {
        if (chunk?.type === 'tool-call-delta' || chunk?.type === 'block-start' && chunk.blockType === 'tool-call')
          throw new Error('Direct plugin reports cannot execute tools.');
        if (chunk?.type === 'text-delta') text += String(chunk.text || '');
        if (chunk?.usage) {
          const tokens = { ...receipt.tokens };
          for (const [canonical, aliases] of Object.entries({ inputTokens: ['inputTokens', 'promptTokens', 'prompt_tokens', 'input_tokens'],
            outputTokens: ['outputTokens', 'completionTokens', 'completion_tokens', 'output_tokens'], totalTokens: ['totalTokens', 'total_tokens'],
            reasoningTokens: ['reasoningTokens', 'reasoning_tokens'] })) {
            for (const key of aliases) if (Number.isSafeInteger(chunk.usage[key]) && chunk.usage[key] >= 0) { tokens[canonical] = chunk.usage[key]; break; }
          }
          if (Object.keys(tokens).length) receipt.tokens = tokens;
        }
        if (chunk?.type === 'finish') {
          receipt.finishReason = chunk.reason?.kind ?? null;
          if (['error', 'aborted', 'max-tokens'].includes(receipt.finishReason)) throw new Error('The selected model did not complete its report.');
        }
        chunks.push(chunk);
      }
      const report = text.trim();
      if (!report) throw new Error('The selected model returned no report.');
      await writeFile(config.sourceReportPath, report, { flag: 'wx', mode: 0o600, flush: true });
      receipt.sourceReportSha256 = digest(report); receipt.completed = true;
      return chunks;
    } finally { await save(); }
  };
  ctx.on('llm/stream', async function* (options, next) {
    if (internal.has(options)) {
      if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length)) throw new Error('Direct model input cannot contain tools.');
      yield* next(); return;
    }
    // Replaying a transport request reuses this one analysis instead of issuing
    // another provider call or replacing the model's report with Agent prose.
    job ??= generate(options);
    yield* await job;
  });
}
