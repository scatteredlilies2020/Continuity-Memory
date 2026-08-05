import assert from 'node:assert/strict';
import test from 'node:test';
import { alignWorldToChat, collectFingerprintMessages, findChangedExtractions, fingerprintMessage } from '../extension/fingerprint.js';

const oldKey = 'character:7:chat:old.jsonl';
const newKey = 'character:22:chat:copied.jsonl';

function messages() {
    return [
        { index: 0, name: 'User', text: 'Let us visit the music room.' },
        { index: 1, name: 'Yui', text: 'I will bring cake!' },
    ];
}

function worldFor(sourceMessages = messages()) {
    const processedMessages = sourceMessages.map(message => ({
        index: message.index,
        fingerprint: fingerprintMessage(message),
        version: 2,
    }));
    return {
        id: 'light-music-club',
        name: 'Light Music Club',
        scene: null,
        entities: [],
        facts: [{ id: 'fact-1', subject: 'Yui', predicate: 'brings', value: 'cake', sources: [{ chatKey: oldKey, from: 0, to: 1 }] }],
        states: [],
        relationships: [],
        events: [],
        capsules: [{ id: 'capsule-1', chatKey: oldKey, from: 0, to: 1, sources: [{ chatKey: oldKey, from: 0, to: 1 }] }],
        arcs: [{ id: 'arc-1', chatKey: oldKey, capsuleIds: ['capsule-1'] }],
        extractions: [{ id: 'extraction-1', chatKey: oldKey, from: 0, to: 1 }],
        threads: [],
        sources: { [oldKey]: { lastProcessedIndex: 1, processedMessages } },
    };
}

test('collects the same processable message shape used by extraction', () => {
    const chat = [
        { mes: '  hello  ', name: 'User', is_user: true },
        { mes: 'hidden', name: 'System', is_system: true },
        { mes: '', name: 'Yui' },
        { mes: 'cake', name: '', is_user: false },
    ];
    assert.deepEqual(collectFingerprintMessages(chat), [
        { index: 0, name: 'User', text: 'hello' },
        { index: 3, name: 'Character', text: 'cake' },
    ]);
});

test('accepts an imported source when the current chat is one message ahead', () => {
    const current = [...messages(), { index: 2, name: 'User', text: 'What kind of cake?' }];
    const result = alignWorldToChat(worldFor(), current, newKey);
    assert.equal(result.ok, true);
    assert.equal(result.matched, 2);
    assert.equal(result.pending, 1);
    assert.equal(result.world.sources[oldKey], undefined);
    assert.equal(result.world.sources[newKey].lastProcessedIndex, 1);
    assert.equal(result.world.facts[0].sources[0].chatKey, newKey);
    assert.equal(result.world.capsules[0].chatKey, newKey);
    assert.equal(result.world.arcs[0].chatKey, newKey);
    assert.equal(result.world.extractions[0].chatKey, newKey);
});

test('blocks changed branches and memories ahead of the current chat', () => {
    const branch = messages();
    branch[1] = { ...branch[1], text: 'I will bring tea instead.' };
    const changed = alignWorldToChat(worldFor(), branch, newKey);
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'changed-or-branched');

    const ahead = alignWorldToChat(worldFor(), messages().slice(0, 1), newKey);
    assert.equal(ahead.ok, false);
    assert.equal(ahead.code, 'import-ahead');
});

test('blocks populated legacy memory without fingerprints but permits empty memory', () => {
    const legacy = worldFor();
    legacy.sources = {};
    assert.equal(alignWorldToChat(legacy, messages(), newKey).code, 'unverifiable');

    const empty = { id: 'empty', name: 'Empty', sources: {}, facts: [], events: [], capsules: [], extractions: [] };
    const result = alignWorldToChat(empty, messages(), newKey);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'empty');
});
test('blocks memories that combine more than one source conversation', () => {
    const mixed = worldFor();
    mixed.sources['character:9:chat:another.jsonl'] = structuredClone(mixed.sources[oldKey]);
    const result = alignWorldToChat(mixed, messages(), newKey);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'multiple-source-chats');
});

test('consolidates device-specific character aliases without re-extracting the copied chat', () => {
    const deviceKey = 'character:22:chat:old.jsonl';
    const current = [...messages(), { index: 2, name: 'User', text: 'What kind of cake?' }];
    const complete = worldFor(current);
    complete.sources[oldKey] = {
        lastProcessedIndex: 2,
        lastProcessedAt: '2026-08-05T10:00:00.000Z',
        processedMessages: current.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message), version: 2 })),
    };
    complete.extractions[0].to = 2;
    complete.capsules[0].to = 2;
    complete.sources[deviceKey] = {
        lastProcessedIndex: 0,
        lastProcessedAt: '2026-08-05T11:00:00.000Z',
        processedMessages: [{ index: 0, fingerprint: fingerprintMessage(current[0]), version: 2 }],
    };
    complete.extractions.push({ id: 'redundant-extraction', chatKey: deviceKey, from: 0, to: 0 });
    complete.capsules.push({ id: 'redundant-capsule', chatKey: deviceKey, from: 0, to: 0, sources: [{ chatKey: deviceKey, from: 0, to: 0 }] });
    complete.facts.push({ id: 'redundant-fact', sources: [{ chatKey: deviceKey, from: 0, to: 0 }] });

    const result = alignWorldToChat(complete, current, deviceKey);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'aligned-source-aliases');
    assert.equal(result.pending, 0);
    assert.equal(result.changed, true);
    assert.deepEqual(Object.keys(result.world.sources), [deviceKey]);
    assert.equal(result.world.sources[deviceKey].lastProcessedIndex, 2);
    assert.deepEqual(result.world.extractions.map(item => item.id), ['extraction-1']);
    assert.deepEqual(result.world.capsules.map(item => item.id), ['capsule-1']);
    assert.equal(result.world.facts.some(item => item.id === 'redundant-fact'), false);
    assert.equal(result.world.facts[0].sources[0].chatKey, deviceKey);
});
test('finds the exact stored extraction affected by a changed swipe', () => {
    const current = messages();
    const world = worldFor(current);
    world.extractions = [
        { id: 'first', chatKey: oldKey, from: 0, to: 0, messageFingerprints: [{ index: 0, fingerprint: fingerprintMessage(current[0]) }] },
        { id: 'second', chatKey: oldKey, from: 1, to: 1, messageFingerprints: [{ index: 1, fingerprint: fingerprintMessage(current[1]) }] },
    ];
    const changed = [{ ...current[0] }, { ...current[1], text: 'A different active swipe' }];
    assert.deepEqual(findChangedExtractions(world, changed, oldKey).map(item => item.id), ['second']);
});

test('does not mistake deleted tail fingerprints for editable source messages', () => {
    const current = messages();
    const world = worldFor(current);
    world.extractions = [{
        id: 'tail',
        chatKey: oldKey,
        from: 1,
        to: 2,
        messageFingerprints: [
            { index: 1, fingerprint: fingerprintMessage(current[1]) },
            { index: 2, fingerprint: 'deleted-tail-message' },
        ],
    }];
    assert.deepEqual(findChangedExtractions(world, current, oldKey), []);
    const changed = [{ ...current[0] }, { ...current[1], text: 'Changed retained message' }];
    assert.deepEqual(findChangedExtractions(world, changed, oldKey).map(item => item.id), ['tail']);
});
