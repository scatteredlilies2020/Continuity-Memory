import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildEmbeddingDocuments,
    buildEmbeddingQuery,
    embeddingAnchorText,
    semanticRanksFromResponse,
    stableEmbeddingHash,
} from '../extension/embedding-index.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';

function sampleWorld() {
    return {
        id: 'world-one',
        revision: 3,
        scene: null,
        entities: [{ id: 'entity-alice', name: 'Alice', type: 'person', aliases: ['Al'], description: 'A careful pilot.', importance: 4 }],
        facts: [{ id: 'fact-lantern', subject: 'Alice', predicate: 'hid', value: 'the silver lantern beneath the pier', persistence: 'persistent', importance: 4 }],
        states: [],
        relationships: [],
        events: [{ id: 'event-lantern', title: 'The concealed lantern', summary: 'Alice hid the silver lantern beneath the pier.', participants: ['Alice'], importance: 4 }],
        threads: [
            { id: 'thread-open', title: 'Recover the lantern', detail: 'Alice intends to retrieve it.', participants: ['Alice'], status: 'open', importance: 4 },
            { id: 'thread-resolved', title: 'Buy rope', detail: 'Already completed.', status: 'resolved', importance: 2 },
        ],
        backgrounds: [{ id: 'background-qing', topic: 'Qing White Lotus suppression', summary: 'Provincial militias are expanding.', status: 'active', certainty: 'reported', participants: ['Qing China'], importance: 2 }],
        capsules: [],
        arcs: [],
        eras: [],
    };
}

test('builds stable embedding documents from canonical structured records only', () => {
    const world = sampleWorld();
    const first = buildEmbeddingDocuments(world);
    const second = buildEmbeddingDocuments(structuredClone(world));
    assert.deepEqual(first, second);
    assert.ok(first.some(document => document.key === 'event:event-lantern'));
    assert.ok(first.some(document => document.key === 'thread:thread-open'));
    assert.ok(first.some(document => document.key === 'background:background-qing'));
    assert.ok(!first.some(document => document.key === 'thread:thread-resolved'));
    assert.ok(first.every(document => !document.text.includes('world-one')));
    assert.equal(stableEmbeddingHash('same text'), stableEmbeddingHash('same text'));
});

test('embedding query uses only the configured recent non-system messages', () => {
    const messages = [
        { name: 'System', mes: 'Do not include this.', is_system: true },
        { name: 'Alice', mes: 'first' },
        { name: 'Bob', mes: 'second' },
        { name: 'Alice', mes: 'third' },
        { name: 'Bob', mes: 'fourth' },
        { name: 'Alice', mes: 'fifth' },
    ];
    const query = buildEmbeddingQuery(messages, 4, 6000);
    assert.ok(!query.includes('Do not include this'));
    assert.ok(!query.includes('first'));
    assert.ok(query.includes('second'));
    assert.ok(query.includes('fifth'));
});

test('maps filtered vector metadata ranks back to current record IDs', () => {
    const documents = buildEmbeddingDocuments(sampleWorld());
    const event = documents.find(document => document.key === 'event:event-lantern');
    const entity = documents.find(document => document.key === 'entity:entity-alice');
    const ranks = semanticRanksFromResponse({
        hashes: [999999, event.hash, entity.hash],
        metadata: [{ hash: event.hash }, { hash: entity.hash }],
    }, documents);
    assert.deepEqual([...ranks.entries()], [['event:event-lantern', 1], ['entity:entity-alice', 2]]);
});

test('respects an empty threshold-filtered metadata result', () => {
    const documents = buildEmbeddingDocuments(sampleWorld());
    const ranks = semanticRanksFromResponse({
        hashes: documents.map(document => document.hash),
        metadata: [],
    }, documents);
    assert.equal(ranks.size, 0);
});

test('embedding hits retrieve canonical memory and expand structured anchor terms', () => {
    const world = sampleWorld();
    const semanticRanks = new Map([['event:event-lantern', 1]]);
    const local = buildMemoryPrompt(world, [{ name: 'Bob', mes: 'Tell me about the weather.' }], 3000, '', [], undefined, new Map());
    const hybrid = buildMemoryPrompt(world, [{ name: 'Bob', mes: 'Tell me about the weather.' }], 3000, '', [], undefined, semanticRanks);
    assert.ok(!local.prompt.includes('silver lantern'));
    assert.ok(hybrid.prompt.includes('silver lantern'));
    assert.match(embeddingAnchorText(world, semanticRanks), /Alice/);
});
