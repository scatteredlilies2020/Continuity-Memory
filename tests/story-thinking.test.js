import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStoryThinkingMode, profileReasoningEffort, resolveStoryThinkingMode } from '../extension/story-thinking.js';

test('Story thinking defaults to automatic profile inheritance', () => {
    assert.equal(normalizeStoryThinkingMode(undefined), 'auto');
    assert.equal(resolveStoryThinkingMode('auto', 'high', 'low'), 'high');
    assert.equal(resolveStoryThinkingMode('auto', '', 'medium'), 'medium');
    assert.equal(resolveStoryThinkingMode('auto', 'auto', 'high'), 'default');
});

test('explicit Story thinking overrides the selected profile effort', () => {
    for (const mode of ['off', 'minimum', 'low', 'medium', 'high', 'max']) {
        assert.equal(resolveStoryThinkingMode(mode, 'high', 'high'), mode);
    }
});

test('automatic Story thinking reads the selected connection profile preset effort', () => {
    const profile = { preset: 'GLM Story' };
    assert.equal(profileReasoningEffort(profile, { 'GLM Story': 1 }, [{}, { reasoning_effort: 'high' }]), 'high');
    assert.equal(profileReasoningEffort({ reasoning_effort: 'low', preset: 'GLM Story' }, { 'GLM Story': 1 }, [{}, { reasoning_effort: 'high' }]), 'low');
});
