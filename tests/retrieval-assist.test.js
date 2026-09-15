import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRetrievalAssist } from '../extension/retrieval-assist.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { buildEmbeddingQuery } from '../extension/embedding-index.js';
import { syncChronicleBase } from '../extension/chronicle.js';

const messages = [{ name: 'User', is_user: true, mes: 'That is fine work.' }];

test('local retrieval never calls the embedding provider', async () => {
    const result = await resolveRetrievalAssist({ mode: 'local', phase: 'generation', messages,
        query: () => assert.fail('provider must not be contacted') });
    assert.equal(result.ranks.size, 0);
    assert.equal(result.assist.fallback, false);
});

test('semantic lookup uses this world and conversation for preview and generation', async () => {
    for (const phase of ['preview', 'generation']) {
        const world = { id: 'active-world', revision: 6 };
        const ranks = new Map([['fact:condition', 1], ['thread:question', 2]]);
        const result = await resolveRetrievalAssist({ mode: 'embedding-hybrid', phase, world, messages,
            query: async (actualWorld, actualMessages, { signal }) => {
                assert.equal(actualWorld, world);
                assert.equal(actualMessages, messages);
                assert.equal(signal.aborted, false);
                return ranks;
            } });
        assert.equal(result.ranks, ranks);
        assert.equal(result.assist.mode, 'embedding-hybrid');
        assert.equal(result.assist.phase, phase);
        assert.equal(result.assist.semanticMatches, 2);
    }
});

test('provider failures and empty semantic results leave local recall available', async () => {
    const failed = await resolveRetrievalAssist({ mode: 'embedding-hybrid', query: async () => { throw new Error('index incomplete'); } });
    assert.equal(failed.ranks.size, 0);
    assert.equal(failed.assist.fallback, true);
    assert.match(failed.assist.error, /index incomplete/);
    const empty = await resolveRetrievalAssist({ mode: 'embedding-hybrid', query: async () => new Map() });
    assert.equal(empty.ranks.size, 0);
    assert.equal(empty.assist.fallback, false);
    assert.equal(empty.assist.reason, 'no-semantic-matches');
});

test('a hung provider is aborted and cannot replace the fallback after the deadline', async () => {
    let signal, finish;
    const result = await resolveRetrievalAssist({ mode: 'embedding-hybrid', timeoutMs: 10,
        query: (_world, _messages, options) => {
            signal = options.signal;
            return new Promise(resolve => { finish = resolve; });
        } });
    assert.equal(signal.aborted, true);
    assert.equal(result.assist.reason, 'embedding-timeout');
    finish(new Map([['fact:late', 1]]));
    await Promise.resolve();
    assert.equal(result.ranks.size, 0);
});

test('semantic queries use ordinary prose without stat or background-update noise', () => {
    const query = buildEmbeddingQuery([
        { is_system: true, mes: 'Hidden instruction' },
        { name: 'Narrator', mes: '<stat>unrelated inventory</stat>Rolf is forging rail clamps.<background_updates>remote battle</background_updates>' },
        ...messages,
    ]);
    assert.match(query, /Rolf is forging rail clamps/);
    assert.match(query, /That is fine work/);
    assert.doesNotMatch(query, /unrelated inventory|remote battle|Hidden instruction/);
});

function fixture() {
    const old = [{ chatKey: 'chat', from: 0, to: 7 }];
    const world = { id: 'test', entities: [], facts: [], states: [], relationships: [], events: [],
        threads: [], backgrounds: [], capsules: [], chronicle: [], corrections: [], sources: {} };
    world.capsules = [{ id: 'digest', chatKey: 'chat', from: 0, to: 7,
        title: 'Earlier repairs', chronicleText: 'The group reached the workshop after the crossing failed.' }];
    world.entities = [{ id: 'maker', name: 'Rolf', description: 'A village metalsmith.', sources: old }];
    world.facts = [{ id: 'condition', subject: 'Bridge', predicate: 'support condition', value: 'The eastern footing requires copper wedges.', sources: old }];
    world.states = [{ id: 'heat', subject: 'Forge', attribute: 'heat', value: 'The crucible remains warm.', scope: 'ongoing', sources: old }];
    world.relationships = [{ id: 'training', from: 'Rolf', to: 'Jannik', dynamic: 'Rolf teaches Jannik how to quench tempering steel.', sources: old }];
    world.events = [{ id: 'failure', title: 'Crossing failure', summary: 'An upstream impact cracked the west pier.', sources: old }];
    world.threads = [{ id: 'question', title: 'Repair material', detail: 'Rolf asked whether the copper shipment arrived.', status: 'recorded', sources: old }];
    world.backgrounds = [{ id: 'supply', topic: 'Ore supply', summary: 'The northern mine reported a delayed wagon.', certainty: 'reported', sources: old }];
    syncChronicleBase(world);
    const categories = [['entity', 'entities'], ['fact', 'facts'], ['state', 'states'], ['relationship', 'relationships'],
        ['event', 'events'], ['thread', 'threads'], ['background', 'backgrounds']];
    const ranks = new Map(categories.map(([category, collection], index) => [`${category}:${world[collection][0].id}`, index + 1]));
    return { world, ranks };
}

test('semantic categories are actually packed beside Chronicle with source safety intact', async () => {
    const { world, ranks } = fixture();
    const raw = { id: 'already-raw', subject: 'Quay', predicate: 'material', value: 'RAW_ONLY_SENTINEL', sources: [{ chatKey: 'chat', from: 16, to: 23 }] };
    const invalid = { id: 'invalid', subject: 'Canal', predicate: 'material', value: 'INVALID_SENTINEL', sources: [{ chatKey: 'chat', from: 8, to: 15 }] };
    world.facts.push(raw, invalid);
    ranks.set('fact:already-raw', 1);
    ranks.set('fact:invalid', 1);
    const retrieval = await resolveRetrievalAssist({ mode: 'embedding-hybrid', world, messages, query: async () => ranks });
    const result = buildMemoryPrompt(world, messages, 8000, 'chat', [], undefined, retrieval.ranks, {
        rawTailRange: { from: 16, to: 23 }, invalidSourceRanges: [{ chatKey: 'chat', from: 8, to: 15 }],
    });
    for (const phrase of ['A village metalsmith', 'copper wedges', 'crucible remains warm', 'quench tempering steel',
        'upstream impact cracked', 'copper shipment arrived', 'northern mine reported a delayed wagon']) assert.ok(result.prompt.includes(phrase), phrase);
    for (const key of ['entity:maker', 'fact:condition', 'state:heat', 'relationship:training', 'event:failure', 'thread:question', 'background:supply']) {
        assert.ok(result.retrievalDiagnostics.packed.some(row => row.key === key), key);
        assert.ok(result.retrievalDiagnostics.selections.some(row => `${row.category}:${row.id}` === key && row.injected), key);
    }
    assert.match(result.prompt, /Recursive Chronicle layers/);
    assert.match(result.prompt, /The group reached the workshop after the crossing failed/);
    assert.doesNotMatch(result.prompt, /RAW_ONLY_SENTINEL|INVALID_SENTINEL/);
});

test('packing diagnostics do not claim every selected candidate was injected', () => {
    const { world } = fixture();
    world.facts = Array.from({ length: 8 }, (_, i) => ({ id: `detail-${i}`, subject: `Device ${i}`, predicate: 'design', value: `UNIQUE_${i} ${'full condition '.repeat(60)}` }));
    const ranks = new Map(world.facts.map((fact, i) => [`fact:${fact.id}`, i + 1]));
    const result = buildMemoryPrompt(world, messages, 128, 'chat', [], undefined, ranks);
    const selections = result.retrievalDiagnostics.selections.filter(row => row.id.startsWith('detail-'));
    assert.ok(selections.some(row => row.injected));
    assert.ok(selections.some(row => !row.injected));
    for (const row of selections) assert.equal(result.prompt.includes(`UNIQUE_${row.id.slice(7)}`), row.injected);
});


test('semantic results do not turn old titles and names into a new retrieval query', () => {
    const world = { entities: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [], corrections: [],
        capsules: [{ id: 'old-scene', chatKey: 'chat', from: 0, to: 7, title: 'Forgotten coronation banquet',
            participants: ['Duke Aster', 'Lady Beryl'], chronicleText: 'A coronation happened long ago.' }], chronicle: [] };
    world.threads = [{ id: 'unrelated-plan', title: 'Coronation banquet arrangements', detail: 'The duke wanted a feast.', status: 'recorded' }];
    syncChronicleBase(world);
    const result = buildMemoryPrompt(world, messages, 4000, 'chat', [], undefined, new Map([['capsule:old-scene', 1]]));
    assert.deepEqual(result.retrievalDiagnostics.query.aiExpanded, []);
    assert.doesNotMatch(result.prompt, /The duke wanted a feast/);
    assert.ok(!result.retrievalDiagnostics.selections.some(row => row.id === 'unrelated-plan'));
});

test('AI mode expands the conversation without querying embeddings or writing memory', async () => {
    const world = { id: 'world', revision: 8 };
    const result = await resolveRetrievalAssist({ mode: 'ai-expanded', phase: 'generation', world, messages,
        query: () => assert.fail('AI mode must not call embeddings'),
        expand: async (conversation, { signal }) => {
            assert.equal(conversation, messages);
            assert.equal(signal.aborted, false);
            return ['copper wedges', 'Rolf smithy production'];
        } });
    assert.deepEqual(result.terms, ['copper wedges', 'Rolf smithy production']);
    assert.equal(result.ranks.size, 0);
    assert.equal(result.assist.mode, 'ai-expanded');
    assert.deepEqual(world, { id: 'world', revision: 8 });
});

test('timed-out AI expansion never injects late search phrases', async () => {
    let finish, signal;
    const result = await resolveRetrievalAssist({ mode: 'ai-expanded', timeoutMs: 10,
        expand: (_messages, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
    assert.equal(result.assist.reason, 'ai-timeout');
    assert.equal(signal.aborted, true);
    finish(['late phrase']);
    await Promise.resolve();
    assert.deepEqual(result.terms, []);
});
