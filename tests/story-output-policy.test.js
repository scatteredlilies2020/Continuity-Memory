import assert from 'node:assert/strict';
import test from 'node:test';
import { storyCompressionTarget, storyGenerationTargets } from '../extension/story-output-policy.js';

test('initial Story generation leaves tokenizer safety headroom', () => {
    assert.deepEqual(storyGenerationTargets(1280), {
        targetMinimum: 870,
        targetMaximum: 1024,
        characterBudget: 3840,
    });
});

test('automatic condensation becomes progressively more conservative', () => {
    assert.equal(storyCompressionTarget(1280, 1), 998);
    assert.equal(storyCompressionTarget(1280, 2), 896);
    assert.equal(storyCompressionTarget(1280, 5), 640);
});
