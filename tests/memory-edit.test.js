import test from 'node:test';
import assert from 'node:assert/strict';
import { applyManualMemoryEdit, describeMemoryEdit } from '../extension/memory-edit.js';
import { memoryViewerPage } from '../extension/memory-viewer.js';
import { supportingRecords } from '../extension/supporting-memories.js';
import { syncChronicleBase, addChroniclePromotion, renderChronicleFrontier } from '../extension/chronicle.js';
import { correctionProtectsRecord } from '../extension/memory-correction.js';
import { resetWorldMemory } from '../extension/memory-model.js';

function world() {
    const source = { chatKey: 'chat', from: 0, to: 7 };
    const data = { id: 'world', revision: 5, sources: { chat: { lastProcessedIndex: 7, processedMessages: [{ index: 0, fingerprint: 'kept' }] } },
        scene: { id: 'scene', location: 'Road', participants: ['Alice'], activity: 'Walking', sources: [source] },
        entities: [{ id: 'alice', name: 'Alice', type: 'person', description: 'A musician.', sources: [source] }],
        facts: [{ id: 'fact', subject: 'Alice', predicate: 'favorite snack', value: 'bread', category: 'preference', persistence: 'persistent', sources: [source] }],
        states: [{ id: 'state', subject: 'Alice', attribute: 'activity', value: 'Walking', scope: 'scene', operation: 'set', sources: [source] }],
        relationships: [{ id: 'relationship', from: 'Alice', to: 'Bob', kind: 'friends', dynamic: 'They trust each other.', sources: [source] }],
        events: [{ id: 'event', title: 'Arrival', summary: 'Alice arrives.', participants: ['Alice'], sources: [source] }],
        threads: [{ id: 'thread', title: 'Festival', detail: 'Alice plans to attend.', participants: ['Alice'], sources: [source],
            history: [{ title: 'Festival', detail: 'Alice heard about it.', participants: ['Alice'], sources: [{ chatKey: 'chat', from: 0, to: 3 }] }] }],
        backgrounds: [{ id: 'background', topic: 'Weather', summary: 'Rain is expected.', certainty: 'reported', participants: [], sources: [source] }],
        capsules: [{ id: 'digest', title: 'Arrival', opening: 'Alice arrives.', beats: ['They talk.'], closing: 'Alice leaves.', chronicleText: 'An old summary.', participants: ['Alice'], chatKey: 'chat', from: 0, to: 7, sources: [source], temporal: { anchorId: 'anchor-kept', frame: 'main', relation: 'after', elapsed: '', certainty: 'explicit' } },
            { id: 'other', title: 'Later', opening: 'Bob arrives.', beats: [], closing: '', chatKey: 'chat', from: 8, to: 15 }],
        chronicle: [], storySoFar: {}, extractions: [], corrections: [], arcs: [], eras: [] };
    syncChronicleBase(data);
    addChroniclePromotion(data, { title: 'Combined', summary: 'An older combined summary.' }, data.chronicle.slice());
    return data;
}

test('the editor exposes entry content and keeps identity and provenance out of its form', () => {
    const data = world();
    for (const [category, recordId] of [['entities', 'alice'], ['facts', 'fact'], ['states', 'state'], ['relationships', 'relationship'], ['events', 'event'], ['capsules', 'digest']]) {
        const fields = describeMemoryEdit(data, { category, id: recordId }).fields.map(item => item.key);
        for (const protectedField of ['id', 'name', 'subject', 'predicate', 'from', 'to', 'sources', 'chatKey', 'revision', 'temporal.anchorId', 'childIds']) assert.ok(!fields.includes(protectedField));
    }
    assert.equal(memoryViewerPage(data, 'corrections').total, 0);
    assert.ok(memoryViewerPage(data, 'facts').items[0].editTarget);
});

test('editing a fact preserves record IDs, source coverage, unrelated records and the original world', () => {
    const original = world();
    const before = structuredClone(original);
    const result = applyManualMemoryEdit(original, { category: 'facts', id: 'fact' }, { value: 'cake' }, { chatKey: 'chat', to: 15 });
    assert.deepEqual(original, before);
    assert.equal(result.world.facts[0].id, 'fact');
    assert.equal(result.world.facts[0].value, 'cake');
    assert.deepEqual(result.world.facts[0].sources[0], before.facts[0].sources[0]);
    assert.deepEqual(result.world.sources, before.sources);
    assert.deepEqual(result.world.relationships, before.relationships);
    assert.equal(result.world.revision, before.revision);
    assert.equal(result.world.corrections.length, 1);
    assert.ok(correctionProtectsRecord(result.world, result.world.facts[0], { chatKey: 'chat', from: 0, to: 7 }));
    const replay = structuredClone(result.world);
    resetWorldMemory(replay, { preserveCorrections: true });
    assert.equal(replay.facts[0].value, 'cake');
});

test('unsafe fields, malformed types, ambiguous IDs and empty core content fail without mutation', () => {
    const data = world();
    const before = structuredClone(data);
    for (const patch of [{ id: 'other' }, { sources: [] }, { childIds: [] }, { revision: 0 }, { 'temporal.anchorId': 'wrong' }, { value: {} }, { value: '' }, { importance: 100 }, { persistence: 'wrong' }]) {
        assert.throws(() => applyManualMemoryEdit(data, { category: 'facts', id: 'fact' }, patch));
        assert.deepEqual(data, before);
    }
    data.facts.push({ ...data.facts[0] });
    assert.throws(() => describeMemoryEdit(data, { category: 'facts', id: 'fact' }), /changed/);
});

test('unchanged content does not create an audit record or require a save', () => {
    const data = world();
    const result = applyManualMemoryEdit(data, { category: 'facts', id: 'fact' }, { value: 'bread' });
    assert.equal(result.changed, false);
    assert.equal(result.world, data);
    assert.equal(data.corrections.length, 0);
});

test('Digest prose edits clear the old summary and refresh C0 without changing its source span', () => {
    const data = world();
    const edited = applyManualMemoryEdit(data, { category: 'capsules', id: 'digest' }, { opening: 'Alice was already here.' }).world;
    const c0 = edited.chronicle.find(item => item.capsuleIds.includes('digest'));
    assert.match(c0.text, /already here/);
    assert.ok(!c0.text.includes('old summary'));
    assert.deepEqual([c0.id, c0.from, c0.to], ['chronicle_digest', 0, 7]);
    assert.equal(edited.capsules[0].temporal.anchorId, 'anchor-kept');
    assert.ok(!edited.chronicle.some(item => item.level > 0));
});

test('C0 editing changes its canonical Digest summary and survives another storage synchronization', () => {
    const data = world();
    const target = memoryViewerPage(data, 'chronicle').items.find(item => item.id === 'chronicle_digest').editTarget;
    const edited = applyManualMemoryEdit(data, target, { chronicleText: 'A corrected complete narrative.' }).world;
    syncChronicleBase(edited);
    assert.equal(edited.capsules[0].chronicleText, 'A corrected complete narrative.');
    assert.equal(edited.chronicle.find(item => item.id === 'chronicle_digest').text, 'A corrected complete narrative.');
    assert.deepEqual(edited.capsules[0].sources[0], data.capsules[0].sources[0]);
});

test('editing a promoted Chronicle retains children and updates the active story cache', () => {
    const data = world();
    const parent = data.chronicle.find(item => item.level === 1);
    const edited = applyManualMemoryEdit(data, { category: 'chronicle', id: parent.id }, { text: 'The corrected wider history.' }).world;
    const node = edited.chronicle.find(item => item.id === parent.id);
    assert.deepEqual(node.childIds, parent.childIds);
    assert.equal(node.summary, node.text);
    assert.match(renderChronicleFrontier(edited, 'chat'), /corrected wider history/);
    assert.equal(edited.corrections[0].operations.length, 0, 'derived-node audits must not be replayed as canonical record arrays');
    resetWorldMemory(structuredClone(edited), { preserveCorrections: true });
});

test('editing an old supporting observation preserves its siblings, current wording and source records', () => {
    const data = world();
    const target = memoryViewerPage(data, 'supporting').items.find(item => item.fields.some(field => field.value.includes('heard about'))).editTarget;
    const edited = applyManualMemoryEdit(data, target, { detail: 'Alice received a written invitation.' }).world;
    const observations = supportingRecords(edited, 'threads');
    assert.equal(edited.threads[0].id, 'thread');
    assert.equal(edited.threads[0].detail, 'Alice plans to attend.');
    assert.ok(observations.some(item => item.detail === 'Alice received a written invitation.'));
    assert.ok(observations.some(item => item.detail === 'Alice plans to attend.'));
    assert.ok(!observations.some(item => item.detail === 'Alice heard about it.'));
    assert.deepEqual(observations.find(item => item.detail.includes('written')).sources, data.threads[0].history[0].sources);
});

test('profile edits update displayed content, including clearing the last old profile value', () => {
    const data = world();
    data.entities[0].profile = { appearance: ['Brown eyes.'] };
    const edited = applyManualMemoryEdit(data, { category: 'entities', id: 'alice' }, { 'profile.appearance': ['Blue eyes.'] }).world;
    assert.match(edited.entities[0].description, /Blue eyes/);
    assert.ok(!describeMemoryEdit(edited, { category: 'entities', id: 'alice' }).fields.some(item => item.key === 'description'));
    const cleared = applyManualMemoryEdit(edited, { category: 'entities', id: 'alice' }, { 'profile.appearance': [] }).world;
    assert.equal(cleared.entities[0].description, '');
    assert.deepEqual(cleared.entities[0].profile.appearance, []);
    assert.equal(cleared.entities[0].name, 'Alice');
});

test('editing one legacy profile group preserves all other groups and plain descriptions stay plain', () => {
    const data = world();
    assert.ok(!describeMemoryEdit(data, { category: 'entities', id: 'alice' }).fields.some(item => item.key.startsWith('profile.')));
    assert.throws(() => applyManualMemoryEdit(data, { category: 'entities', id: 'alice' }, { 'profile.appearance': ['Blue eyes.'] }), /internal fields/);
    data.entities[0].description = 'Role/background: Alice is a musician; Appearance: Alice has brown eyes.';
    const edited = applyManualMemoryEdit(data, { category: 'entities', id: 'alice' }, { 'profile.appearance': ['Alice has blue eyes.'] }).world;
    assert.match(edited.entities[0].profile.roleBackground[0], /musician/);
    assert.match(edited.entities[0].description, /musician/);
    assert.match(edited.entities[0].description, /blue eyes/);
});

test('changing only Digest importance preserves its existing narrative', () => {
    const data = world();
    const edited = applyManualMemoryEdit(data, { category: 'capsules', id: 'digest' }, { importance: 5 }).world;
    assert.equal(edited.capsules[0].chronicleText, 'An old summary.');
    assert.equal(edited.chronicle.find(item => item.id === 'chronicle_digest').text, 'An old summary.');
});

test('changing a C0 title retains its narrative and updates its derived metadata', () => {
    const data = world();
    const target = { category: 'capsules', id: 'digest', view: 'chronicle' };
    const edited = applyManualMemoryEdit(data, target, { title: 'Corrected title' }).world;
    const c0 = edited.chronicle.find(item => item.id === 'chronicle_digest');
    assert.equal(c0.title, 'Corrected title');
    assert.equal(c0.text, 'An old summary.');
    assert.equal(edited.capsules[0].chronicleText, 'An old summary.');
});

test('checkpoint edits preserve its source identity and create a safe audit entry', () => {
    const data = world();
    const edited = applyManualMemoryEdit(data, { category: 'scene' }, { location: 'Library' }).world;
    assert.equal(edited.scene.location, 'Library');
    assert.deepEqual(edited.scene.sources, data.scene.sources);
    assert.equal(edited.scene.id, data.scene.id);
    assert.equal(edited.corrections[0].manualEdit.before.location, 'Road');
    assert.equal(edited.corrections[0].operations.length, 0);
    assert.equal(memoryViewerPage(edited, 'corrections').items[0].editTarget, null);
    resetWorldMemory(structuredClone(edited), { preserveCorrections: true });
});
