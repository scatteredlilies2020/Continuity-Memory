import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { syncChronicleBase } from '../extension/chronicle.js';
import { resolveRetrievalAssist } from '../extension/retrieval-assist.js';

function fixture() {
    const sources = [{ chatKey: 'chat', from: 0, to: 7 }];
    const world = { id: 'context-test', entities: [], facts: [], states: [], relationships: [], events: [],
        threads: [], backgrounds: [], capsules: [], chronicle: [], corrections: [], sources: {} };
    world.capsules = [{ id: 'digest', chatKey: 'chat', from: 0, to: 7, title: 'Workshop arrival',
        chronicleText: 'The party arrived after the crossing failed.' }];
    world.entities = [{ id: 'rolf', name: 'Rolf', description: 'A village metalsmith with a silver maker stamp.', sources },
        { id: 'miravel', name: 'Miravel', description: 'A distant astronomer.', sources }];
    world.facts = [{ id: 'wedges', subject: 'Bridge', predicate: 'support condition', value: 'Copper wedges brace the eastern footing under the third beam.', sources }];
    world.states = [{ id: 'forge', subject: 'Forge', attribute: 'heat', value: 'The crucible remains warm under its insulated cover.', scope: 'ongoing', sources }];
    world.relationships = [{ id: 'training', from: 'Rolf', to: 'Jannik', dynamic: 'Rolf teaches Jannik to quench tempering steel in rainwater.', sources }];
    world.events = [{ id: 'impact', title: 'Crossing fracture', summary: 'An upstream impact cracked the west pier during the spring flood.', sources }];
    world.threads = [{ id: 'shipment', title: 'Repair material', detail: 'Rolf asked whether the copper shipment arrived from Celand.', status: 'recorded', sources }];
    world.backgrounds = [{ id: 'supply', topic: 'Ore supply', summary: 'The northern mine reported a delayed wagon at Duskford.', certainty: 'reported', sources }];
    syncChronicleBase(world);
    return world;
}
const exchange = [
    { name: 'Narrator', mes: 'Rolf is a village metalsmith. Rolf reviews the copper shipment that arrived. Copper wedges brace the eastern footing of the Bridge. The Forge crucible remains warm. Rolf teaches Jannik about quenching tempering steel. An upstream impact cracked the west pier. The northern mine reported a delayed wagon.' },
    { name: 'Visitor', is_user: true, mes: 'That is fine work.' },
];
const options = { rawTailRange: { from: 16, to: 23 } };

for (const mode of ['local', 'embedding-hybrid', 'ai-expanded']) {
    test(`${mode} uses current context and inserts all relevant detail categories beside Chronicle`, async () => {
        const world = fixture();
        const retrieval = await resolveRetrievalAssist({ mode, phase: 'generation', world, messages: exchange,
            query: async () => new Map([['fact:wedges', 1]]), expand: async () => ['copper shipment'] });
        const result = buildMemoryPrompt(world, exchange, 9000, 'chat', retrieval.terms, undefined, retrieval.ranks, options);
        for (const [id, phrase] of [['rolf','silver maker stamp'], ['wedges','third beam'], ['forge','insulated cover'],
            ['training','rainwater'], ['impact','spring flood'], ['shipment','Celand'], ['supply','Duskford']]) {
            assert.ok(result.prompt.includes(phrase), `${id} detail missing`);
            assert.ok(result.retrievalDiagnostics.selections.some(row => row.id === id && row.injected), id);
        }
        assert.match(result.prompt, /Recursive Chronicle layers/);
        assert.doesNotMatch(result.prompt, /distant astronomer/);
    });
}

test('an explicitly different topic does not retain the previous scene by context alone', () => {
    const result = buildMemoryPrompt(fixture(), [exchange[0], { is_user: true, mes: 'Tell me about Miravel.' }], 5000, 'chat', [], undefined, new Map(), options);
    assert.match(result.prompt, /distant astronomer/);
    assert.doesNotMatch(result.prompt, /Celand|Duskford|rainwater|silver maker stamp/);
});

test('names and isolated words cannot pool across sentences or older exchanges', () => {
    for (const messages of [
        [{ mes: 'Rolf met Jannik.' }, exchange[1]],
        [{ mes: 'Rolf saw copper. Rolf saw shipment.' }, exchange[1]],
        [exchange[0], { is_user: true, mes: 'Elsewhere.' }, { mes: 'Nothing happens.' }, exchange[1]],
        [{ mes: '<stat>Rolf reviews the copper shipment that arrived.</stat>Nothing happens.' }, exchange[1]],
    ]) {
        const result = buildMemoryPrompt(fixture(), messages, 5000, 'chat', [], undefined, new Map(), options);
        assert.doesNotMatch(result.prompt, /Celand|Duskford|rainwater/);
    }
});

test('the current speaker does not pull their entire inventory into local recall', () => {
    const world = fixture();
    world.entities.push({ id: 'bag', name: "Visitor's bag", description: 'INVENTORY_SENTINEL', aliases: ['bag'] });
    const result = buildMemoryPrompt(world, exchange, 5000, 'chat', [], undefined, new Map(), options);
    assert.doesNotMatch(result.prompt, /INVENTORY_SENTINEL/);
});

test('contextual matches still obey raw-tail and invalid-source exclusions', () => {
    const world = fixture();
    world.facts[0].sources = [{ chatKey: 'chat', from: 16, to: 23 }];
    world.threads[0].sources = [{ chatKey: 'chat', from: 8, to: 15 }];
    const result = buildMemoryPrompt(world, exchange, 5000, 'chat', [], undefined, new Map(), {
        ...options, invalidSourceRanges: [{ chatKey: 'chat', from: 8, to: 15 }],
    });
    assert.doesNotMatch(result.prompt, /third beam|Celand/);
});

test('AI lookup failure still uses contextual local recall', async () => {
    const retrieval = await resolveRetrievalAssist({ mode: 'ai-expanded', expand: async () => { throw new Error('provider down'); } });
    assert.equal(retrieval.assist.reason, 'ai-unavailable');
    const result = buildMemoryPrompt(fixture(), exchange, 5000, 'chat', retrieval.terms, undefined, retrieval.ranks, options);
    assert.match(result.prompt, /Celand/);
});
