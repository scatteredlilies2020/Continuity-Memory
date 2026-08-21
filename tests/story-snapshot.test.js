import assert from 'node:assert/strict';
import test from 'node:test';
import { compileRollingStorySnapshot, ROLLING_STORY_SNAPSHOT_SCHEMA, STORY_SNAPSHOT_SECTIONS } from '../extension/story-snapshot.js';

test('world-state snapshot has required flexible sections without destructive field limits', () => {
    assert.deepEqual(ROLLING_STORY_SNAPSHOT_SCHEMA.required, ['premise', 'majorDevelopments', 'boundaryState', 'openMatters']);
    for (const section of STORY_SNAPSHOT_SECTIONS) {
        assert.equal(ROLLING_STORY_SNAPSHOT_SCHEMA.properties[section.key].maxItems, undefined);
        assert.equal(ROLLING_STORY_SNAPSHOT_SCHEMA.properties[section.key].items.maxLength, undefined);
    }
});

test('snapshot compiler preserves section order and never cuts off entries', () => {
    const snapshot = compileRollingStorySnapshot({
        premise: ['Foundational cause.'],
        majorDevelopments: Array.from({ length: 10 }, (_, index) => `Turning point ${index + 1}.`),
        boundaryState: ['Durable condition.'],
        openMatters: ['Central unresolved conflict.'],
    });
    assert.match(snapshot, /^Premise: Foundational cause\.\nMajor developments:/);
    assert.match(snapshot, /Turning point 10\./);
    assert.ok(snapshot.indexOf('State at covered boundary:') > snapshot.indexOf('Major developments:'));
    assert.ok(snapshot.indexOf('Open matters:') > snapshot.indexOf('State at covered boundary:'));
});

test('snapshot compiler preserves a complete long thought without inserting an ellipsis', () => {
    const longThought = `A premise-defining secret remains unknown to its subject, ${'with durable consequences '.repeat(30)}until disclosure.`;
    const snapshot = compileRollingStorySnapshot({
        premise: [longThought],
        majorDevelopments: [],
        boundaryState: [],
        openMatters: [],
    });
    assert.ok(snapshot.endsWith('until disclosure.'));
    assert.doesNotMatch(snapshot, /…/u);
});

test('snapshot compiler accepts a legacy rolling string during migration', () => {
    assert.equal(compileRollingStorySnapshot('  Old   rolling story.  '), 'Old rolling story.');
});
