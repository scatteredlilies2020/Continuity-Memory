import assert from 'node:assert/strict';
import test from 'node:test';
import { completeStoryMessages, DEFAULT_STORY_BATCH_MESSAGES, resolveStoryBatchMessages, rollingStoryRebuildPlan, storyChunkMessageLimit } from '../extension/story-cadence.js';

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

test('an interrupted story rebuild resumes after its last saved message without losing its story', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ index }));
    const plan = rollingStoryRebuildPlan(messages, {
        text: 'Saved rolling checkpoint.', from: 0, to: 7,
        rebuildIncomplete: true, rebuildTargetTo: 19,
    });
    assert.equal(plan.resuming, true);
    assert.equal(plan.story, 'Saved rolling checkpoint.');
    assert.equal(plan.from, 0);
    assert.equal(plan.targetTo, 19);
    assert.deepEqual(plan.messages.map(item => item.index), Array.from({ length: 12 }, (_, index) => index + 8));
});

test('a completed story begins an intentional rebuild from raw message zero', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({ index }));
    const plan = rollingStoryRebuildPlan(messages, { text: 'Complete story.', from: 0, to: 4, rebuildIncomplete: false, rebuildTargetTo: 4 });
    assert.equal(plan.resuming, false);
    assert.equal(plan.story, '');
    assert.deepEqual(plan.messages, messages);
});
