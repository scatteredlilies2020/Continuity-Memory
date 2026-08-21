import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStorySourceUnits, formatL1StorySource, resolveStorySourceMode, storedStorySourceMode, storySourceModeLabel, storySourcePolicyIsCurrent, STORY_SOURCE_L1, STORY_SOURCE_POLICY_VERSION, STORY_SOURCE_RAW } from '../extension/story-source.js';

const messages = count => Array.from({ length: count }, (_, index) => ({ index, name: index % 2 ? 'B' : 'A', text: `raw-${index}` }));
const capsule = (from, to) => ({ chatKey: 'chat', from, to, title: `Scene ${from}-${to}`, storyTime: 'Day one', location: 'Hall', participants: ['A', 'B'], opening: `Open ${from}`, beats: [`Beat ${from}`], emotionalArc: 'Trust changes.', closing: `Close ${to}` });

test('L1 Story source is the default while legacy stored stories remain raw', () => {
    assert.equal(resolveStorySourceMode(undefined), STORY_SOURCE_L1);
    assert.equal(resolveStorySourceMode(STORY_SOURCE_RAW), STORY_SOURCE_RAW);
    assert.equal(storedStorySourceMode({ text: 'legacy' }), STORY_SOURCE_RAW);
    assert.equal(storedStorySourceMode({ sourceMode: STORY_SOURCE_L1 }), STORY_SOURCE_L1);
});

test('L1 Story source uses completed L1 summaries and never consumes the uncovered raw tail', () => {
    const result = buildStorySourceUnits(messages(11), [capsule(0, 3), capsule(4, 7)], 'chat', STORY_SOURCE_L1, 7);
    assert.deepEqual(result.units.map(item => [item.sourceFrom, item.index, item.storySourceKind]), [
        [0, 3, STORY_SOURCE_L1], [4, 7, STORY_SOURCE_L1],
    ]);
    assert.equal(result.l1Count, 2);
    assert.equal(result.rawCount, 0);
    assert.equal(result.blockedFrom, null);
    assert.match(result.units[0].text, /Opening: Open 0/);
    assert.doesNotMatch(result.units[0].text, /coverageWarnings|targetId|capsule_/);
});

test('L1-only source policy forces legacy mixed-source stories to rebuild once', () => {
    assert.equal(storySourceModeLabel(STORY_SOURCE_L1), 'completed L1 summaries only');
    assert.equal(storySourcePolicyIsCurrent({ sourceMode: STORY_SOURCE_L1 }, STORY_SOURCE_L1), false);
    assert.equal(storySourcePolicyIsCurrent({ sourceMode: STORY_SOURCE_L1, sourcePolicyVersion: STORY_SOURCE_POLICY_VERSION }, STORY_SOURCE_L1), true);
    assert.equal(storySourcePolicyIsCurrent({ sourceMode: STORY_SOURCE_RAW }, STORY_SOURCE_RAW), true);
});

test('L1 Story source stops before a missing extractable L1 instead of silently substituting raw chat', () => {
    const result = buildStorySourceUnits(messages(12), [capsule(0, 3)], 'chat', STORY_SOURCE_L1, 7);
    assert.deepEqual(result.units.map(item => item.index), [3]);
    assert.equal(result.blockedFrom, 4);
    assert.equal(result.rawCount, 0);
});

test('raw Story source preserves every raw message', () => {
    const raw = messages(4);
    assert.deepEqual(buildStorySourceUnits(raw, [capsule(0, 3)], 'chat', STORY_SOURCE_RAW, 3).units, raw);
    assert.match(formatL1StorySource(capsule(0, 3)), /Development: Beat 0/);
});
