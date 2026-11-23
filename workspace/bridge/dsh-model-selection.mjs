/** Deployment-owned DSH controls. Native DSH validates support before dispatch. */
export const DSH_REASONING_EFFORT = 'high';

export function dshModelSelection(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))
    || (value.provider !== undefined || value.model !== undefined)
      && (!/^[A-Za-z0-9_.-]{1,80}$/u.test(value.provider ?? '') || !/^[A-Za-z0-9_./:-]{1,120}$/u.test(value.model ?? '')))
    throw new Error('DSH model selection requires a trusted provider and model.');
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/u.test(value.reasoningEffort)))
    throw new Error('DSH reasoningEffort must be a trusted native effort identifier.');
  return { ...value, reasoningEffort: value.reasoningEffort ?? DSH_REASONING_EFFORT };
}

export function dshModelPatch(selection) {
  return '- id: agent-default-model\n  config:\n'
    + Object.entries(dshModelSelection(selection)).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}\n`).join('');
}

/** Thinking shares the output allowance with the report. Keep the native
 * model's advertised allowance instead of the old non-thinking recipe cap. */
export function dshReportControls(controls, model) {
  const { reasoningEffort } = dshModelSelection({ reasoningEffort: controls.reasoningEffort });
  if (!model?.reasoning?.efforts?.some(effort => effort.id === reasoningEffort))
    throw new Error(`The selected DSH model does not support reasoning effort ${reasoningEffort}.`);
  if (!Number.isSafeInteger(model.defaultMaxTokens) || model.defaultMaxTokens < 1)
    throw new Error('The selected DSH model does not advertise an output allowance for thinking.');
  return { ...controls, reasoningEffort, maxTokens: model.defaultMaxTokens };
}
