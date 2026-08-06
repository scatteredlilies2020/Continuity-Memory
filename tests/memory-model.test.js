import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmbeddingDocuments } from '../extension/embedding-index.js';
import { EXTRACTION_VERSION } from '../extension/coverage.js';
import { addDerivedArc, addDerivedEra, mergeExtraction, removeChatContributions, replaceExtraction, resetWorldHierarchy, resetWorldMemory, restoreRetainedReplayRecords } from '../extension/memory-model.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';

function world() {
    return {
        id: 'test-world', name: 'Test', revision: 0, scene: null,
        entities: [], facts: [], states: [], relationships: [], events: [], capsules: [], arcs: [], eras: [], extractions: [], threads: [], sources: {},
    };
}

function extraction(overrides = {}) {
    return {
        scene: { location: 'Music room', time: 'After school', participants: ['Yui', 'Mio'], activity: 'Practicing', mood: 'Relaxed' },
        sceneCapsule: { title: 'After-school practice', storyTime: 'After school', location: 'Music room', participants: ['Yui', 'Mio'], opening: 'Yui and Mio met to practice.', beats: ['They worked through a song.', 'Yui suggested rehearsing again Saturday.'], emotionalArc: 'They relaxed as the practice improved.', closing: 'They left with a weekend plan.', importance: 3, temporal: { frame: 'main narrative', relation: 'after', elapsed: '', certainty: 'implicit' } },
        entities: [{ name: 'Yui', type: 'character', aliases: [], description: 'A guitarist who loves snacks.', importance: 5 }],
        facts: [{ subject: 'Yui', predicate: 'favorite snack', value: 'cake', category: 'preference', importance: 3, persistence: 'persistent' }],
        states: [{ subject: 'Yui', attribute: 'location', value: 'Music room', previous: '', importance: 3, scope: 'scene', operation: 'set' }],
        relationships: [{ from: 'Yui', to: 'Mio', kind: 'friendship', status: 'Close friends', dynamic: 'Yui teases Mio gently.', importance: 4 }],
        events: [{ title: 'Practice session', summary: 'Yui and Mio practiced after school.', participants: ['Yui', 'Mio'], location: 'Music room', storyTime: 'Today', consequences: '', importance: 2, temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'implicit' } }],
        threads: [{ title: 'Weekend performance', detail: 'They plan to rehearse Saturday.', status: 'open', participants: ['Yui', 'Mio'], importance: 4 }],
        ...overrides,
    };
}

test('merges durable records and updates matching facts instead of duplicating them', () => {
    const target = world();
    const meta = { chatKey: 'character:1:chat:test', from: 0, to: 4, allowStateUpdates: true, messageFingerprints: [{ index: 0, fingerprint: 'first' }] };
    mergeExtraction(target, extraction(), meta);
    mergeExtraction(target, extraction({ facts: [{ subject: 'Yui', predicate: 'favorite snack', value: 'strawberry cake', category: 'preference', importance: 4, persistence: 'persistent' }], events: [] }), { ...meta, from: 5, to: 8 });
    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].value, 'strawberry cake');
    assert.equal(target.facts[0].sources.length, 2);
    assert.equal(target.sources[meta.chatKey].lastProcessedIndex, 8);
    assert.equal(target.capsules.length, 2);
    assert.deepEqual(target.sources[meta.chatKey].processedMessages, [{ index: 0, fingerprint: 'first', version: EXTRACTION_VERSION }]);
});

test('L1 records retain up to ten expanded chronological beats', () => {
    const target = world();
    const long = 'x'.repeat(500);
    mergeExtraction(target, extraction({
        sceneCapsule: {
            ...extraction().sceneCapsule,
            opening: long,
            beats: Array.from({ length: 12 }, (_, index) => `${index}-${long}`),
            emotionalArc: long,
            closing: long,
        },
    }), { chatKey: 'chat', from: 0, to: 9, allowStateUpdates: true });

    const [capsule] = target.capsules;
    assert.equal(capsule.beats.length, 10);
    assert.equal(capsule.opening.length, 320);
    assert.ok(capsule.beats.every(beat => beat.length === 400));
    assert.equal(capsule.emotionalArc.length, 320);
    assert.equal(capsule.closing.length, 320);
});

test('historical partial imports do not replace current mutable continuity', () => {
    const target = world();
    mergeExtraction(target, extraction({
        entities: [{ name: 'Yui', type: 'character', aliases: [], description: 'Current description', importance: 3 }],
        facts: [{ subject: 'Yui', predicate: 'favorite snack', value: 'current cake', category: 'preference', importance: 3, persistence: 'persistent' }],
        relationships: [{ from: 'Yui', to: 'Mio', kind: 'friendship', status: 'Current status', dynamic: 'Current dynamic', importance: 3 }],
        threads: [{ title: 'Weekend performance', detail: 'Current plan', status: 'resolved', participants: ['Yui'], importance: 3 }],
    }), { chatKey: 'new', from: 10, to: 20, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        scene: { location: 'Old location', time: '', participants: [], activity: '', mood: '' },
        states: [{ subject: 'Yui', attribute: 'location', value: 'Old location', previous: '', importance: 2 }],
        entities: [{ name: 'Yui', type: 'character', aliases: [], description: 'Old description', importance: 5 }],
        facts: [{ subject: 'Yui', predicate: 'favorite snack', value: 'old cake', category: 'preference', importance: 5, persistence: 'persistent' }],
        relationships: [{ from: 'Yui', to: 'Mio', kind: 'friendship', status: 'Old status', dynamic: 'Old dynamic', importance: 5 }],
        threads: [{ title: 'Weekend performance', detail: 'Old plan', status: 'open', participants: ['Yui'], importance: 5 }],
    }), { chatKey: 'old', from: 0, to: 2, allowStateUpdates: false });
    assert.equal(target.scene.location, 'Music room');
    assert.equal(target.states[0].value, 'Music room');
    assert.equal(target.entities[0].description, 'Current description');
    assert.equal(target.facts[0].value, 'current cake');
    assert.equal(target.relationships[0].status, 'Current status');
    assert.equal(target.threads[0].status, 'resolved');
});

test('state lifecycle expires scenes and fails closed when ongoing state is not reconfirmed', () => {
    const target = world();
    const chatKey = 'chat';
    mergeExtraction(target, extraction({
        sceneCapsule: { ...extraction().sceneCapsule, title: 'Day one preparations', opening: 'The team prepared separately.', beats: [], closing: 'They finished preparing.' },
        states: [
            { subject: 'Yui', attribute: 'location', value: 'Home', previous: '', importance: 2, scope: 'scene', operation: 'set' },
            { subject: 'Yui', attribute: 'injury', value: 'Bandaged shoulder', previous: '', importance: 3, scope: 'ongoing', operation: 'set' },
        ],
    }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        scene: { ...extraction().scene, location: 'Riverside park' },
        sceneCapsule: { ...extraction().sceneCapsule, title: 'Rest at the park', opening: 'The team reached the park.', beats: [], closing: 'They rested together.' },
        states: [{ subject: 'Yui', attribute: 'location', value: 'Riverside park', previous: 'Home', importance: 3, scope: 'scene', operation: 'set' }],
    }), { chatKey, from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.states.some(item => item.value === 'Home'), false);
    assert.equal(target.states.some(item => item.value === 'Bandaged shoulder'), true);
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'Where is Yui now, and what is her injury?' }], 2400, chatKey);
    assert.match(prompt.prompt, /Riverside park/);
    assert.doesNotMatch(prompt.prompt, /Bandaged shoulder/);

    mergeExtraction(target, extraction({
        states: [{ subject: 'Yui', attribute: 'injury', value: '', previous: 'Bandaged shoulder', importance: 3, scope: 'ongoing', operation: 'clear' }],
    }), { chatKey, from: 16, to: 23, allowStateUpdates: true });
    assert.equal(target.states.some(item => item.attribute === 'injury'), false);
});

test('state subjects reuse canonical entity names and legacy unscoped states never inject', () => {
    const target = world();
    const chatKey = 'chat';
    mergeExtraction(target, extraction({
        entities: [{ name: 'Naruto Uzumaki', type: 'character', aliases: [], description: 'A genin.', importance: 4 }],
        states: [{ subject: 'Naruto', attribute: 'current location', value: 'Riverside park', previous: '', importance: 3, scope: 'scene', operation: 'set' }],
    }), { chatKey, from: 8, to: 15, allowStateUpdates: true });
    target.states.push({
        id: 'legacy-stale', subject: 'Sasuke Uchiha', attribute: 'location',
        value: 'Performing unique obsolete grip drills at Hokage Tower', importance: 5,
        sources: [{ chatKey, from: 0, to: 7 }],
    });

    assert.equal(target.states.find(item => item.value === 'Riverside park').subject, 'Naruto Uzumaki');
    assert.equal(target.states.find(item => item.value === 'Riverside park').attribute, 'location');
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'What about those unique obsolete grip drills?' }], 1800, chatKey);
    assert.doesNotMatch(prompt.prompt, /unique obsolete grip drills/i);
    assert.doesNotMatch(prompt.prompt, /Hokage Tower/);
});

test('raw chat tail suppresses overlapping extracted memory while retaining hidden history', () => {
    const target = world();
    const chatKey = 'chat';
    mergeExtraction(target, extraction({
        sceneCapsule: { ...extraction().sceneCapsule, title: 'Hidden rehearsal', opening: 'Yui rehearsed an older song.', beats: [], closing: 'The rehearsal ended.' },
    }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        scene: { ...extraction().scene, location: 'Visible raw-tail room' },
        sceneCapsule: { ...extraction().sceneCapsule, title: 'Visible raw-tail scene', opening: 'Yui entered the visible raw-tail room.', beats: [], closing: 'She remained there.' },
        states: [{ subject: 'Yui', attribute: 'location', value: 'Visible raw-tail room', previous: '', importance: 3, scope: 'scene', operation: 'set' }],
    }), { chatKey, from: 8, to: 15, allowStateUpdates: true });

    const prompt = buildMemoryPrompt(
        target,
        [{ name: 'User', mes: 'Continue with Yui.' }],
        2400,
        chatKey,
        [],
        undefined,
        new Map(),
        { rawTailRange: { from: 8, to: 15 } },
    );
    assert.match(prompt.prompt, /Hidden rehearsal/);
    assert.doesNotMatch(prompt.prompt, /Visible raw-tail scene/);
    assert.doesNotMatch(prompt.prompt, /Visible raw-tail room/);
    assert.doesNotMatch(prompt.prompt, /Latest extracted checkpoint:/);
});

test('whole-token retrieval does not confuse contractions with substrings', () => {
    const target = world();
    mergeExtraction(target, extraction({
        states: [{ subject: 'Yui', attribute: 'activity', value: 'Practicing a drill', previous: '', importance: 3, scope: 'scene', operation: 'set' }],
    }), { chatKey: 'chat', from: 0, to: 7, allowStateUpdates: true });
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: "I'll decide later." }], 1800, 'chat');
    assert.doesNotMatch(prompt.prompt, /Practicing a drill/);
});

test('identical recurring events in separate ranges remain separate', () => {
    const target = world();
    const repeated = extraction({ sceneCapsule: null, entities: [], facts: [], states: [], relationships: [], threads: [] });
    mergeExtraction(target, repeated, { chatKey: 'chat', from: 0, to: 2, allowStateUpdates: true });
    mergeExtraction(target, repeated, { chatKey: 'chat', from: 3, to: 5, allowStateUpdates: true });
    mergeExtraction(target, repeated, { chatKey: 'chat', from: 4, to: 6, allowStateUpdates: true });
    assert.equal(target.events.length, 2);
});

test('retrieval prioritizes matching buried character memory within its budget', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'Yui, do you still want cake before rehearsal?' }], 1200);
    assert.match(result.prompt, /Yui/);
    assert.match(result.prompt, /cake/);
    assert.match(result.prompt, /Weekend performance/);
    assert.match(result.prompt, /Recent chronological continuity \(L1\)/);
    assert.ok(result.estimatedTokens <= 1200);
});

test('retrieval reserves room for every populated memory category', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'Yui and Mio continue their music practice, friendship, cake, and weekend performance plans.' }], 1000, 'chat');
    for (const heading of [
        'Latest extracted checkpoint',
        'Recent chronological continuity (L1)',
        'Open intentions, goals, and unresolved matters',
        'Relevant entities',
        'State confirmed in latest hidden L1',
        'Relationships',
        'Established facts',
        'Relevant past events',
    ]) assert.match(result.prompt, new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
    assert.ok(result.estimatedTokens <= 1000);
});

test('retrieval does not fill category space with unrelated memories', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'A distant storm approaches the harbor.' }], 3000, 'chat');
    assert.match(result.prompt, /Latest extracted checkpoint:/);
    assert.match(result.prompt, /Recent chronological continuity \(L1\):/);
    assert.doesNotMatch(result.prompt, /Established facts:/);
    assert.doesNotMatch(result.prompt, /Relevant past events:/);
    assert.doesNotMatch(result.prompt, /favorite snack/);
});

test('local retrieval does not truncate the beginning of a long complete message', () => {
    const target = world();
    target.facts.push({
        id: 'fact-treaty', subject: 'Asteria', predicate: 'ratified', value: 'the Zephyr Accord',
        category: 'diplomacy', persistence: 'persistent', importance: 4,
    });
    const longMessage = `Zephyr Accord ${'administrative filler '.repeat(2000)}`;

    const result = buildMemoryPrompt(target, [{ name: 'Narrator', mes: longMessage }], 1600, 'chat');

    assert.match(result.prompt, /Zephyr Accord/);
});

test('retrieval omits a stale scene checkpoint while preserving durable memory', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(
        target,
        [{ name: 'User', mes: 'Yui asks about cake after leaving the music room.' }],
        1600,
        'chat',
        [],
        undefined,
        new Map(),
        { includeSceneCheckpoint: false },
    );
    assert.doesNotMatch(result.prompt, /Latest extracted checkpoint:/);
    assert.match(result.prompt, /favorite snack/);
    assert.match(result.prompt, /Recent chronological continuity \(L1\):/);
});

test('retrieval supports short identifiers and CJK names', () => {
    const target = world();
    target.entities.push(
        { id: 'us', name: 'US', type: 'country', description: 'A federation.', importance: 3 },
        { id: 'taiwan', name: '台灣', type: 'place', description: 'An island.', importance: 3 },
    );
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'US 與台灣' }], 1200);
    assert.match(result.prompt, /US \(country\)/);
    assert.match(result.prompt, /台灣 \(place\)/);
});

test('hierarchy retrieval counts importance once and favors stronger matches', () => {
    const target = world();
    target.arcs = [
        { id: 'high-five', title: 'High five', summary: 'alpha only', importance: 5 },
        { id: 'high-four', title: 'High four', summary: 'alpha only', importance: 4 },
        { id: 'strong-match', title: 'Strong match', summary: 'alpha beta', importance: 1 },
    ];
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'alpha beta' }], 1200);
    assert.match(result.prompt, /Strong match/);
    assert.match(result.prompt, /High five/);
    assert.doesNotMatch(result.prompt, /High four/);
});

test('multilingual injection estimates remain within the token budget', () => {
    const target = world();
    target.entities.push({ id: 'wide', name: '台灣', type: 'place', description: '狀'.repeat(2500), importance: 3 });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: '台灣' }], 1000);
    assert.ok(result.estimatedTokens <= 1000);
});

test('retrieval avoids repeating hierarchy records covered by a selected higher level', () => {
    const target = world();
    target.capsules = [
        { id: 'old', chatKey: 'chat', from: 0, title: 'Old alpha detail', opening: 'alpha began', importance: 3 },
        { id: 'recent-1', chatKey: 'chat', from: 10, title: 'Recent one', opening: 'unrelated one', importance: 3 },
        { id: 'recent-2', chatKey: 'chat', from: 20, title: 'Recent two', opening: 'unrelated two', importance: 3 },
        { id: 'recent-3', chatKey: 'chat', from: 30, title: 'Recent three', opening: 'unrelated three', importance: 3 },
    ];
    target.arcs = [{ id: 'arc', title: 'Alpha L2', summary: 'alpha continued', capsuleIds: ['old'], importance: 3 }];
    target.eras = [{ id: 'era', title: 'Alpha L3', summary: 'alpha history', arcIds: ['arc'], capsuleIds: ['old'], importance: 3 }];
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'alpha' }], 2000, 'chat');
    assert.match(result.prompt, /Alpha L3/);
    assert.doesNotMatch(result.prompt, /Alpha L2/);
    assert.doesNotMatch(result.prompt, /Old alpha detail/);
    assert.match(result.prompt, /Recent three/);
});

test('L2 records are non-destructive derivatives and become stale when an L1 source changes', () => {
    const target = world();
    const meta = { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true };
    mergeExtraction(target, extraction(), meta);
    const capsule = target.capsules[0];
    addDerivedArc(target, {
        title: 'Music club beginnings', storyTime: 'After school', participants: ['Yui', 'Mio'],
        summary: 'Practice strengthened their friendship and established a weekend plan.',
        turningPoints: ['They completed a song.'], emotionalArc: 'They became more confident.',
        closingState: 'They planned another rehearsal.', openThreads: ['Weekend rehearsal'], importance: 4,
    }, [capsule]);
    assert.equal(target.capsules.length, 1);
    assert.equal(target.arcs.length, 1);
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'What happened with the music club?' }], 2000);
    assert.match(prompt.prompt, /Mid-range continuity \(L2\)/);
    assert.match(prompt.prompt, /Music club beginnings/);

    mergeExtraction(target, extraction({ sceneCapsule: { ...extraction().sceneCapsule, closing: 'The rehearsal plan was cancelled.' } }), meta);
    assert.equal(target.capsules.length, 1);
    assert.equal(target.arcs.length, 0);
});

test('L3 records retain L2 and L1 sources and invalidate when a source changes', () => {
    const target = world();
    const meta = { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true };
    mergeExtraction(target, extraction(), meta);
    const capsule = target.capsules[0];
    const arc = addDerivedArc(target, {
        title: 'Music club beginnings', storyTime: 'Spring', participants: ['Yui', 'Mio'],
        summary: 'The club formed and began practicing.', turningPoints: ['Their first rehearsal'], emotionalArc: 'Trust grew.',
        closingState: 'The club was established.', openThreads: ['First concert'], importance: 4,
    }, [capsule]);
    addDerivedEra(target, {
        title: 'The club foundation era', storyTime: 'Spring', participants: ['Yui', 'Mio'],
        summary: 'The musicians established their club.', turningPoints: ['The club formed'], emotionalArc: 'They became friends.',
        closingState: 'They prepared for a concert.', openThreads: ['First concert'], importance: 5,
    }, [arc]);
    assert.equal(target.eras.length, 1);
    assert.deepEqual(target.eras[0].arcIds, [arc.id]);
    assert.deepEqual(target.eras[0].capsuleIds, [capsule.id]);
    assert.equal(target.arcs.length, 1);
    assert.equal(target.capsules.length, 1);
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'Remember the music club foundation era and first concert.' }], 3000, 'chat');
    assert.match(prompt.prompt, /Long-range continuity \(L3\):/);
    assert.match(prompt.prompt, /The club foundation era/);

    replaceExtraction(target, extraction({ sceneCapsule: { ...extraction().sceneCapsule, closing: 'The club disbanded.' } }), meta);
    assert.equal(target.arcs.length, 0);
    assert.equal(target.eras.length, 0);
});

test('retrying L1 transactionally replaces the selected range contribution', () => {
    const target = world();
    const meta = { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true, messageFingerprints: [] };
    mergeExtraction(target, extraction(), meta);
    replaceExtraction(target, extraction({
        facts: [],
        events: [],
        sceneCapsule: { ...extraction().sceneCapsule, closing: 'They postponed the weekend plan.' },
    }), meta);
    assert.equal(target.facts.length, 0);
    assert.equal(target.events.length, 0);
    assert.equal(target.capsules.length, 1);
    assert.equal(target.capsules[0].closing, 'They postponed the weekend plan.');
    assert.equal(target.extractions.length, 1);
});

test('scratch rebuild removal invalidates only memory derived from the current chat', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'current', from: 0, to: 4, allowStateUpdates: true });
    const currentCapsule = target.capsules[0];
    addDerivedArc(target, {
        title: 'Current arc', storyTime: '', participants: [], summary: 'Current chat arc.',
        turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3,
    }, [currentCapsule]);
    mergeExtraction(target, extraction({ facts: [{ subject: 'Mio', predicate: 'instrument', value: 'bass', category: 'identity', importance: 4, persistence: 'persistent' }] }), { chatKey: 'other', from: 0, to: 4, allowStateUpdates: false });

    removeChatContributions(target, 'current');
    assert.equal(target.capsules.some(item => item.chatKey === 'current'), false);
    assert.equal(target.arcs.length, 0);
    assert.equal(target.extractions.some(item => item.chatKey === 'current'), false);
    assert.equal(target.facts.some(item => item.subject === 'Mio'), true);
    assert.ok(target.sources.other);
});

test('branch replay preserves retained record and hierarchy identities', () => {
    const target = world();
    const chatKey = 'chat';
    const first = extraction();
    const second = extraction({
        sceneCapsule: { ...extraction().sceneCapsule, title: 'Saturday rehearsal' },
        events: [{ ...extraction().events[0], title: 'Saturday rehearsal' }],
    });
    mergeExtraction(target, first, { chatKey, from: 0, to: 5, allowStateUpdates: true });
    const retainedCapsule = target.capsules[0];
    const retainedArc = addDerivedArc(target, {
        title: 'Practice arc', storyTime: '', participants: [], summary: 'The first practice.',
        turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3,
    }, [retainedCapsule]);
    addDerivedEra(target, {
        title: 'Practice era', storyTime: '', participants: [], summary: 'The retained era.',
        turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3,
    }, [retainedArc]);
    mergeExtraction(target, second, { chatKey, from: 6, to: 11, allowStateUpdates: true });
    const previous = structuredClone(target);
    const previousHashes = new Map(buildEmbeddingDocuments(previous).map(item => [item.key, item.hash]));
    const retainedIds = {
        entity: previous.entities[0].id,
        fact: previous.facts[0].id,
        event: previous.events[0].id,
        capsule: previous.capsules[0].id,
        extraction: previous.extractions[0].id,
        arc: previous.arcs[0].id,
        era: previous.eras[0].id,
    };

    removeChatContributions(target, chatKey);
    mergeExtraction(target, first, { chatKey, from: 0, to: 5, allowStateUpdates: true });
    restoreRetainedReplayRecords(target, previous, chatKey);

    assert.equal(target.entities[0].id, retainedIds.entity);
    assert.equal(target.facts[0].id, retainedIds.fact);
    assert.equal(target.events[0].id, retainedIds.event);
    assert.equal(target.capsules[0].id, retainedIds.capsule);
    assert.equal(target.extractions[0].id, retainedIds.extraction);
    assert.equal(target.arcs[0].id, retainedIds.arc);
    assert.equal(target.eras[0].id, retainedIds.era);
    assert.equal(target.capsules.some(item => Number(item.from) === 6), false);
    const replayedHashes = new Map(buildEmbeddingDocuments(target).map(item => [item.key, item.hash]));
    for (const key of [`capsule:${retainedIds.capsule}`, `arc:${retainedIds.arc}`, `era:${retainedIds.era}`]) {
        assert.equal(replayedHashes.get(key), previousHashes.get(key));
    }
});

test('full reset erases every memory layer while preserving the bound world identity', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    target.arcs.push({ id: 'arc' });
    target.eras.push({ id: 'era' });
    target.corrections = [{ id: 'correction' }];
    const identity = { id: target.id, name: target.name, revision: target.revision };

    resetWorldMemory(target);

    assert.deepEqual({ id: target.id, name: target.name, revision: target.revision }, identity);
    assert.equal(target.scene, null);
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'corrections']) {
        assert.deepEqual(target[category], []);
    }
    assert.deepEqual(target.sources, {});
});

test('hierarchy reset deletes L2 and L3 while preserving L1 and extracted memory', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    target.arcs.push({ id: 'arc' });
    target.eras.push({ id: 'era' });
    const l1 = structuredClone(target.capsules);
    const extractions = structuredClone(target.extractions);
    const facts = structuredClone(target.facts);

    resetWorldHierarchy(target);

    assert.deepEqual(target.arcs, []);
    assert.deepEqual(target.eras, []);
    assert.deepEqual(target.capsules, l1);
    assert.deepEqual(target.extractions, extractions);
    assert.deepEqual(target.facts, facts);
});
