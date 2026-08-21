import assert from 'node:assert/strict';
import test from 'node:test';
import { completeStoryMessages, DEFAULT_STORY_BATCH_MESSAGES, resolveStoryBatchMessages, rollingStoryBuildPlan, rollingStoryRebuildPlan, storyChunkMessageLimit } from '../extension/story-cadence.js';

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
    const plan = rollingStoryBuildPlan(messages, {
        text: 'Saved rolling checkpoint.', from: 0, to: 7,
        rebuildIncomplete: true, rebuildTargetTo: 19,
    });
    assert.equal(plan.resuming, true);
    assert.equal(plan.story, 'Saved rolling checkpoint.');
    assert.equal(plan.from, 0);
    assert.equal(plan.targetTo, 19);
    assert.deepEqual(plan.messages.map(item => item.index), Array.from({ length: 12 }, (_, index) => index + 8));
});

test('Build advances a completed story without starting over', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({ index }));
    const plan = rollingStoryBuildPlan(messages, { text: 'Complete story.', from: 0, to: 3, rebuildIncomplete: false, rebuildTargetTo: 3 });
    assert.equal(plan.resuming, false);
    assert.equal(plan.story, 'Complete story.');
    assert.deepEqual(plan.messages, [messages[4]]);
});

test('Rebuild always starts from raw message zero even after an interruption', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({ index }));
    const plan = rollingStoryRebuildPlan(messages, { text: 'Ignored checkpoint.', from: 0, to: 2, rebuildIncomplete: true, rebuildTargetTo: 4 });
    assert.equal(plan.resuming, false);
    assert.equal(plan.story, '');
    assert.deepEqual(plan.messages, messages);
});

test('Build restarts a rebuild whose first request failed before a new checkpoint', () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({ index }));
    const plan = rollingStoryBuildPlan(messages, {
        text: 'Old completed Story remains available until replacement begins.',
        from: 0,
        to: 6,
        rebuildIncomplete: true,
        rebuildRestartPending: true,
        rebuildTargetTo: 6,
    });
    assert.equal(plan.resuming, true);
    assert.equal(plan.restarting, true);
    assert.equal(plan.story, '');
    assert.deepEqual(plan.messages, messages);
});
