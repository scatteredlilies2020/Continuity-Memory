import assert from 'node:assert/strict';
import test from 'node:test';
import { compileRollingStorySnapshot, ROLLING_STORY_SNAPSHOT_SCHEMA, STORY_SNAPSHOT_SECTIONS } from '../extension/story-snapshot.js';

test('world-state snapshot has hard section and item limits', () => {
    assert.deepEqual(ROLLING_STORY_SNAPSHOT_SCHEMA.required, ['premise', 'majorDevelopments', 'boundaryState', 'openMatters']);
    for (const section of STORY_SNAPSHOT_SECTIONS) {
        assert.equal(ROLLING_STORY_SNAPSHOT_SCHEMA.properties[section.key].maxItems, section.maxItems);
        assert.equal(ROLLING_STORY_SNAPSHOT_SCHEMA.properties[section.key].items.maxLength, section.maxLength);
    }
});

test('snapshot compiler preserves section order and refuses scene capture', () => {
    const snapshot = compileRollingStorySnapshot({
        premise: ['Foundational cause.'],
        majorDevelopments: Array.from({ length: 10 }, (_, index) => `Turning point ${index + 1}.`),
        boundaryState: ['Durable condition.'],
        openMatters: ['Central unresolved conflict.'],
    });
    assert.match(snapshot, /^Premise: Foundational cause\.\nMajor developments:/);
    assert.match(snapshot, /Turning point 7\./);
    assert.doesNotMatch(snapshot, /Turning point 8\./);
    assert.ok(snapshot.indexOf('State at covered boundary:') > snapshot.indexOf('Major developments:'));
    assert.ok(snapshot.indexOf('Open matters:') > snapshot.indexOf('State at covered boundary:'));
});

test('snapshot compiler accepts a legacy rolling string during migration', () => {
    assert.equal(compileRollingStorySnapshot('  Old   rolling story.  '), 'Old rolling story.');
});
