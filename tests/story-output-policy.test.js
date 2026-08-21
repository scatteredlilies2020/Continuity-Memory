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

test('Story safety ratio automatically uses more of larger allowances', () => {
    assert.deepEqual(storyGenerationTargets(1500), {
        targetMinimum: 1020,
        targetMaximum: 1200,
        characterBudget: 4500,
    });
    assert.deepEqual(storyGenerationTargets(6000), {
        targetMinimum: 4560,
        targetMaximum: 5280,
        characterBudget: 18900,
    });
});

test('automatic condensation becomes progressively more conservative', () => {
    assert.equal(storyCompressionTarget(1280, 1), 998);
    assert.equal(storyCompressionTarget(1280, 2), 896);
    assert.equal(storyCompressionTarget(1280, 5), 640);
    assert.equal(storyCompressionTarget(6000, 1), 5160);
    assert.equal(storyCompressionTarget(6000, 2), 4680);
});
