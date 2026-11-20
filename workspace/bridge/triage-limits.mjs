export const DEFAULT_EXECUTION_LIMITS = Object.freeze({
  modelRequests: 12, toolCalls: 32, inputCharacters: 192000, maxTokens: 4096,
  returnedCharacters: 128000, evidenceCharacters: 96000, parserRuns: 4,
});
export const HARD_EXECUTION_LIMITS = Object.freeze({
  modelRequests: 32, toolCalls: 96, inputCharacters: 384000, maxTokens: 8192,
  returnedCharacters: 384000, evidenceCharacters: 256000, parserRuns: 8,
});
export function normalizeExecutionLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_EXECUTION_LIMITS, key)))
    throw new Error('Invalid trusted skill execution limits.');
  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < (key === 'toolCalls' ? 3 : 1) || value > HARD_EXECUTION_LIMITS[key])
    throw new Error('Skill execution limit is outside its supported bounds.');
  return limits;
}
export function executionLimitSummary(limits) {
  const { modelRequests, toolCalls, inputCharacters, maxTokens } = normalizeExecutionLimits(limits);
  return { modelRequests, toolCalls, inputCharacters, maxTokens };
}
