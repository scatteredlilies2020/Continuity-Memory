import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_STORY_CHECKPOINTS, planStoryMutationRecovery, STORY_CHECKPOINT_INTERVAL_MESSAGES, withStoryCheckpoint } from '../extension/story-checkpoints.js';

const fingerprint = message => `fp:${message.text}`;
const messages = count => Array.from({ length: count }, (_, index) => ({ index, text: `message-${index}` }));
const fingerprinted = source => source.map(message => ({ index: message.index, fingerprint: fingerprint(message) }));

function advance(previous, source, to) {
    return withStoryCheckpoint(previous, {
        text: `summary-through-${to}`,
        from: 0,
        to,
        updatedAt: `time-${to}`,
        rebuiltFromRawChat: true,
        rebuildIncomplete: false,
        rebuildRestartPending: false,
    }, source, fingerprint);
}

test('Story checkpoints are periodic, fingerprinted, and bounded', () => {
    const source = messages(500);
    let story = null;
    for (let to = 7; to < source.length; to += 8) story = advance(story, source, to);
    assert.equal(story.sourceFingerprints.length, 496);
    assert.equal(story.checkpoints.length, MAX_STORY_CHECKPOINTS);
    assert.equal(story.checkpoints[0].to, 31);
    assert.ok(story.checkpoints.every((item, index, all) => index === 0 || item.to - all[index - 1].to >= STORY_CHECKPOINT_INTERVAL_MESSAGES));
    assert.equal(story.checkpoints.at(-1).to, 479);
});

test('an edit rewinds to the newest fully verified checkpoint before it', () => {
    const source = messages(100);
    let story = advance(null, source, 31);
    story = advance(story, source, 63);
    story = advance(story, source, 95);
    const changed = messages(100);
    changed[70].text = 'edited-message';
    const recovery = planStoryMutationRecovery(story, fingerprinted(changed), { mutationObserved: true, updatedAt: 'repair' });
    assert.equal(recovery.changed, true);
    assert.equal(recovery.earliest, 70);
    assert.equal(recovery.checkpointTo, 63);
    assert.equal(recovery.story.text, 'summary-through-63');
    assert.equal(recovery.story.rebuildIncomplete, true);
    assert.equal(recovery.story.rebuildTargetTo, 99);
    assert.equal(recovery.story.sourceFingerprints.at(-1).index, 63);
});

test('a deleted message invalidates its checkpoint and every later checkpoint', () => {
    const source = messages(100);
    let story = advance(null, source, 31);
    story = advance(story, source, 63);
    story = advance(story, source, 95);
    const shifted = source.filter(message => message.index !== 50)
        .map((message, index) => ({ ...message, index }));
    const recovery = planStoryMutationRecovery(story, fingerprinted(shifted), { mutationObserved: true });
    assert.equal(recovery.earliest, 50);
    assert.equal(recovery.checkpointTo, 31);
    assert.deepEqual(recovery.story.checkpoints.map(item => item.to), [31]);
});

test('a mutation after the covered Story boundary leaves it intact', () => {
    const source = messages(100);
    const story = advance(null, source, 63);
    const changed = messages(100);
    changed[90].text = 'outside-covered-range';
    assert.deepEqual(planStoryMutationRecovery(story, fingerprinted(changed), { mutationObserved: true }), {
        changed: false,
        verifiable: true,
    });
});

test('a legacy Story fails closed to a full rebuild after an observed mutation', () => {
    const recovery = planStoryMutationRecovery({ text: 'legacy', from: 0, to: 63 }, fingerprinted(messages(100)), {
        mutationObserved: true,
        updatedAt: 'repair',
    });
    assert.equal(recovery.changed, true);
    assert.equal(recovery.checkpointTo, null);
    assert.equal(recovery.story.text, '');
    assert.equal(recovery.story.rebuildRestartPending, true);
    assert.equal(recovery.story.rebuildTargetTo, 99);
});

test('deleting every eligible message removes rather than reusing Story content', () => {
    const story = advance(null, messages(64), 63);
    const recovery = planStoryMutationRecovery(story, [], { mutationObserved: true });
    assert.equal(recovery.changed, true);
    assert.equal(recovery.story, null);
});
