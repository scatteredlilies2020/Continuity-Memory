import assert from 'node:assert/strict';
import test from 'node:test';
import { completeStoryMessages, DEFAULT_STORY_BATCH_MESSAGES, resolveStoryBatchMessages, storyChunkMessageLimit } from '../extension/story-cadence.js';

test('story cadence defaults to eight messages and remains independently adjustable', () => {
    assert.equal(DEFAULT_STORY_BATCH_MESSAGES, 8);
    assert.equal(resolveStoryBatchMessages(undefined), 8);
    assert.equal(resolveStoryBatchMessages(1), 2);
    assert.equal(resolveStoryBatchMessages(100), 50);
});

test('automatic story cadence waits for complete story batches', () => {
    const messages = Array.from({ length: 17 }, (_, index) => ({ index }));
    assert.deepEqual(completeStoryMessages(messages.slice(0, 7), 8), []);
    assert.deepEqual(completeStoryMessages(messages, 8).map(item => item.index), Array.from({ length: 16 }, (_, index) => index));
    assert.equal(completeStoryMessages(messages, 8, true).length, 17);
});

test('fresh story construction packs context-safe chunks while later updates keep their cadence', () => {
    assert.equal(storyChunkMessageLimit(false, 8), Infinity);
    assert.equal(storyChunkMessageLimit(true, 8), 8);
    assert.equal(storyChunkMessageLimit(true, 100), 50);
});
