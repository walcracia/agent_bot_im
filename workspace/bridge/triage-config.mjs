import { resolve } from 'node:path';

function integer(value, fallback, min, max, label) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid QA ' + label + '.');
  return value;
}
function ids(value, label) {
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(id))
    || new Set(value).size !== value.length) throw new Error('Invalid QA ' + label + '.');
  return value;
}
function path(base, value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/u.test(value)) throw new Error('Invalid QA ' + label + '.');
  return resolve(base, value);
}
/** Disabled by default; destination bindings and source credentials stay explicit. */
export function normalizeTriageConfig(value, base, config) {
  if (!value || value.enabled === false) return null;
  if (value.enabled !== true) throw new Error('QA enabled must be boolean.');
  const result = structuredClone(value);
  // Old quota settings remain readable but no longer control QA execution.
  for (const field of ['executionLimits', 'workerLimits', 'totalModelCalls', 'dailyModelCalls']) delete result[field];
  result.backend ??= 'dsh';
  if (result.backend !== 'dsh') throw new Error('Only the installed DSH skill adapter is currently configured.');
  if (result.modelSelection !== undefined && (!result.modelSelection || typeof result.modelSelection !== 'object'
    || Object.keys(result.modelSelection).some(key => !['model', 'provider', 'reasoningEffort'].includes(key))
    || !/^[A-Za-z0-9_.-]{1,80}$/u.test(result.modelSelection.provider ?? '')
    || !/^[A-Za-z0-9_./:-]{1,120}$/u.test(result.modelSelection.model ?? '')
    || result.modelSelection.reasoningEffort !== undefined && !/^[A-Za-z0-9_.-]{1,80}$/u.test(result.modelSelection.reasoningEffort))) throw new Error('Invalid QA model selection.');
  if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(result.sourceId ?? '')) throw new Error('QA sourceId is required.');
  result.pollMilliseconds = integer(result.pollMilliseconds, 60000, 1000, 3600000, 'poll interval');
  result.maxConcurrent = integer(result.maxConcurrent, 1, 1, 1, 'concurrency');
  result.modelTimeoutMs = 0;
  result.adminSenderIds = ids(result.adminSenderIds ?? [], 'administrators');
  if (result.adminSenderIds.some(id => !config.senderIds.includes(id))) throw new Error('QA administrators must be authorized IM senders.');
  if (result.allowChatProjectBinding !== undefined && typeof result.allowChatProjectBinding !== 'boolean') throw new Error('QA chat binding policy must be boolean.');
  if (!Array.isArray(result.bindings) || result.bindings.length > 20) throw new Error('QA bindings are required.');
  const projects = new Set();
  result.bindings = result.bindings.map(binding => {
    if (!binding || binding.sourceId && binding.sourceId !== result.sourceId) throw new Error('QA binding source mismatch.');
    const projectId = String(binding.projectId ?? '');
    if (!/^[1-9]\d{0,14}$/u.test(projectId) || projects.has(projectId)) throw new Error('QA project must have a unique positive ID.');
    projects.add(projectId);
    if (typeof binding.projectCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(binding.projectCode)) throw new Error('Invalid QA project code.');
    if (!config.conversationIds.includes(binding.conversationId)) throw new Error('QA chat must be explicitly authorized.');
    return { sourceId: result.sourceId, projectId, projectCode: binding.projectCode.toUpperCase(), conversationId: binding.conversationId };
  });
  for (const field of ['root', 'skillRoot', 'python']) result[field] = path(base, result[field], field);
  if (!result.mcp || typeof result.mcp !== 'object') throw new Error('QA MCP configuration is required.');
  result.mcp.command = path(base, result.mcp.command, 'MCP command');
  if (!Array.isArray(result.mcp.args) || result.mcp.args.some(arg => typeof arg !== 'string' || /[\r\n\0]/u.test(arg))) throw new Error('Invalid QA MCP args.');
  result.mcp.cwd = path(base, result.mcp.cwd, 'MCP cwd');
  // Environment names are forwarded only to the source process. Values come
  // from the host or an ignored, operator-supplied JSON file, never the model.
  if (result.mcp.env !== undefined) throw new Error('Store QA credentials in a private envFile, not inline bridge config.');
  result.mcp.envNames = ids(result.mcp.envNames ?? [], 'source environment names');
  if (result.mcp.envNames.some(name => !/^QA_[A-Z0-9_]+$/u.test(name))) throw new Error('Only QA_ source variables may be forwarded.');
  if (result.mcp.envFile) result.mcp.envFile = path(base, result.mcp.envFile, 'source envFile');
  result.allowedDownloadOrigins = result.allowedDownloadOrigins ?? [];
  if (!Array.isArray(result.allowedDownloadOrigins) || result.allowedDownloadOrigins.length > 20) throw new Error('Invalid QA download origins.');
  result.allowedDownloadOrigins = result.allowedDownloadOrigins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('QA download origins must be exact origins.');
    return url.origin;
  });
  return result;
}
