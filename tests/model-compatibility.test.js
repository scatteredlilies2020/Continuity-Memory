import assert from 'node:assert/strict';
import test from 'node:test';
import { isGpt5Model, isGpt56Model, minimumReasoningEffort, outputTokenPayload } from '../extension/model-compatibility.js';

test('detects GPT-5 family aliases without matching unrelated model names', () => {
    for (const model of ['gpt-5', 'gpt-5.6-sol', 'openai/gpt-5.6-terra']) assert.equal(isGpt5Model(model), true);
    assert.equal(isGpt5Model('vendor-my-gpt-5-clone'), false);
    assert.equal(isGpt56Model('openai/gpt-5.6-luna'), true);
    assert.equal(isGpt56Model('gpt-5.5'), false);
});

test('uses the GPT-5 output token field and preserves legacy-compatible models', () => {
    assert.deepEqual(outputTokenPayload('gpt-5.6-sol', 8000), { max_tokens: undefined, max_completion_tokens: 8000 });
    assert.deepEqual(outputTokenPayload('openai/gpt-5.6-terra', 300), { max_tokens: undefined, max_completion_tokens: 300 });
    assert.deepEqual(outputTokenPayload('gpt-4.1-mini', 1800), { max_tokens: 1800 });
});

test('maps GPT-5.6 minimum reasoning to low', () => {
    assert.equal(minimumReasoningEffort('gpt-5.6'), 'low');
    assert.equal(minimumReasoningEffort('gpt-5.4'), 'min');
});
