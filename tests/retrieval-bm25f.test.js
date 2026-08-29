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

test('noncanonical claim categories are retrieved only as subjective perspectives', () => {
    const target = world({
        facts: [{
            id: 'claim-apprentice', subject: 'Lucas Alcazar', predicate: 'claim about Caelen Veyr — former apprentice',
            value: 'Lucas claims Caelen Veyr trained him as a Jedi apprentice.', category: 'character claim',
            persistence: 'persistent', importance: 4,
        }],
    });

    const result = buildMemoryPrompt(target, user('Lucas Alcazar and Caelen Veyr'), 3000);

    assert.equal(selections(result, 'Facts').length, 0);
    assert.deepEqual(selections(result, 'Character perspectives (not established facts)').map(item => item.id), ['claim-apprentice']);
    assert.match(result.prompt, /\[subjective; not an established fact\]/u);
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
    assert.equal(selections(result, 'Relationships').length, 1);
});

test('relationship retrieval is neutral and puts its description before type and status', () => {
    const target = world({
        relationships: [{
            id: 'lucas-segundus', from: 'Lucas Alcazar', to: 'Darth Segundus', kind: 'Sith master and apprentice',
            status: 'active', dynamic: 'Lucas is Darth Segundus’s Sith apprentice and has arrived to report to his master.',
        }],
    });
    const result = buildMemoryPrompt(target, user('Lucas reports to Darth Segundus.'), 3000);

    assert.match(result.prompt, /Lucas Alcazar ↔ Darth Segundus: Description: Lucas is Darth Segundus’s Sith apprentice.*Type: Sith master and apprentice\. Status: active\./);
    assert.doesNotMatch(result.prompt, /Lucas Alcazar → Darth Segundus/);
    assert.match(result.prompt, /Relationship ↔ has no directional role/);
    assert.match(selections(result, 'Relationships')[0].label, /Lucas Alcazar ↔ Darth Segundus/);
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

test('open threads remain visible when the current message changes topics', () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({
        id: `thread-${index}`,
        title: index === 7 ? 'Deliver the kyber to Segundus' : `Unresolved matter ${index}`,
        detail: index === 7
            ? 'Lucas will visit Darth Segundus at the palace within three days.'
            : `A separate commitment remains unresolved for person ${index}.`,
        status: 'open',
        participants: index === 7 ? ['Lucas', 'Darth Segundus'] : [`Person ${index}`],
        importance: index === 11 ? 1 : 4,
        updatedAt: new Date(2026, 0, index + 1).toISOString(),
    }));
    const result = buildMemoryPrompt(world({ threads }), user('Toska practices alone in the training hall.'), 4000);
    const selected = selections(result, 'Open matters').map(item => item.id);

    assert.deepEqual(selected, []);
    assert.match(result.prompt, /Lucas will visit Darth Segundus at the palace within three days/);
    assert.match(result.prompt, /Compact continuity ledger:[\s\S]*Open-thread ledger \(latest\):/);
});

test('strong completed events remain in the compact ledger when the current message changes topics', () => {
    const target = world({
        events: [event('old-duel', 'Duel at the moonbase', 'Lucas defeated Caelen and kept the kyber crystal.')],
    });
    const result = buildMemoryPrompt(target, user('Toska quietly practices breathing exercises.'), 3000);

    assert.deepEqual(selections(result, 'Past events'), []);
    assert.match(result.prompt, /Compact continuity ledger:[\s\S]*Event ledger \(latest\): Duel at the moonbase/);
    assert.doesNotMatch(result.prompt, /kept the kyber crystal/);
});

test('the compact ledger collapses typographic duplicate thread titles', () => {
    const target = world({ threads: [
        { id: 'curly', title: 'Toska’s transformation', detail: 'First wording.', status: 'open', importance: 4 },
        { id: 'straight', title: "Toska's transformation", detail: 'Duplicate wording.', status: 'open', importance: 4 },
    ] });
    const result = buildMemoryPrompt(target, user('An unrelated quiet moment.'), 3000);
    const ledger = result.prompt.match(/Open-thread ledger \(latest\): ([^\n]+)/)?.[1] || '';

    assert.equal((ledger.match(/wording/gu) || []).length, 1);
});

test('duplicate open-thread wording always uses the newest canonical record', () => {
    const target = world({ threads: [
        { id: 'old', title: 'Audience confrontation', detail: 'Lucas is still traveling.', status: 'open', importance: 4, updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'new', title: 'Audience confrontation', detail: 'Segundus must answer Lucas after the proof is presented.', status: 'open', importance: 4, updatedAt: '2026-01-02T00:00:00Z' },
    ] });
    const result = buildMemoryPrompt(target, user('What about the audience confrontation?'), 3000);

    assert.deepEqual(selections(result, 'Open matters').map(item => item.id), ['new']);
    assert.match(result.prompt, /OPEN — Segundus must answer Lucas/);
    assert.doesNotMatch(result.prompt, /still traveling/);
});

test('an open-thread ledger uses the current unresolved description instead of a fulfilled title', () => {
    const target = world({ threads: [{
        id: 'identity', title: 'Determine Toska’s master’s true identity', status: 'open', importance: 4,
        detail: 'Caelen Veyr’s identity is established; why he concealed Toska’s potential remains unresolved.',
    }] });
    const result = buildMemoryPrompt(target, user('An unrelated palace scene.'), 3000);
    const ledger = result.prompt.match(/Open-thread ledger \(latest\): ([^\n]+)/)?.[1] || '';

    assert.match(ledger, /Caelen Veyr’s identity is established/);
    assert.doesNotMatch(ledger, /Determine Toska’s master’s true identity/);
});

test('a pending raw tail prevents an older stored scene from focusing unrelated knowledge', () => {
    const target = world({
        scene: {
            participants: ['Toska', 'Sith Temple basin'], activity: 'Toska trains with the Sith Temple basin.',
            sources: [{ chatKey: 'chat', from: 160, to: 167 }],
        },
        facts: [{
            id: 'basin-knowledge', subject: 'Toska', predicate: 'knowledge of Sith Temple basin',
            value: 'Toska knows how the basin responds.', category: 'knowledge', persistence: 'persistent', importance: 4,
            sources: [{ chatKey: 'chat', from: 160, to: 167 }],
        }],
    });
    const result = buildMemoryPrompt(target, user('Lucas enters Darth Segundus’s palace audience.'), 3000, 'chat', [], undefined, new Map(), {
        includeSceneCheckpoint: false,
        rawTailRange: { from: 176, to: 181 },
    });

    assert.deepEqual(selections(result, 'Established character knowledge'), []);
    assert.doesNotMatch(result.prompt, /Toska knows how the basin responds/);
});

test('raw-tail threads and events retain only neutral latest ledger titles', () => {
    const source = [{ chatKey: 'chat', from: 8, to: 15 }];
    const target = world({
        threads: [{ id: 'thread', title: 'Audience confrontation', detail: 'Potentially duplicated raw detail.', status: 'open', importance: 4, sources: source }],
        events: [{ ...event('arrival', 'Palace arrival', 'Potentially duplicated raw summary.'), sources: source }],
    });
    const result = buildMemoryPrompt(target, user('Continue.'), 3000, 'chat', [], undefined, new Map(), {
        rawTailRange: { from: 8, to: 15 },
    });

    assert.deepEqual(selections(result, 'Open matters'), []);
    assert.deepEqual(selections(result, 'Past events'), []);
    assert.match(result.prompt, /Open-thread ledger \(latest\): Audience confrontation/);
    assert.match(result.prompt, /Event ledger \(latest\): Palace arrival/);
    assert.doesNotMatch(result.prompt, /Potentially duplicated raw/);
});

test('English grammar forms cannot become rare retrieval anchors', () => {
    const grammarOnly = world({
        events: [event('return', 'Routine movement', "She'll return after lunch.")],
    });
    const weak = buildMemoryPrompt(grammarOnly, user("She’ll do it."), 2000);
    assert.deepEqual(selections(weak, 'Past events'), []);
    assert.ok(!weak.retrievalDiagnostics.query.direct.includes("she'll"));

    const negation = buildMemoryPrompt(grammarOnly, user("I didn’t. Never."), 2000);
    assert.deepEqual(selections(negation, 'Past events'), []);
    assert.deepEqual(negation.retrievalDiagnostics.query.direct, []);

    const meaningful = world({
        events: [event('stationer', 'Stationer departure', "She'll visit the stationer.")],
    });
    const specific = buildMemoryPrompt(meaningful, user("She’ll visit the stationer."), 2000);
    assert.deepEqual(selections(specific, 'Past events').map(item => item.id), ['stationer']);
});

test('possessives and hyphenated English forms retain their meaningful words', () => {
    const target = world({
        events: [
            event('harrowing', 'The Harrowing', 'The ordeal changed them.'),
            event('collar', 'Collar straightening', 'The uniform was corrected before departure.'),
        ],
    });
    const possessive = buildMemoryPrompt(target, user("Harrowing’s"), 2000);
    assert.deepEqual(selections(possessive, 'Past events').map(item => item.id), ['harrowing']);

    const compound = buildMemoryPrompt(target, user('collar-straightening'), 2000);
    assert.deepEqual(selections(compound, 'Past events').map(item => item.id), ['collar']);
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

test('legacy hierarchy arrays remain inert even when query-relevant', () => {
    const target = world({
        arcs: [{
            id: 'arc', title: 'The Harrowing', storyTime: '', participants: [], summary: 'The ordeal changed them.',
            turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 4, capsuleIds: [],
        }],
    });
    const relevant = buildMemoryPrompt(target, user('Harrowing'), 2000);
    assert.doesNotMatch(relevant.prompt, /The Harrowing|The ordeal changed them/);
    assert.equal(relevant.retrievalDiagnostics.selections.some(item => item.id === 'arc'), false);
});

test('story so far is injected from its independent rolling stream, never hierarchy records', () => {
    const target = world({
        storySoFar: { chat: { text: 'Mara left home, found Ivo, and together they reached the flooded city.', from: 0, to: 79 } },
        capsules: [{ id: 'l1-secret', title: 'Internal L1 wording', opening: '', beats: [], closing: 'Must not enter overview.', chatKey: 'chat', from: 0, to: 7 }],
        arcs: [{ id: 'legacy-arc', title: 'Internal old hierarchy wording', summary: 'Must not enter overview.', capsuleIds: [] }],
        eras: [{ id: 'legacy-era', title: 'Internal older hierarchy wording', summary: 'Must not enter overview.', arcIds: [] }],
    });

    const result = buildMemoryPrompt(target, user('A quiet unrelated moment.'), 4000, 'chat');
    const overview = result.prompt.match(/Story so far:\n([\s\S]*?)(?:\n\n|<\/continuity>)/)?.[1] || '';
    assert.match(overview, /Mara left home/);
    assert.doesNotMatch(overview, /Internal (?:old|older) hierarchy wording/);
    assert.deepEqual(selections(result, 'Story so far'), []);

    const disabled = buildMemoryPrompt(target, user('A quiet unrelated moment.'), 4000, 'chat', [], undefined, new Map(), { includeStorySoFar: false });
    assert.doesNotMatch(disabled.prompt, /Story so far/);
});

test('story-so-far allowance is additive and cannot displace existing recall', () => {
    const facts = Array.from({ length: 12 }, (_, index) => ({
        id: `signal-${index}`,
        subject: 'Mara',
        predicate: `signal protocol ${index}`,
        value: `Signal protocol detail ${index} remains operational and relevant.`,
        category: 'system rule',
        persistence: 'persistent',
        importance: 4,
        sources: [{ chatKey: 'chat', from: index, to: index }],
    }));
    const target = world({
        facts,
        storySoFar: { chat: { text: 'Mara crossed the frontier and established the signal network.', from: 0, to: 95 } },
    });
    const options = { includeStorySoFar: true, storySoFarTokens: 256 };
    const enabled = buildMemoryPrompt(target, user('Mara checks every signal protocol.'), 1000, 'chat', [], undefined, new Map(), options);
    const disabled = buildMemoryPrompt(target, user('Mara checks every signal protocol.'), 1000, 'chat', [], undefined, new Map(), { includeStorySoFar: false });

    assert.equal(enabled.prompt.replace(/\nStory so far:\n.*\n/u, ''), disabled.prompt);
    assert.deepEqual(enabled.retrievalDiagnostics.selections, disabled.retrievalDiagnostics.selections);
    assert.ok(enabled.estimatedTokens > disabled.estimatedTokens);
    assert.ok(enabled.prompt.indexOf('Story so far:') > enabled.prompt.indexOf('Facts:'));
    assert.match(enabled.prompt, /Story so far:\n[^\n]+\n<\/continuity>$/u);
});

test('Story injection preserves its complete ending instead of applying a hidden three-thousand-token prefix cap', () => {
    const premise = 'Premise: ' + 'foundational cause '.repeat(850);
    const ending = 'Open matters: Mara must choose whether to reveal the signal before dawn.';
    const completeStory = `${premise}\n${ending}`;
    const target = world({ storySoFar: { chat: { text: completeStory, from: 0, to: 95 } } });

    const result = buildMemoryPrompt(target, user('Continue.'), 1000, 'chat', [], undefined, new Map(), {
        includeStorySoFar: true,
        storySoFarTokens: 6000,
    });

    assert.match(result.prompt, /Mara must choose whether to reveal the signal before dawn/);
    assert.doesNotMatch(result.prompt, /…/u);
});

test('a deliberately small recall target soft-overflows to preserve a complete category row', () => {
    const target = world({
        facts: Array.from({ length: 20 }, (_, index) => ({
            id: `compact-${index}`, subject: 'Mara', predicate: `rule ${index}`, value: `Compact rule detail ${index}.`,
            category: 'rule', persistence: 'persistent', importance: 3, sources: [{ chatKey: 'chat', from: index, to: index }],
        })),
    });
    const result = buildMemoryPrompt(target, user('Mara reviews every rule.'), 128, 'chat', [], undefined, new Map(), { includeStorySoFar: false });
    assert.ok(result.estimatedTokens < 1000);
    assert.ok(result.estimatedTokens > 128);
    assert.match(result.prompt, /Facts:/);
    assert.match(result.prompt, /Compact rule detail \d+\./u);
    assert.doesNotMatch(result.prompt, /…/u);
    assert.match(result.prompt, /^<continuity>/);
    assert.match(result.prompt, /<\/continuity>$/);
});

test('tight recall targets present every populated selected category without clipping its representative', () => {
    const source = [{ chatKey: 'chat', from: 8, to: 15 }];
    const target = world({
        entities: [{ id: 'entity', name: 'Mara', type: 'person', description: 'Beacon keeper COMPLETE_ENTITY_END', sources: source }],
        facts: [{
            id: 'fact', subject: 'Mara', predicate: 'beacon oath', value: 'Keeps the beacon lit COMPLETE_FACT_END',
            category: 'duty', persistence: 'persistent', importance: 4, sources: source,
        }],
        states: [{ id: 'state', subject: 'Mara', attribute: 'beacon watch', value: 'On duty COMPLETE_STATE_END', scope: 'scene', sources: source }],
        relationships: [{
            id: 'relationship', from: 'Mara', to: 'Ivo', kind: 'beacon allies', status: 'active',
            dynamic: 'Guard the beacon together COMPLETE_RELATIONSHIP_END', sources: source,
        }],
        events: [{ id: 'event', title: 'Beacon lighting', summary: 'Mara lit the beacon COMPLETE_EVENT_END', participants: ['Mara'], sources: source }],
        capsules: [{
            id: 'capsule', title: 'Beacon watch', opening: 'Mara arrived', beats: ['She lit it'],
            closing: 'Watch continues COMPLETE_L1_END', emotionalArc: '', chatKey: 'chat', from: 8, to: 15, sources: source,
        }],
        threads: [{
            id: 'thread', title: 'Beacon fuel', detail: 'Mara must secure fuel COMPLETE_THREAD_END',
            status: 'open', participants: ['Mara'], sources: source,
        }],
        backgrounds: [{
            id: 'background', topic: 'Beacon history', summary: 'Mara inherited the duty COMPLETE_BACKGROUND_END',
            status: 'active', certainty: 'established', participants: ['Mara'], sources: source,
        }],
        corrections: [{ id: 'correction', summary: 'Mara—not Ivo—first lit the beacon COMPLETE_CORRECTION_END' }],
    });

    const result = buildMemoryPrompt(target, user('Mara checks the beacon.'), 128, 'chat', [], undefined, new Map(), { includeStorySoFar: false });

    for (const section of [
        'User corrections', 'Recent continuity', 'Open matters',
        'Background', 'Entities', 'Current state', 'Relationships', 'Facts', 'Past events',
    ]) assert.match(result.prompt, new RegExp(`\\n${section}:\\n`, 'u'));
    for (const ending of [
        'COMPLETE_CORRECTION_END', 'COMPLETE_L1_END',
        'COMPLETE_THREAD_END', 'COMPLETE_BACKGROUND_END', 'COMPLETE_ENTITY_END', 'COMPLETE_STATE_END',
        'COMPLETE_RELATIONSHIP_END', 'COMPLETE_FACT_END', 'COMPLETE_EVENT_END',
    ]) assert.match(result.prompt, new RegExp(ending, 'u'));
    assert.ok(result.estimatedTokens > 128);
    assert.doesNotMatch(result.prompt, /…/u);
});

test('user corrections are injected whole instead of being character-sliced', () => {
    const completeEnding = 'COMPLETE_CORRECTION_AFTER_900_CHARACTERS';
    const target = world({ corrections: [{ id: 'long-correction', summary: `${'Authoritative correction detail. '.repeat(40)}${completeEnding}` }] });

    const result = buildMemoryPrompt(target, user('Continue.'), 128, 'chat', [], undefined, new Map(), { includeStorySoFar: false });

    assert.match(result.prompt, new RegExp(completeEnding, 'u'));
    assert.doesNotMatch(result.prompt, /…/u);
});

test('older L1 evidence must occur within one beat or neighboring beats', () => {
    const capsule = (id, from, title, passages) => ({
        id,
        chatKey: 'chat',
        from,
        to: from + 7,
        title,
        storyTime: '',
        location: '',
        participants: ['Rem', 'Samael'],
        opening: passages[0],
        beats: passages.slice(1, -1),
        emotionalArc: '',
        closing: passages.at(-1),
        importance: 3,
    });
    const target = world({
        capsules: [
            capsule('scattered', 10, 'Balcony investigation', [
                'A black cord was found beneath the latch.',
                'The witness described a hurried escape.',
                'A gold crest appeared in an old inventory.',
                'Rain delayed the search.',
                'A discarded cloak was recovered elsewhere.',
            ]),
            capsule('adjacent', 20, 'Preparing to depart', [
                'Rem lifted her black traveling cloak from the chair.',
                'Samael fastened its blue cord beside the Mathers crest.',
                'They prepared to leave together.',
            ]),
            capsule('latest-1', 30, 'Later scene one', ['They crossed the hall.']),
            capsule('latest-2', 40, 'Later scene two', ['They checked the carriage.']),
            capsule('latest-3', 50, 'Current scene', ['They waited by the door.']),
        ],
    });
    const result = buildMemoryPrompt(target, user('Continue.'), 4000, '', [
        'Samael hands Rem her black traveling cloak with a blue cord and Mathers crest',
    ], 'chat');
    const querySelected = selections(result, 'Recent continuity')
        .filter(item => item.reason !== 'latest L1');

    assert.deepEqual(querySelected.map(item => item.id), ['adjacent']);
    assert.equal(querySelected[0].passageLocalized, true);
});

test('selected memories retrieve their supporting history without vocabulary-specific rules', () => {
    const firstSource = [{ chatKey: 'chat', from: 10, to: 17 }];
    const secondSource = [{ chatKey: 'chat', from: 26, to: 33 }];
    const target = world({
        relationships: [{
            id: 'covenant', from: 'Aster', to: 'Beryl', kind: 'auric covenant', status: 'active',
            dynamic: 'They currently observe a singular boundary protocol.',
            sources: [...firstSource, ...secondSource], importance: 4,
        }],
        facts: [
            {
                id: 'origin', subject: 'Aster', predicate: 'auric covenant for Beryl',
                value: 'They share the lantern watch and preserve each other’s agency.', sources: firstSource, importance: 4,
            },
            {
                id: 'amendment', subject: 'Beryl', predicate: 'vellum covenant amendment with Aster',
                value: 'She requires a report after any protective intervention.', sources: secondSource, importance: 3,
            },
            {
                id: 'lexical-support', subject: 'Aster', predicate: 'lumenwrit safeguard for Beryl',
                value: 'Neither partner may silently replace the other’s choice.', importance: 3,
            },
            {
                id: 'unrelated', subject: 'Aster', predicate: 'picnic with Beryl',
                value: 'They packed cake for a quiet afternoon.', importance: 3,
            },
            ...Array.from({ length: 10 }, (_, index) => ({
                id: `filler-${index}`, subject: `Witness ${index}`, predicate: 'keeps an ordinary record',
                value: 'A separate matter with no connection.', importance: 1,
            })),
        ],
    });
    target.relationships[0].kind = 'lumenwrit auric covenant';

    const result = buildMemoryPrompt(target, user('What is the current singular boundary protocol?'), 2000, 'chat');
    const support = selections(result, 'Supporting continuity');
    const supportIds = support.map(item => item.id);

    assert.deepEqual(selections(result, 'Relationships').map(item => item.id), ['covenant']);
    assert.ok(supportIds.includes('origin'));
    assert.ok(supportIds.includes('amendment'));
    assert.ok(supportIds.includes('lexical-support'));
    assert.ok(!supportIds.includes('unrelated'));
    assert.match(result.prompt, /Supporting continuity:/);
});

test('source-history support receives priority when the continuity budget is tight', () => {
    const firstSource = [{ chatKey: 'chat', from: 40, to: 47 }];
    const secondSource = [{ chatKey: 'chat', from: 72, to: 79 }];
    const target = world({
        relationships: [{
            id: 'accord', from: 'Neris', to: 'Orin', kind: 'vesper sigilword accord', status: 'active',
            dynamic: 'A current obsidian boundary remains in force.', sources: [...firstSource, ...secondSource],
        }],
        facts: [
            { id: 'foundation', subject: 'Neris', predicate: 'vesper accord with Orin', value: 'The first condition.', sources: firstSource },
            { id: 'revision', subject: 'Orin', predicate: 'vesper accord with Neris', value: 'The later revision.', sources: secondSource },
            ...Array.from({ length: 4 }, (_, index) => ({
                id: `loose-${index}`, subject: 'Neris', predicate: `sigilword note for Orin ${index}`,
                value: `A disconnected supporting observation ${index}.`,
            })),
            ...Array.from({ length: 24 }, (_, index) => ({
                id: `filler-${index}`, subject: `Archivist ${index}`, predicate: 'files a routine notice',
                value: 'An unrelated administrative matter.',
            })),
        ],
    });

    const result = buildMemoryPrompt(target, user('What is the current obsidian boundary?'), 1000, 'chat');
    const supportIds = selections(result, 'Supporting continuity').map(item => item.id);

    assert.ok(supportIds.indexOf('foundation') >= 0);
    assert.ok(supportIds.indexOf('revision') >= 0);
    const firstLooseIndex = supportIds.findIndex(id => id.startsWith('loose-'));
    assert.ok(firstLooseIndex >= 0);
    assert.ok(supportIds.indexOf('foundation') < firstLooseIndex);
    assert.ok(supportIds.indexOf('revision') < firstLooseIndex);
});

test('support depth treats the configured budget as a ceiling instead of a fill target', () => {
    const target = world({
        relationships: [{
            id: 'accord', from: 'Neris', to: 'Orin', kind: 'vesper sigilword accord', status: 'active',
            dynamic: 'The current obsidian boundary remains in force.',
            sources: [{ chatKey: 'chat', from: 20, to: 27 }],
        }],
        facts: Array.from({ length: 40 }, (_, index) => ({
            id: `support-${index}`, subject: 'Neris', predicate: `vesper sigilword note for Orin ${index}`,
            value: `A separate supporting condition numbered ${index}.`, importance: 3,
            sources: [{ chatKey: 'chat', from: 20, to: 27 }],
        })),
    });

    const automaticBaseline = buildMemoryPrompt(target, user('What is the current obsidian boundary?'), 10000);
    const largerCustomBudget = buildMemoryPrompt(target, user('What is the current obsidian boundary?'), 12800);
    const baselineSupport = selections(automaticBaseline, 'Supporting continuity');
    const customSupport = selections(largerCustomBudget, 'Supporting continuity');

    assert.ok(baselineSupport.length > 0);
    assert.ok(baselineSupport.length < Math.ceil(10000 / 80));
    assert.ok(customSupport.length >= baselineSupport.length);
    assert.ok(customSupport.length < Math.ceil(12800 / 80));
});

test('one relevant AI seed cannot fan out across the entire support budget', () => {
    const target = world({
        threads: [{
            id: 'old-visit', title: 'Prepare the village visit', status: 'open',
            detail: 'Aster and Beryl will visit the village tomorrow.', participants: ['Aster', 'Beryl'],
        }],
        facts: Array.from({ length: 50 }, (_, index) => ({
            id: `village-${index}`, subject: 'Aster', predicate: `village preparation with Beryl ${index}`,
            value: `They prepared ordinary visit detail ${index}.`, importance: 2,
        })),
    });

    const result = buildMemoryPrompt(
        target,
        user('Next.'),
        20000,
        '',
        ['Aster and Beryl prepare the village visit', 'stationer errand'],
    );
    const support = selections(result, 'Supporting continuity');

    assert.deepEqual(selections(result, 'Open matters').map(item => item.id), ['old-visit']);
    assert.ok(support.length < 10);
    assert.ok(support.length < Math.ceil(20000 / 80));
});

test('AI-selected relationships retrieve only independently relevant support regardless of importance', () => {
    const source = [{ chatKey: 'chat', from: 12, to: 19 }];
    const target = world({
        relationships: [{
            id: 'banter', from: 'Aster', to: 'Beryl', kind: 'playful banter',
            status: 'They trade a brief joke while working.', importance: 2, sources: source,
        }],
        facts: [{
            id: 'old-history', subject: 'Aster', predicate: 'old expedition with Beryl',
            value: 'They previously crossed the northern pass.', importance: 3, sources: source,
        }, {
            id: 'banter-history', subject: 'Aster', predicate: 'playful banter with Beryl',
            value: 'Their jokes help them keep working through tense tasks.', importance: 1, sources: source,
        }],
    });
    const incidental = buildMemoryPrompt(target, user('Next.'), 10000, 'chat', ['Aster and Beryl trade playful banter']);
    const incidentalSupport = selections(incidental, 'Supporting continuity').map(item => item.id);

    assert.deepEqual(selections(incidental, 'Relationships').map(item => item.id), ['banter']);
    assert.ok(incidentalSupport.includes('banter-history'));
    assert.ok(!incidentalSupport.includes('old-history'));

    target.relationships[0].importance = 4;
    const rerated = buildMemoryPrompt(target, user('Next.'), 10000, 'chat', ['Aster and Beryl trade playful banter']);
    assert.deepEqual(
        selections(rerated, 'Supporting continuity').map(item => item.id),
        incidentalSupport,
    );
});

test('AI-selected relationships may recover history bridged by rare recent context', () => {
    const source = [{ chatKey: 'chat', from: 12, to: 19 }];
    const target = world({
        relationships: [{
            id: 'banter', from: 'Aster', to: 'Beryl', kind: 'playful banter',
            status: 'They trade a brief joke while working.', importance: 2, sources: source,
        }],
        facts: [{
            id: 'pass-history', subject: 'Aster', predicate: 'expedition with Beryl',
            value: 'They previously crossed the northern pass together.', importance: 3, sources: source,
        }, {
            id: 'unrelated-history', subject: 'Aster', predicate: 'old meal with Beryl',
            value: 'They once shared ordinary bread.', importance: 5, sources: source,
        }, ...Array.from({ length: 8 }, (_, index) => ({
            id: `archive-${index}`, subject: `Archivist ${index}`, predicate: 'routine filing',
            value: 'An unrelated administrative entry.', importance: 3,
        }))],
    });
    const recent = [
        { name: 'Narrator', is_user: false, mes: 'Aster and Beryl discuss returning through the northern pass.' },
        { name: 'User', is_user: true, mes: 'Next.' },
    ];
    const result = buildMemoryPrompt(target, recent, 10000, 'chat', ['Aster and Beryl trade playful banter']);
    const supportIds = selections(result, 'Supporting continuity').map(item => item.id);

    assert.ok(supportIds.includes('pass-history'));
    assert.ok(!supportIds.includes('unrelated-history'));
});
