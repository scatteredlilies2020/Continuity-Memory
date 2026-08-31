import assert from 'node:assert/strict';
import test from 'node:test';
import { forkWorldToBranch } from '../extension/branch-cache.js';
import { fingerprintMessage } from '../extension/message-digest.js';
import { mergeExtraction } from '../extension/memory-model.js';

const parentKey = 'character:7:chat:adventure';
const branchKey = 'character:7:chat:adventure - Branch #1';

function messages(count = 24) {
    return Array.from({ length: count }, (_, index) => ({
        index,
        name: index % 2 ? 'Guide' : 'Player',
        text: `Message ${index}`,
        isUser: index % 2 === 0,
    }));
}

function extraction(title) {
    return {
        scene: { location: 'Road', time: '', participants: ['Player'], activity: 'Traveling', mood: '' },
        sceneCapsule: {
            title, storyTime: '', location: 'Road', participants: ['Player'], opening: title,
            beats: [title], emotionalArc: '', closing: title, importance: 3,
            temporal: { frame: 'main narrative', relation: 'after', elapsed: '', certainty: 'implicit' },
        },
        entities: [], identityResolutions: [], recordMerges: [], facts: [], states: [],
        relationships: [], events: [], threads: [], backgrounds: [],
    };
}

function parentWorld() {
    const source = messages();
    const world = {
        id: 'adventure', name: 'Adventure', revision: 4, scene: null,
        entities: [], facts: [], states: [], relationships: [], events: [], capsules: [],
        arcs: [], eras: [], extractions: [], threads: [], backgrounds: [], corrections: [], sources: {},
    };
    for (let from = 0; from < source.length; from += 8) {
        const chunk = source.slice(from, from + 8);
        mergeExtraction(world, extraction(`Part ${from / 8 + 1}`), {
            chatKey: parentKey,
            from,
            to: from + 7,
            allowStateUpdates: true,
            messageFingerprints: chunk.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
        });
    }
    world.storySoFar = { [parentKey]: { text: 'Parent Story.', from: 0, to: 21 } };
    return world;
}

test('a truncated branch reuses every stable parent Digest before its new tail', () => {
    const parent = parentWorld();
    const firstCapsuleId = parent.capsules[0].id;
    const result = forkWorldToBranch(parent, messages(18), branchKey, parentKey);

    assert.equal(result.ok, true);
    assert.equal(result.code, 'branch-prefix-reused');
    assert.equal(result.retained, 2);
    assert.equal(result.repairFrom, 16);
    assert.equal(result.world.sources[parentKey], undefined);
    assert.equal(result.world.storySoFar[parentKey], undefined);
    assert.equal(result.world.storySoFar[branchKey].sourceMode, 'chronicle');
    assert.equal(result.world.storySoFar[branchKey].nodeIds.length, 2);
    assert.equal(result.world.sources[branchKey].processedMessages.length, 16);
    assert.deepEqual(result.world.extractions.map(item => [item.from, item.to]), [[0, 7], [8, 15]]);
    assert.equal(result.world.capsules[0].id, firstCapsuleId);
});

test('a changed branch swipe drops its Digest and the dependent suffix only', () => {
    const branch = messages(18);
    branch[9] = { ...branch[9], text: 'A different choice' };
    const result = forkWorldToBranch(parentWorld(), branch, branchKey, parentKey);

    assert.equal(result.ok, true);
    assert.equal(result.retained, 1);
    assert.equal(result.repairFrom, 8);
    assert.deepEqual(result.world.extractions.map(item => [item.from, item.to]), [[0, 7]]);
    assert.equal(result.world.sources[branchKey].processedMessages.length, 8);
});

test('branch reuse restores the two-message stability buffer without rescanning the prefix', () => {
    const result = forkWorldToBranch(parentWorld(), messages(17), branchKey, parentKey);

    assert.equal(result.retained, 1);
    assert.equal(result.repairFrom, 8);
    assert.deepEqual(result.world.extractions.map(item => [item.from, item.to]), [[0, 7]]);
});
