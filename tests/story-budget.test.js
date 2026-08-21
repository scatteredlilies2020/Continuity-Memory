import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicStoryBudget, dynamicStorySourceChunk, resolveStoryBudget } from '../extension/story-budget.js';

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

test('story source chunks scale with context instead of the L1 message count', () => {
    assert.equal(dynamicStorySourceChunk(32000), 6400);
    assert.equal(dynamicStorySourceChunk(128000), 25600);
    assert.equal(dynamicStorySourceChunk(1000), 4000);
    assert.equal(dynamicStorySourceChunk(1000000), 50000);
});
