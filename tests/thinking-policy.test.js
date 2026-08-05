import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThinkingRequest, isThinkingControlError } from '../extension/thinking-policy.js';

test('translates thinking off for recognized custom endpoints', () => {
    const deepseek = buildThinkingRequest({ mode: 'off', source: 'custom', model: 'deepseek-v4-flash' });
    assert.equal(deepseek.adapter, 'deepseek');
    assert.deepEqual(JSON.parse(deepseek.payload.custom_include_body), { thinking: { type: 'disabled' } });

    const openrouter = buildThinkingRequest({ mode: 'off', source: 'custom', url: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-r1' });
    assert.equal(openrouter.adapter, 'openrouter');
    assert.deepEqual(JSON.parse(openrouter.payload.custom_include_body), { reasoning: { effort: 'none', exclude: true } });

    const qwen = buildThinkingRequest({ mode: 'off', source: 'custom', model: 'qwen3.5-plus' });
    assert.deepEqual(JSON.parse(qwen.payload.custom_include_body), { enable_thinking: false });
});

test('uses SillyTavern normalized controls for native providers', () => {
    const result = buildThinkingRequest({ mode: 'off', source: 'deepseek', model: 'deepseek-v4-flash' });
    assert.deepEqual(result.payload, { include_reasoning: false, reasoning_effort: 'none' });
});

test('recognizes endpoint rejections of optional thinking controls', () => {
    assert.equal(isThinkingControlError(new Error('Unknown field enable_thinking')), true);
    assert.equal(isThinkingControlError(new Error('The value of enable_thinking is restricted to True')), true);
    assert.equal(isThinkingControlError(new Error('401 Unauthorized')), false);
});
