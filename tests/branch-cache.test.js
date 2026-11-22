import assert from 'node:assert/strict';
import test from 'node:test';
import { forkWorldToBranch, recoverTruncatedChatPrefix } from '../extension/branch-cache.js';
import { fingerprintMessage } from '../extension/message-digest.js';
import { mergeExtraction } from '../extension/memory-model.js';
import { addChroniclePromotion } from '../extension/chronicle.js';

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

test('a truncated fork keeps a fully shared parent and rekeys its temporal references', () => {
    const parent = parentWorld();
    const promotion = addChroniclePromotion(parent, { summary: 'Player traveled along the road.' }, parent.chronicle.slice(0, 2));
    const result = forkWorldToBranch(parent, messages(18), branchKey, parentKey);
    const carried = result.world.chronicle.find(node => node.id === promotion.id);
    assert.equal(carried.chatKey, branchKey);
    assert.deepEqual(carried.temporalAnchorIds, result.world.capsules.map(item => item.temporal.anchorId));
    assert.notDeepEqual(carried.temporalAnchorIds, promotion.temporalAnchorIds);
    assert.deepEqual(result.world.storySoFar[branchKey].nodeIds, [promotion.id]);
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

test('a fully verified branch with only an undigested tail keeps the parent prefix without replay', () => {
    const parent = parentWorld();
    const result = forkWorldToBranch(parent, messages(26), branchKey, parentKey);

    assert.equal(result.ok, true);
    assert.equal(result.repairFrom, null);
    assert.equal(result.retained, 3);
    assert.equal(result.pending, 2);
    assert.equal(result.world.sources[parentKey], undefined);
    assert.equal(result.world.sources[branchKey].processedMessages.length, 24);
    assert.deepEqual(result.world.extractions.map(item => [item.id, item.createdAt, item.updatedAt]),
        parent.extractions.map(item => [item.id, item.createdAt, item.updatedAt]));
    assert.deepEqual(result.world.capsules.map(item => item.id), parent.capsules.map(item => item.id));
});

test('same-chat tail recovery replays only complete verified batches without mutating the original', () => {
    const original = parentWorld();
    const before = structuredClone(original);
    const result = recoverTruncatedChatPrefix(original, messages(23), parentKey);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'tail-prefix-recovered');
    assert.equal(result.retained, 2);
    assert.equal(result.repairFrom, 16);
    assert.equal(result.world.sources[parentKey].processedMessages.length, 16);
    assert.deepEqual(result.world.extractions.map(item => [item.from, item.to]), [[0, 7], [8, 15]]);
    assert.deepEqual(original, before);
});

test('tail recovery accepts a device character-index alias of the exact same conversation', () => {
    const target = 'character:91:chat:adventure';
    const result = recoverTruncatedChatPrefix(parentWorld(), messages(23), target);
    assert.equal(result.ok, true);
    assert.equal(result.world.sources[parentKey], undefined);
    assert.equal(result.world.sources[target].processedMessages.length, 16);
});

for (const scenario of ['different-chat', 'changed', 'interior-hole', 'inserted', 'empty', 'no-truncation', 'no-replay', 'multiple-sources']) {
    test(`automatic tail recovery refuses ${scenario}`, () => {
        const original = parentWorld();
        let current = messages(23);
        let target = parentKey;
        if (scenario === 'different-chat') target = branchKey;
        if (scenario === 'changed') current[9].text = 'Different history';
        if (scenario === 'interior-hole') current.splice(9, 1);
        if (scenario === 'inserted') original.sources[parentKey].processedMessages.splice(9, 1);
        if (scenario === 'empty') current = [];
        if (scenario === 'no-truncation') current = messages(26);
        if (scenario === 'no-replay') for (const extraction of original.extractions) delete extraction.result;
        if (scenario === 'multiple-sources') original.sources.other = structuredClone(original.sources[parentKey]);
        const before = structuredClone(original);
        assert.equal(recoverTruncatedChatPrefix(original, current, target).ok, false);
        assert.deepEqual(original, before);
    });
}
