import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThinkingRequest, isMandatoryThinkingError, isThinkingControlError, mandatoryThinkingPayload, shouldSendStructuredSchema, thinkingControlFallbackPayload } from '../extension/thinking-policy.js';

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

test('uses GPT-5.6 supported minimum reasoning effort', () => {
    for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'openai/gpt-5.6-terra', 'gpt-5.6-luna']) {
        const result = buildThinkingRequest({ mode: 'minimum', source: 'openai', model });
        assert.equal(result.payload.reasoning_effort, 'low');
    }
    assert.equal(buildThinkingRequest({ mode: 'minimum', source: 'openai', model: 'gpt-5.4' }).payload.reasoning_effort, 'min');
});

test('passes explicit Story-style reasoning efforts through to supported profiles', () => {
    for (const effort of ['low', 'medium', 'high', 'max']) {
        const result = buildThinkingRequest({ mode: effort, source: 'openai', model: 'gpt-5.5' });
        assert.equal(result.payload.include_reasoning, true);
        assert.equal(result.payload.reasoning_effort, effort);
    }
    assert.deepEqual(buildThinkingRequest({ mode: 'auto', source: 'openai', model: 'gpt-5.5' }).payload, {});
});

test('translates explicit effort levels for Gemini and OpenRouter profiles', () => {
    const gemini = buildThinkingRequest({ mode: 'high', source: 'google', model: 'gemini-3.1-pro-preview' });
    assert.equal(gemini.payload.reasoning_effort, 'high');
    assert.equal(gemini.payload.include_reasoning, true);

    const openrouter = buildThinkingRequest({ mode: 'medium', source: 'custom', url: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.1-pro-preview' });
    assert.equal(openrouter.payload.reasoning_effort, 'medium');
    assert.deepEqual(JSON.parse(openrouter.payload.custom_include_body), { reasoning: { effort: 'medium', exclude: true } });
});

test('uses valid thinking controls for Gemini 2.5 and Gemini 3+ models', () => {
    const pro31 = buildThinkingRequest({ mode: 'off', source: 'google', model: 'gemini-3.1-pro-preview' });
    assert.equal(pro31.adapter, 'gemini');
    assert.deepEqual(pro31.payload, { include_reasoning: false, reasoning_effort: 'low' });

    for (const model of ['gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']) {
        const result = buildThinkingRequest({ mode: 'off', source: 'google', model });
        assert.equal(result.adapter, 'gemini');
        assert.deepEqual(result.payload, { include_reasoning: false, reasoning_effort: 'min' });
        assert.equal(buildThinkingRequest({ mode: 'minimum', source: 'google', model }).payload.reasoning_effort, 'min');
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

    const directFlash = buildThinkingRequest({
        mode: 'off',
        source: 'custom',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-3.6-flash',
    });
    assert.equal(directFlash.payload.reasoning_effort, 'minimal');
    assert.deepEqual(JSON.parse(directFlash.payload.custom_include_body), { reasoning_effort: 'minimal' });

    const openrouter = buildThinkingRequest({
        mode: 'off',
        source: 'custom',
        url: 'https://openrouter.ai/api/v1',
        model: 'google/gemini-3.6-flash',
    });
    assert.equal(openrouter.adapter, 'gemini-openrouter');
    assert.equal(openrouter.payload.reasoning_effort, 'minimal');
    assert.deepEqual(JSON.parse(openrouter.payload.custom_include_body), { reasoning: { effort: 'minimal', exclude: true } });

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

test('Gemini omits only the oversized L1 schema and retains smaller structured schemas', () => {
    const result = buildThinkingRequest({ mode: 'default', source: 'makersuite', model: 'gemini-3.1-pro-preview' });
    assert.equal(result.adapter, 'gemini-provider-default');
    assert.deepEqual(result.payload, {});
    assert.equal(shouldSendStructuredSchema(result.adapter), false);
    assert.equal(shouldSendStructuredSchema(result.adapter, { name: 'continuity_memory_extraction' }), false);
    assert.equal(shouldSendStructuredSchema(result.adapter, { name: 'continuity_memory_correction' }), true);
    assert.equal(shouldSendStructuredSchema(result.adapter, { name: 'continuity_l2_arc' }), true);
    assert.equal(shouldSendStructuredSchema(result.adapter, { name: 'continuity_l3_era' }), true);
    assert.equal(shouldSendStructuredSchema('openrouter'), true);
});

test('recognizes endpoint rejections of optional thinking controls', () => {
    assert.equal(isThinkingControlError(new Error('Unknown field enable_thinking')), true);
    assert.equal(isThinkingControlError(new Error('The value of enable_thinking is restricted to True')), true);
    assert.equal(isThinkingControlError(new Error('401 Unauthorized')), false);
});

test('native OpenRouter Auto explicitly keeps reasoning enabled', () => {
    for (const mode of ['auto', 'default']) {
        const result = buildThinkingRequest({ mode, source: 'openrouter', model: 'stealth/ox-alpha' });
        assert.equal(result.adapter, 'openrouter-provider-default');
        assert.deepEqual(result.payload, { include_reasoning: true });
        assert.equal(result.controlled, false);
    }
});

test('mandatory reasoning errors recover by enabling instead of stripping controls', () => {
    const errors = [
        new Error('Reasoning is mandatory for this endpoint and cannot be disabled.'),
        new Error('Thinking must be enabled for this model.'),
        new Error('This endpoint requires reasoning.'),
    ];
    for (const error of errors) {
        assert.equal(isThinkingControlError(error), true);
        assert.equal(isMandatoryThinkingError(error), true);
    }
    const error = errors[0];
    assert.deepEqual(thinkingControlFallbackPayload(error, {
        include_reasoning: false,
        reasoning_effort: 'none',
        custom_include_body: JSON.stringify({ reasoning: { effort: 'none', exclude: true } }),
    }), {
        include_reasoning: true,
        reasoning_effort: 'low',
        custom_include_body: JSON.stringify({ reasoning: { effort: 'low', exclude: false } }),
    });
    assert.deepEqual(thinkingControlFallbackPayload(new Error('Unknown field reasoning_effort'), { include_reasoning: false }), {});
});

test('detached requests can prebuild a mandatory-reasoning retry for OpenRouter', () => {
    assert.deepEqual(mandatoryThinkingPayload({ include_reasoning: false, reasoning_effort: 'none' }), {
        include_reasoning: true,
        reasoning_effort: 'low',
    });
    assert.deepEqual(mandatoryThinkingPayload({
        include_reasoning: false,
        reasoning_effort: 'none',
        custom_include_body: JSON.stringify({ reasoning: { effort: 'none', exclude: true } }),
    }), {
        include_reasoning: true,
        reasoning_effort: 'low',
        custom_include_body: JSON.stringify({ reasoning: { effort: 'low', exclude: false } }),
    });
});
