import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { syncChronicleBase, renderChronicleFrontier } from '../extension/chronicle.js';

const source = [{ chatKey: 'chat', from: 0, to: 7 }];
const user = mes => [{ is_user: true, mes }];
const count = (text, value) => text.split(value).length - 1;
const world = overrides => ({
    entities: [], facts: [], relationships: [], states: [], events: [], threads: [],
    backgrounds: [], capsules: [], corrections: [], chronicle: [], ...overrides,
});
const entity = (id, name, description = 'Keeper of the auric covenant.') => ({
    id, name, type: 'person', description, importance: 5,
});
const fact = (id, subject, value, extra = {}) => ({
    id, subject, predicate: 'auric covenant origin', value,
    persistence: 'persistent', importance: 5, sources: source, ...extra,
});

function supportedWorld() {
    return world({
        entities: [entity('aster', 'Aster')],
        facts: [fact('origin', 'Aster', 'The lantern seal unlocks only during a lunar eclipse.')],
        relationships: [{
            id: 'covenant', from: 'Aster', to: 'Beryl', kind: 'auric covenant', status: 'active',
            dynamic: 'Their singular boundary protocol governs the lantern seal during the eclipse.', sources: source, importance: 4,
        }],
        events: [{
            id: 'ceremony', title: 'Lantern sealing', summary: 'Aster sealed the lantern during the eclipse.',
            sources: source, importance: 5,
        }],
        threads: [{
            id: 'watch', title: 'Lunar vigil', detail: 'Aster must find a second lantern seal before dawn.',
            participants: ['Aster'], status: 'open', sources: source, importance: 5,
        }],
    });
}

test('entity canon is not repeated as a selected fact, and retains its temporal anchor', () => {
    const value = 'Aster intends to inspect the seal tomorrow.';
    const target = world({
        entities: [entity('aster', 'Aster')],
        facts: [fact('inspection', 'Aster', value, { temporalAnchorId: 'Digest-inspection' })],
    });
    const before = JSON.stringify(target);
    const result = buildMemoryPrompt(target, user('Aster and the auric covenant origin'), 6000, 'chat');

    assert.ok(result.retrievalDiagnostics.selections.some(row => row.section === 'Facts' && row.id === 'inspection'));
    assert.equal(count(result.prompt, 'Aster intends to inspect the seal'), 1);
    assert.match(result.prompt, /tomorrow.*relative to Digest-inspection/u);
    assert.equal(JSON.stringify(target), before);
});

test('canon and ledger entries already supplied by supporting recall appear only once', () => {
    const target = supportedWorld();
    const before = JSON.stringify(target);
    const result = buildMemoryPrompt(target, user('What is Aster’s singular boundary protocol?'), 6000, 'chat');
    const support = result.retrievalDiagnostics.selections.filter(row => row.section === 'Supporting continuity');

    for (const id of ['origin', 'ceremony', 'watch']) assert.ok(support.some(row => row.id === id));
    for (const text of [target.facts[0].value, target.events[0].title, target.threads[0].detail]) {
        assert.equal(count(result.prompt, text), 1);
    }
    assert.doesNotMatch(result.prompt, /Compact continuity ledger:/u);
    assert.equal(JSON.stringify(target), before);
});

test('an entity that misses the budget cannot suppress its separately selected canon fact', () => {
    const target = world({
        entities: [entity('aster', 'Aster'), entity('beryl', 'Beryl', 'Unabridged biography. '.repeat(300))],
        facts: [fact('aster-origin', 'Aster', 'Aster keeps the red seal.'), fact('beryl-origin', 'Beryl', 'Beryl keeps the blue seal.')],
    });
    const result = buildMemoryPrompt(target, user('Aster Beryl auric covenant origin'), 128, 'chat');

    assert.doesNotMatch(result.prompt, /Unabridged biography/u);
    assert.equal(count(result.prompt, 'Aster keeps the red seal.'), 1);
    assert.equal(count(result.prompt, 'Beryl keeps the blue seal.'), 1);
});

test('a later packed entity omits canon already supplied by a fact in the first round', () => {
    const target = world({
        entities: [entity('aster', 'Aster'), entity('beryl', 'Beryl')],
        facts: [fact('aster-origin', 'Aster', 'Aster keeps the red seal.'), fact('beryl-origin', 'Beryl', 'Beryl keeps the blue seal.')],
    });
    const result = buildMemoryPrompt(target, user('Aster Beryl auric covenant origin'), 6000, 'chat');

    assert.match(result.prompt, /Beryl \(person\):/u);
    assert.equal(count(result.prompt, 'Aster keeps the red seal.'), 1);
    assert.equal(count(result.prompt, 'Beryl keeps the blue seal.'), 1);
});

test('knowledge already rendered before an entity is not repeated as inline canon', () => {
    const value = 'Aster knows the eclipse opens the lantern seal.';
    const target = world({
        scene: { participants: ['Aster'] },
        entities: [entity('aster', 'Aster')],
        facts: [fact('knowledge', 'Aster', value, { predicate: 'knowledge of the lantern seal', category: 'knowledge' })],
    });
    const result = buildMemoryPrompt(target, user('Aster examines the lantern seal.'), 6000, 'chat');

    assert.match(result.prompt, /Established character knowledge:/u);
    assert.equal(count(result.prompt, value), 1);
});

test('a full event selected but not packed retains its ledger fallback', () => {
    const target = world({ events: [
        { id: 'first', title: 'Auric covenant oath', summary: 'Aster swore the oath.', importance: 5 },
        { id: 'second', title: 'Auric covenant voyage', summary: 'Complete voyage account. '.repeat(300), importance: 3 },
    ] });
    const result = buildMemoryPrompt(target, user('Auric covenant'), 128, 'chat');

    assert.equal(result.retrievalDiagnostics.selections.filter(row => row.section === 'Past events').length, 2);
    assert.match(result.prompt, /Aster swore the oath/u);
    assert.doesNotMatch(result.prompt, /Complete voyage account/u);
    assert.match(result.prompt, /Event ledger \(latest\): Auric covenant voyage/u);
    assert.equal(count(result.prompt, 'Auric covenant oath'), 1);
});

test('unretrieved open matters keep their full unique condition and temporal anchor in the fallback ledger', () => {
    const target = world({ threads: [{
        id: 'delivery', title: 'Seal delivery', status: 'open', importance: 5,
        detail: 'Aster must deliver the blue seal tomorrow, but only if Beryl consents.',
        temporalAnchorId: 'Digest-delivery',
    }] });
    const result = buildMemoryPrompt(target, user('An unrelated quiet scene.'), 6000, 'chat');

    assert.match(result.prompt, /Open-thread ledger/u);
    assert.match(result.prompt, /tomorrow.*relative to Digest-delivery/u);
    assert.match(result.prompt, /but only if Beryl consents/u);
});

test('lossy Chronicle coverage does not suppress exact lore details or change the Chronicle', () => {
    const target = supportedWorld();
    target.capsules = [{
        id: 'digest', chatKey: 'chat', from: 0, to: 7, title: 'The covenant',
        summary: 'Aster and Beryl established a covenant.', sources: source,
    }];
    syncChronicleBase(target);
    const before = JSON.stringify(target);
    const chronicle = renderChronicleFrontier(target, 'chat');
    assert.ok(chronicle);
    const result = buildMemoryPrompt(target, user('What is Aster’s singular boundary protocol?'), 6000, 'chat');

    assert.ok(result.prompt.includes(chronicle));
    assert.ok(result.prompt.includes(target.facts[0].value));
    assert.equal(JSON.stringify(target), before);
    const changedTopic = buildMemoryPrompt(target, user('Tell me about the lunar eclipse and the lantern seal.'), 6000, 'chat');
    assert.ok(changedTopic.prompt.includes(target.facts[0].value));
});

test('similar lore with different conditions, history, or knowledge holders remains distinct', () => {
    const values = [
        'The lantern seal opens only during a lunar eclipse.',
        'The lantern seal opens only while its bearer is awake.',
        'Before the covenant, the lantern seal opened at sunrise.',
        'Aster believes the lantern seal opens at sunrise.',
        'Beryl believes the lantern seal opens at sunrise.',
    ];
    const target = world({ facts: [
        fact('eclipse', 'Lantern seal', values[0]),
        fact('awake', 'Lantern seal', values[1]),
        fact('past', 'Lantern seal', values[2]),
        fact('aster-belief', 'Aster', values[3], { category: 'character belief', predicate: 'belief about Lantern seal — opening' }),
        fact('beryl-belief', 'Beryl', values[4], { category: 'character belief', predicate: 'belief about Lantern seal — opening' }),
    ] });
    const before = JSON.stringify(target);
    const result = buildMemoryPrompt(target, user('The lantern seal opens at sunrise or a lunar eclipse while its bearer is awake?'), 6000, 'chat');

    for (const value of values) assert.ok(result.prompt.includes(value), value);
    assert.equal(JSON.stringify(target), before);
});

test('a shared batch or temporal anchor plus a name is not supporting relevance', () => {
    for (const link of [{ sources: source }, { temporalAnchorId: 'shared-anchor' }]) {
        const target = world({
            entities: [entity('aster', 'Aster')],
            relationships: [{
                id: 'protocol', from: 'Aster', to: 'Beryl', kind: 'boundary protocol',
                dynamic: 'A singular obsidian covenant governs admission.', ...link,
            }],
            facts: [fact('soup', 'Aster', 'Aster seasons chowder with saffron.', {
                predicate: 'chowder recipe', importance: 2, sources: [], ...link,
            })],
        });
        const before = JSON.stringify(target);
        const result = buildMemoryPrompt(target, user('What is the singular obsidian covenant?'), 6000, 'chat');
        assert.ok(result.retrievalDiagnostics.selections.some(row => row.id === 'protocol'));
        assert.ok(!result.retrievalDiagnostics.selections.some(row => row.section === 'Supporting continuity' && row.id === 'soup'));
        assert.doesNotMatch(result.prompt, /seasons chowder/);
        const recall = buildMemoryPrompt(target, user('How does Aster season chowder with saffron?'), 6000, 'chat');
        assert.match(recall.prompt, /Aster seasons chowder with saffron/);
        assert.equal(JSON.stringify(target), before);
    }
});

test('an explicit prerequisite reference preserves support without shared vocabulary', () => {
    const target = world({
        relationships: [{
            id: 'protocol', from: 'Aster', to: 'Beryl', kind: 'boundary protocol',
            dynamic: 'A singular obsidian covenant governs admission.', temporal: { referenceId: 'prerequisite' },
        }],
        events: [{ id: 'prerequisite', title: 'Moonrise oath', summary: 'The gatekeeper pledged silence.' }],
    });
    const result = buildMemoryPrompt(target, user('What is the singular obsidian covenant?'), 6000, 'chat');
    assert.ok(result.retrievalDiagnostics.selections.some(row => row.section === 'Supporting continuity' && row.id === 'prerequisite'));
    assert.match(result.prompt, /gatekeeper pledged silence/);
});

test('newer resolved thread suppresses old open copies in primary, support, and ledger', () => {
    const target = supportedWorld();
    const old = target.threads[0];
    target.threads.push({ ...old, id: 'closed-watch', status: 'resolved', detail: 'The second seal was found.',
        sources: [{ chatKey: 'chat', from: 8, to: 15 }] });
    const before = JSON.stringify(target);
    for (const query of ['Lunar vigil', 'What is Aster’s singular boundary protocol?', 'An unrelated quiet scene.']) {
        const result = buildMemoryPrompt(target, user(query), 6000, 'chat');
        assert.ok(!result.retrievalDiagnostics.selections.some(row => row.id === old.id));
        assert.ok(!result.prompt.includes(old.detail));
    }
    assert.equal(JSON.stringify(target), before);
});

test('a newer reopened thread remains visible after an older resolved record', () => {
    const target = world({ threads: [
        { id: 'closed', title: 'Gate inspection', detail: 'Inspection completed.', status: 'resolved', sources: source },
        { id: 'reopened', title: 'Gate inspection', detail: 'Inspect the new fracture before dawn.', status: 'open',
            sources: [{ chatKey: 'chat', from: 8, to: 15 }] },
    ] });
    const result = buildMemoryPrompt(target, user('An unrelated quiet scene.'), 6000, 'chat');
    assert.match(result.prompt, /Inspect the new fracture before dawn/);
});

test('a rendered Chronicle replaces the unconditional event recap, not exact event recall', () => {
    const target = world({
        capsules: [{ id: 'digest', chatKey: 'chat', from: 0, to: 7, title: 'Covenant',
            opening: 'Aster swore an oath.', sources: source }],
        events: [{ id: 'oath', title: 'Moonrise oath', summary: 'Aster pledged silence unless Beryl gives consent.', sources: source }],
    });
    syncChronicleBase(target);
    const before = JSON.stringify(target);
    const chronicle = renderChronicleFrontier(target, 'chat');
    assert.ok(chronicle);
    const unrelated = buildMemoryPrompt(target, user('An unrelated quiet scene.'), 6000, 'chat');
    assert.ok(unrelated.prompt.includes(chronicle));
    assert.doesNotMatch(unrelated.prompt, /Event ledger/);
    const direct = buildMemoryPrompt(target, user('What was the Moonrise oath?'), 6000, 'chat');
    assert.match(direct.prompt, /unless Beryl gives consent/);
    const disabled = buildMemoryPrompt(target, user('An unrelated quiet scene.'), 6000, 'chat', [], undefined, new Map(), { includeStorySoFar: false });
    assert.match(disabled.prompt, /Event ledger \(latest\): Moonrise oath/);
    assert.equal(JSON.stringify(target), before);
});

test('ledger budget omits whole lower-priority reminders without clipping their conditions', () => {
    const target = world({ threads: [
        { id: 'urgent', title: 'Seal delivery', detail: 'Deliver tomorrow only if Beryl consents.',
            status: 'open', importance: 5, temporalAnchorId: 'delivery-anchor' },
        { id: 'long', title: 'Secondary task', detail: `${'An extended prerequisite applies. '.repeat(300)}Only if the keeper consents.`,
            status: 'open', importance: 1 },
    ] });
    const before = JSON.stringify(target);
    const result = buildMemoryPrompt(target, user('An unrelated quiet scene.'), 128, 'chat');
    assert.match(result.prompt, /only if Beryl consents/);
    assert.match(result.prompt, /relative to delivery-anchor/);
    assert.doesNotMatch(result.prompt, /extended prerequisite/);
    assert.equal(JSON.stringify(target), before);
});
