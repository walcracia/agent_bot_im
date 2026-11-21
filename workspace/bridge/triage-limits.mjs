// Historical import compatibility only. QA execution is observed, not quota-gated.
// Empty objects mean no adapter policy; no large sentinel is used as "unlimited".
export const DEFAULT_EXECUTION_LIMITS = Object.freeze({});
export const HARD_EXECUTION_LIMITS = Object.freeze({});
export function normalizeExecutionLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid historical skill policy.');
  return {};
}
export function executionLimitSummary(input = {}) { return normalizeExecutionLimits(input); }
