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

test('repeated broad single-term evidence diminishes softly without excluding recall', () => {
    const target = world({
        events: [
            event('current', 'Cistern investigation plan', 'Subaru will inspect Gate 4.'),
            ...Array.from({ length: 5 }, (_, index) => event(
                `old-plan-${index}`,
                `Old plan ${index}`,
                'An unrelated historical task.',
            )),
        ],
    });
    const result = buildMemoryPrompt(target, user('cistern plan'), 5000);
    const selected = selections(result, 'Past events');
    const current = selected.find(item => item.id === 'current');
    const oldPlans = selected.filter(item => item.id.startsWith('old-plan-'));

    assert.equal(selected.length, 6);
    assert.equal(current.directDiminishingMultiplier, 1);
    assert.equal(oldPlans[0].directDiminishingMultiplier, 1);
    assert.ok(oldPlans.slice(1).every(item => item.directDiminishingMultiplier < 1));
    assert.ok(oldPlans.at(-1).directDiminishingMultiplier < oldPlans[1].directDiminishingMultiplier);
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

test('a long AI phrase can recall a supporting record from several agreeing signals', () => {
    const target = world({
        events: [
            event('deal', 'Felt sets the price', 'Samael owes her a name before the Council hears it.', ['Samael', 'Felt']),
            event('names-only', 'Street crossing', 'They pass through the capital.', ['Samael', 'Felt']),
        ],
    });
    const result = buildMemoryPrompt(target, user('Go on.'), 2000, '', [
        'Samael owes Felt a warm name before the Council hears the agreement',
    ]);
    assert.deepEqual(selections(result, 'Past events').map(item => item.id), ['deal']);
});

test('generic one-word AI expansions require corpus rarity while unique ones still recall', () => {
    const target = world({
        events: [
            ...Array.from({ length: 8 }, (_, index) => event(`agreement-${index}`, `Agreement ${index}`, 'Routine terms were recorded.')),
            event('harrowing', 'The Harrowing', 'The ordeal ended at dawn.'),
        ],
    });
    const generic = buildMemoryPrompt(target, user('Next scene.'), 3000, '', ['agreement']);
    assert.deepEqual(selections(generic, 'Past events'), []);

    const unique = buildMemoryPrompt(target, user('Next scene.'), 3000, '', ['Harrowing']);
    assert.deepEqual(selections(unique, 'Past events').map(item => item.id), ['harrowing']);
});

test('separate AI keywords need several agreeing signals instead of one broad word', () => {
    const target = world({
        events: [
            event('agreement', 'Felt sets the price', 'Samael accepts the terms.', ['Samael', 'Felt']),
            event('names-only', 'Street crossing', 'They cross the street.', ['Samael', 'Felt']),
            ...Array.from({ length: 8 }, (_, index) => event(`price-only-${index}`, `Market price ${index}`, 'A merchant updates a list.')),
        ],
    });
    const result = buildMemoryPrompt(target, user('Next scene.'), 3000, '', ['Samael', 'Felt', 'price']);
    assert.deepEqual(selections(result, 'Past events').map(item => item.id), ['agreement']);
});

test('an AI phrase can name an entity without selecting partial generic name overlap', () => {
    const target = world({
        entities: [
            { id: 'samael', name: 'Samael', aliases: [], type: 'character', description: 'A devil.' },
            { id: 'loot-house', name: "Old Man Rom's loot house", aliases: [], type: 'place', description: 'A building.' },
            { id: 'elsa', name: 'Elsa Granhiert', aliases: ['client'], type: 'character', description: 'An assassin.' },
        ],
    });
    const result = buildMemoryPrompt(target, user('Next scene.'), 3000, '', [
        'Samael accepts the deal',
        'noble house',
        'Felt considers Samael an unusually honest client',
    ]);
    assert.deepEqual(selections(result, 'Entities').map(item => item.id), ['samael']);
});

test('one multiword identity is not mistaken for both sides of a relationship', () => {
    const target = world({
        relationships: [
            { id: 'ram-subaru', from: 'Ram', to: 'Subaru Natsuki', kind: 'coworker', status: 'They work together.', dynamic: '' },
            { id: 'samael-subaru', from: 'Samael', to: 'Subaru Natsuki', kind: 'banter', status: 'They trade barbs.', dynamic: '' },
        ],
    });
    const nameOnly = buildMemoryPrompt(target, user('Go on.'), 3000, '', ['Subaru Natsuki']);
    assert.deepEqual(selections(nameOnly, 'Relationships'), []);

    const paired = buildMemoryPrompt(target, user('Go on.'), 3000, '', ['Samael and Subaru Natsuki banter']);
    assert.deepEqual(selections(paired, 'Relationships').map(item => item.id), ['samael-subaru']);
});

test('duplicate relationship variants cannot fill the relationship section', () => {
    const target = world({
        relationships: Array.from({ length: 6 }, (_, index) => ({
            id: `variant-${index}`,
            from: index % 2 ? 'Subaru Natsuki' : 'Samael',
            to: index % 2 ? 'Samael' : 'Subaru Natsuki',
            kind: `variant ${index}`,
            status: 'They remain connected.',
            dynamic: '',
        })),
    });
    const result = buildMemoryPrompt(target, user('Samael and Subaru Natsuki'), 4000);
    assert.equal(selections(result, 'Relationships').length, 3);
});

test('one multiword addressee does not retrieve every speaker address', () => {
    const target = world({
        facts: [
            { id: 'ram-subaru', subject: 'Ram', predicate: 'calls Subaru Natsuki', category: 'form of address', value: 'Barusu' },
            { id: 'samael-subaru', subject: 'Samael', predicate: 'calls Subaru Natsuki', category: 'form of address', value: 'Shrubaru' },
        ],
    });
    const nameOnly = buildMemoryPrompt(target, user('Go on.'), 3000, '', ['Subaru Natsuki']);
    assert.deepEqual(selections(nameOnly, 'Addresses'), []);

    const nickname = buildMemoryPrompt(target, user('Shrubaru'), 3000);
    assert.deepEqual(selections(nickname, 'Addresses').map(item => item.id), ['samael-subaru']);
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
