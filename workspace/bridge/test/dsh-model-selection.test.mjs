import test from 'node:test';
import assert from 'node:assert/strict';
import { dshMaxReportControls, dshModelPatch, dshModelSelection } from '../dsh-model-selection.mjs';

test('all DSH deployments default to max and stale off or high is reported instead of silently downgraded', () => {
  assert.deepEqual(dshModelSelection(), { reasoningEffort: 'max' });
  assert.deepEqual(dshModelSelection({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' });
  for (const reasoningEffort of ['off', 'low', 'high'])
    assert.throws(() => dshModelSelection({ reasoningEffort }), /must be max/u);
  assert.throws(() => dshModelSelection({ provider: 'deepseek-account' }), /trusted provider and model/u);
  assert.match(dshModelPatch(), /reasoningEffort: "max"/u);
  assert.doesNotMatch(dshModelPatch(), /maxTokens/u);
});

test('QA max uses captured native output allowance while preserving other original controls', () => {
  const controls = Object.freeze({ temperature: 0.2 });
  const model = { defaultMaxTokens: 131072, reasoning: { efforts: [{ id: 'off' }, { id: 'max' }] } };
  assert.deepEqual(dshMaxReportControls(controls, model), { temperature: 0.2, reasoningEffort: 'max', maxTokens: 131072 });
  assert.deepEqual(controls, { temperature: 0.2 });
  assert.throws(() => dshMaxReportControls({}, { ...model, defaultMaxTokens: undefined }), /advertise an output allowance/u);
  assert.throws(() => dshMaxReportControls({}, { ...model, reasoning: { efforts: [{ id: 'high' }] } }), /does not support max/u);
});
