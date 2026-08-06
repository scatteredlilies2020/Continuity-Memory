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

test('uses valid thinking controls for Gemini 2.5 and Gemini 3+ models', () => {
    for (const model of ['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.6-flash']) {
        const result = buildThinkingRequest({ mode: 'off', source: 'google', model });
        assert.equal(result.adapter, 'gemini');
        assert.deepEqual(result.payload, { include_reasoning: false, reasoning_effort: 'low' });
    }

    const pro25 = buildThinkingRequest({ mode: 'off', source: 'makersuite', model: 'gemini-2.5-pro' });
    assert.deepEqual(pro25.payload, { include_reasoning: false, reasoning_effort: 'low' });

    for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
        const result = buildThinkingRequest({ mode: 'off', source: 'google', model });
        assert.deepEqual(result.payload, { include_reasoning: false, reasoning_effort: 'none' });
    }
});

test('detects Gemini through custom endpoints, profiles, and model names', () => {
    const direct = buildThinkingRequest({
        mode: 'minimum',
        source: 'custom',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-3.1-pro-preview',
    });
    assert.equal(direct.adapter, 'gemini-openai-compatible');
    assert.equal(direct.payload.reasoning_effort, 'low');
    assert.deepEqual(JSON.parse(direct.payload.custom_include_body), { reasoning_effort: 'low' });

    const openrouter = buildThinkingRequest({
        mode: 'off',
        source: 'custom',
        url: 'https://openrouter.ai/api/v1',
        model: 'google/gemini-3.6-flash',
    });
    assert.equal(openrouter.adapter, 'gemini-openrouter');
    assert.equal(openrouter.payload.reasoning_effort, 'low');
    assert.deepEqual(JSON.parse(openrouter.payload.custom_include_body), { reasoning: { effort: 'low', exclude: true } });

    const profile = buildThinkingRequest({ mode: 'minimum', source: 'custom', profileName: 'Gemini 2.5 Pro' });
    assert.equal(profile.payload.reasoning_effort, 'low');
});

test('does not force unsupported controls on older or unversioned Gemini models', () => {
    for (const model of ['gemini-pro', 'gemini-1.5-flash', 'gemini-latest']) {
        const result = buildThinkingRequest({ mode: 'off', source: 'google', model });
        assert.equal(result.adapter, 'gemini-provider-default');
        assert.deepEqual(result.payload, {});
        assert.equal(result.controlled, false);
    }
});

test('recognizes endpoint rejections of optional thinking controls', () => {
    assert.equal(isThinkingControlError(new Error('Unknown field enable_thinking')), true);
    assert.equal(isThinkingControlError(new Error('The value of enable_thinking is restricted to True')), true);
    assert.equal(isThinkingControlError(new Error('401 Unauthorized')), false);
});
