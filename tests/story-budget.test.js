import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicStoryBudget, dynamicStoryRefineSourceChunk, dynamicStorySourceChunk, resolveStoryBudget, storyWithinAllowance } from '../extension/story-budget.js';

test('automatic rolling-story budget uses twenty percent of context with bounded extremes', () => {
    assert.equal(dynamicStoryBudget(4000), 1500);
    assert.equal(dynamicStoryBudget(32000), 6400);
    assert.equal(dynamicStoryBudget(50000), 10000);
    assert.equal(dynamicStoryBudget(128000), 25600);
    assert.equal(dynamicStoryBudget(1000000), 100000);
});

test('rolling-story budget still accepts an explicit override', () => {
    assert.deepEqual(resolveStoryBudget(0, 128000), { tokens: 25600, mode: 'automatic', contextSize: 128000 });
    assert.deepEqual(resolveStoryBudget(1500, 128000), { tokens: 1500, mode: 'fixed', contextSize: 128000 });
    assert.deepEqual(resolveStoryBudget(200000, 128000), { tokens: 100000, mode: 'fixed', contextSize: 128000 });
});

test('story source chunks use all context remaining after output, prior story, and prompt reserves', () => {
    assert.equal(dynamicStorySourceChunk(32000), 17152);
    assert.equal(dynamicStorySourceChunk(32000, 1000, false), 28952);
    assert.equal(dynamicStorySourceChunk(128000), 74752);
    assert.equal(dynamicStorySourceChunk(1000), 128);
    assert.equal(dynamicStorySourceChunk(1000000), 797952);
});

test('manual Story refinement reserves room for output plus baseline and candidate snapshots', () => {
    assert.equal(dynamicStoryRefineSourceChunk(10000, 1500), 3452);
    assert.equal(dynamicStoryRefineSourceChunk(4000, 1500), 128);
});

test('the final rolling digest is capped independently from the uncapped API completion', () => {
    assert.equal(storyWithinAllowance(1280, 1280), true);
    assert.equal(storyWithinAllowance(1281, 1280), false);
});
