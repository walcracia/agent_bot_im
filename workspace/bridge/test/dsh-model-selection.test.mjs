import test from 'node:test';
import assert from 'node:assert/strict';
import { dshReportControls, dshModelPatch, dshModelSelection } from '../dsh-model-selection.mjs';

test('DSH defaults to High and preserves trusted explicit native effort identifiers without substituting a provider', () => {
  assert.deepEqual(dshModelSelection(), { reasoningEffort: 'high' });
  assert.deepEqual(dshModelSelection({ provider: 'trusted-account', model: 'trusted-model' }),
    { provider: 'trusted-account', model: 'trusted-model', reasoningEffort: 'high' });
  for (const reasoningEffort of ['off', 'low', 'high', 'max', 'xhigh'])
    assert.deepEqual(dshModelSelection({ reasoningEffort }), { reasoningEffort });
  for (const reasoningEffort of ['high\ninjected', '', 1, null])
    assert.throws(() => dshModelSelection({ reasoningEffort }), /trusted native effort identifier/u);
  assert.throws(() => dshModelSelection({ provider: 'trusted-account' }), /trusted provider and model/u);
  assert.match(dshModelPatch(), /reasoningEffort: "high"/u);
  assert.doesNotMatch(dshModelPatch(), /maxTokens/u);
});

test('QA High uses captured native output allowance while preserving other original controls and refusing unsupported effort', () => {
  const controls = Object.freeze({ temperature: 0.2 });
  const model = { defaultMaxTokens: 131072, reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] } };
  assert.deepEqual(dshReportControls(controls, model), { temperature: 0.2, reasoningEffort: 'high', maxTokens: 131072 });
  assert.deepEqual(dshReportControls({ ...controls, reasoningEffort: 'max' }, model), { temperature: 0.2, reasoningEffort: 'max', maxTokens: 131072 });
  assert.deepEqual(controls, { temperature: 0.2 });
  assert.throws(() => dshReportControls({}, { ...model, defaultMaxTokens: undefined }), /advertise an output allowance/u);
  assert.throws(() => dshReportControls({}, { ...model, reasoning: { efforts: [{ id: 'xhigh' }] } }), /does not support reasoning effort high/u);
  assert.throws(() => dshReportControls({ reasoningEffort: 'max' }, { ...model, reasoning: { efforts: [{ id: 'high' }] } }), /does not support reasoning effort max/u);
});
