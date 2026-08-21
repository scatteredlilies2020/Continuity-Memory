import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicStoryBudget, dynamicStorySourceChunk, resolveStoryBudget, storyWithinAllowance } from '../extension/story-budget.js';

test('automatic rolling-story budget scales with context and keeps a one-thousand-token minimum', () => {
    assert.equal(dynamicStoryBudget(32000), 1000);
    assert.equal(dynamicStoryBudget(50000), 1000);
    assert.equal(dynamicStoryBudget(128000), 2560);
    assert.equal(dynamicStoryBudget(1000000), 6000);
});

test('rolling-story budget still accepts an explicit override', () => {
    assert.deepEqual(resolveStoryBudget(0, 128000), { tokens: 2560, mode: 'automatic', contextSize: 128000 });
    assert.deepEqual(resolveStoryBudget(1500, 128000), { tokens: 1500, mode: 'fixed', contextSize: 128000 });
});

test('story source chunks use all context remaining after output, prior story, and prompt reserves', () => {
    assert.equal(dynamicStorySourceChunk(32000), 27952);
    assert.equal(dynamicStorySourceChunk(32000, 1000, false), 28952);
    assert.equal(dynamicStorySourceChunk(128000), 120832);
    assert.equal(dynamicStorySourceChunk(1000), 128);
    assert.equal(dynamicStorySourceChunk(1000000), 985952);
});

test('the final rolling digest is capped independently from the uncapped API completion', () => {
    assert.equal(storyWithinAllowance(1280, 1280), true);
    assert.equal(storyWithinAllowance(1281, 1280), false);
});
