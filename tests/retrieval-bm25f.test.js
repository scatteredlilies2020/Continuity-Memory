import assert from 'node:assert/strict';
import test from 'node:test';
import { embeddingRecordKey } from '../extension/embedding-index.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';

function world(overrides = {}) {
    return {
        id: 'retrieval-test', name: 'Retrieval test', revision: 0, scene: null,
        entities: [], facts: [], states: [], relationships: [], events: [], capsules: [], arcs: [], eras: [],
        extractions: [], threads: [], backgrounds: [], corrections: [], sources: {},
        ...overrides,
    };
}

function user(mes) {
    return [{ name: 'User', is_user: true, mes }];
}

function selections(result, section) {
    return result.retrievalDiagnostics.selections.filter(item => item.section === section);
}

function event(id, title, summary, participants = []) {
    return { id, title, summary, participants, storyTime: '', consequences: '', importance: 3 };
}

test('AI expansion keeps phrases separate instead of joining one term from each phrase', () => {
    const target = world({
        events: [
            event('accidental', 'Broken mechanism', 'Repair remains possible.'),
            event('relevant', 'Repair bridge', 'The bridge repair was agreed.'),
        ],
    });
    const result = buildMemoryPrompt(target, user('Next scene.'), 2000, '', ['broken crown', 'repair bridge']);
    assert.deepEqual(selections(result, 'Past events').map(item => item.id), ['relevant']);
});

test('participant names alone do not qualify an event', () => {
    const target = world({
        events: [event('names-only', 'Market inspection', 'They reviewed the stalls.', ['Samael', 'Subaru'])],
    });
    const result = buildMemoryPrompt(target, user('Samael Subaru'), 2000);
    assert.deepEqual(selections(result, 'Past events'), []);
});

test('BM25F favors a heading match over an incidental body match', () => {
    const target = world({
        events: [
            event('heading', 'Harrowing ritual', 'The party entered the chamber.'),
            event('body', 'Archive note', 'A marginal note mentions the Harrowing.'),
            ...Array.from({ length: 10 }, (_, index) => event(`filler-${index}`, `Filler ${index}`, 'Unrelated material.')),
        ],
    });
    const result = buildMemoryPrompt(target, user('Harrowing'), 4000);
    const selected = selections(result, 'Past events');
    const heading = selected.find(item => item.id === 'heading');
    const body = selected.find(item => item.id === 'body');
    assert.ok(heading);
    assert.ok(body);
    assert.equal(selected[0].id, 'heading');
    assert.ok(heading.directScore > body.directScore);
    assert.deepEqual(heading.matchedFields.direct.heading, ['harrowing', '~harrow']);
});

test('an accurate AI phrase qualifies while a lone rare word from it does not', () => {
    const target = world({
        events: [
            event('accurate', 'Samael offers Felt a cistern lead', 'They agree to investigate it.'),
            event('rare-only', 'Drain inspection', 'The cistern is briefly mentioned.'),
        ],
    });
    const result = buildMemoryPrompt(target, user('Go on.'), 2000, '', ['Samael offers Felt a cistern lead']);
    assert.deepEqual(selections(result, 'Past events').map(item => item.id), ['accurate']);
});

test('local retrieval handles a unique term and ordinary English morphology without AI', () => {
    const target = world({
        events: [event('harrowing', 'The Harrowing', 'The ordeal ended at dawn.')],
        threads: [{ id: 'rehearsal', title: 'Weekend performance', detail: 'They plan to rehearse Saturday.', status: 'open', participants: [], importance: 3 }],
    });
    const unique = buildMemoryPrompt(target, user('Harrowing'), 2000);
    assert.deepEqual(selections(unique, 'Past events').map(item => item.id), ['harrowing']);
    assert.deepEqual(unique.retrievalDiagnostics.query.aiExpanded, []);

    const morphology = buildMemoryPrompt(target, user('What about the rehearsal?'), 2000);
    assert.deepEqual(selections(morphology, 'Open matters').map(item => item.id), ['rehearsal']);
});

test('reciprocal-rank fusion favors agreement between lexical and semantic sources', () => {
    const target = world({
        events: [
            event('agreement', 'Harrowing at the tower', 'The ordeal changed the group.'),
            event('lexical', 'Harrowing elsewhere', 'A separate ordeal occurred.'),
            event('semantic', 'Tower aftermath', 'The group recovered.'),
        ],
    });
    const semanticRanks = new Map([
        [embeddingRecordKey('event', 'semantic'), 1],
        [embeddingRecordKey('event', 'agreement'), 2],
    ]);
    const result = buildMemoryPrompt(target, user('Harrowing'), 3000, '', ['Harrowing at the tower'], undefined, semanticRanks);
    const selected = selections(result, 'Past events');
    assert.equal(selected[0].id, 'agreement');
    assert.ok(selected.find(item => item.id === 'agreement').directRank > 0);
    assert.ok(selected.find(item => item.id === 'agreement').aiExpandedRank > 0);
    assert.equal(selected.find(item => item.id === 'agreement').semanticRank, 2);
});

test('L2 is selected by relevance and is never inserted merely because it exists', () => {
    const target = world({
        arcs: [{
            id: 'arc', title: 'The Harrowing', storyTime: '', participants: [], summary: 'The ordeal changed them.',
            turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 4, capsuleIds: [],
        }],
    });
    const unrelated = buildMemoryPrompt(target, user('A quiet picnic'), 2000);
    assert.deepEqual(selections(unrelated, 'L2 continuity'), []);
    assert.doesNotMatch(unrelated.prompt, /L2 continuity:/);

    const relevant = buildMemoryPrompt(target, user('Harrowing'), 2000);
    assert.deepEqual(selections(relevant, 'L2 continuity').map(item => item.id), ['arc']);
    assert.match(relevant.prompt, /L2 continuity:/);
});
