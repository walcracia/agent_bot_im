import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(value) ? value : null;

/** Observe only model controls. Never retain the provider payload or headers. */
export function inspectPiModelRequest(payload, model, expected) {
  const provider = identifier(model?.provider), modelId = identifier(payload?.model);
  const reasoningEffort = ['low', 'high', 'xhigh'].includes(payload?.reasoning_effort) ? payload.reasoning_effort : null;
  const thinkingEnabled = payload?.enable_thinking === true;
  const hasThinkingBudget = ['thinking_budget', 'thinking_token_budget', 'thinking_budget_tokens'].some(key => Object.hasOwn(payload ?? {}, key));
  const maxCompletionTokens = Number.isSafeInteger(payload?.max_completion_tokens) && payload.max_completion_tokens > 0 ? payload.max_completion_tokens : null;
  return { type: 'provider_request', provider, modelId, reasoningEffort, thinkingEnabled, hasThinkingBudget, maxCompletionTokens,
    verified: provider === expected.provider && modelId === expected.model && reasoningEffort === expected.reasoningEffort && thinkingEnabled && !hasThinkingBudget };
}

export function registerPiModelProof(pi, environment = process.env) {
  const file = environment.PI_TEAMPLAY_MODEL_PROOF_PATH;
  const expected = { provider: environment.PI_TEAMPLAY_EXPECTED_PROVIDER, model: environment.PI_TEAMPLAY_EXPECTED_MODEL,
    reasoningEffort: environment.PI_TEAMPLAY_EXPECTED_THINKING };
  if (!isAbsolute(file ?? '') || !identifier(expected.provider) || !identifier(expected.model) || expected.reasoningEffort !== 'high')
    throw new Error('Pi model proof requires explicit trusted model controls.');
  pi.on('before_provider_request', (event, context) => {
    const proof = inspectPiModelRequest(event.payload, context.model, expected);
    appendFileSync(file, JSON.stringify({ ...proof, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    // Returning undefined preserves the original native request byte for byte.
  });
}

export default function (pi) { registerPiModelProof(pi); }
