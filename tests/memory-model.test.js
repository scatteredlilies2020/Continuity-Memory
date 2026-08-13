import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmbeddingDocuments } from '../extension/embedding-index.js';
import { EXTRACTION_VERSION } from '../extension/coverage.js';
import { addDerivedArc, addDerivedEra, compactHierarchyFields, getLatestL1UndoStatus, mergeExtraction, removeChatContributions, replaceExtraction, resetWorldHierarchy, resetWorldMemory, restoreRetainedReplayRecords, undoLatestL1Extraction } from '../extension/memory-model.js';
import { buildMemoryPrompt, orderEventsChronologically } from '../extension/retrieval.js';

function world() {
    return {
        id: 'test-world', name: 'Test', revision: 0, scene: null,
        entities: [], facts: [], states: [], relationships: [], events: [], capsules: [], arcs: [], eras: [], extractions: [], threads: [], backgrounds: [], sources: {},
    };
}

function extraction(overrides = {}) {
    return {
        scene: { location: 'Music room', time: 'After school', participants: ['Yui', 'Mio'], activity: 'Practicing', mood: 'Relaxed' },
        sceneCapsule: { title: 'After-school practice', storyTime: 'After school', location: 'Music room', participants: ['Yui', 'Mio'], opening: 'Yui and Mio met to practice.', beats: ['They worked through a song.', 'Yui suggested rehearsing again Saturday.'], emotionalArc: 'They relaxed as the practice improved.', closing: 'They left with a weekend plan.', importance: 3, temporal: { frame: 'main narrative', relation: 'after', elapsed: '', certainty: 'implicit' } },
        entities: [{ name: 'Yui', type: 'character', aliases: [], description: 'A guitarist who loves snacks.', importance: 5 }],
        identityResolutions: [],
        recordMerges: [],
        facts: [{ subject: 'Yui', predicate: 'favorite snack', value: 'cake', category: 'preference', importance: 3, persistence: 'persistent' }],
        states: [{ subject: 'Yui', attribute: 'location', value: 'Music room', previous: '', importance: 3, scope: 'scene', operation: 'set' }],
        relationships: [{ from: 'Yui', to: 'Mio', kind: 'friendship', status: 'Close friends', dynamic: 'Yui teases Mio gently.', importance: 4 }],
        events: [{ title: 'Practice session', summary: 'Yui and Mio practiced after school.', participants: ['Yui', 'Mio'], location: 'Music room', storyTime: 'Today', consequences: '', importance: 2, temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'implicit' } }],
        threads: [{ title: 'Weekend performance', detail: 'They plan to rehearse Saturday.', status: 'open', participants: ['Yui', 'Mio'], importance: 4 }],
        backgrounds: [],
        ...overrides,
    };
}

test('keeps attributed belief facts separate from established facts and from each other', () => {
    const target = world();
    const base = {
        scene: null, sceneCapsule: null, entities: [], identityResolutions: [], recordMerges: [], facts: [],
        states: [], relationships: [], events: [], threads: [], backgrounds: [],
    };
    mergeExtraction(target, {
        ...base,
        facts: [
            { subject: 'Alice', predicate: 'belief about the masked visitor — identity', value: 'the prince', category: 'character belief', persistence: 'persistent', importance: 4 },
            { subject: 'Bob', predicate: 'belief about the masked visitor — identity', value: 'a spy', category: 'character belief', persistence: 'persistent', importance: 3 },
        ],
    }, { chatKey: 'chat', from: 0, to: 3, allowStateUpdates: true });

    assert.equal(target.facts.length, 2);
    assert.deepEqual(target.facts.map(item => item.subject).sort(), ['Alice', 'Bob']);
    assert.equal(target.facts.some(item => item.subject === 'the masked visitor' && item.predicate === 'identity'), false);

    mergeExtraction(target, {
        ...base,
        facts: [{ subject: 'Alice', predicate: 'belief about the masked visitor — identity', value: 'not the prince', category: 'character belief', persistence: 'persistent', importance: 4 }],
    }, { chatKey: 'chat', from: 4, to: 7, allowStateUpdates: true });

    assert.equal(target.facts.length, 2);
    assert.equal(target.facts.find(item => item.subject === 'Alice').value, 'not the prince');
    assert.equal(target.facts.find(item => item.subject === 'Bob').value, 'a spy');
    const injected = buildMemoryPrompt(target, [{ name: 'User', mes: 'What does Bob think about the masked visitor?' }], 2000, 'chat');
    assert.match(injected.prompt, /Character perspectives \(not established facts\)/);
    assert.match(injected.prompt, /Bob.*belief about the masked visitor.*a spy.*not an established fact/i);
});

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

test('address facts merge by direction and retain concurrent exact forms', () => {
    const target = world();
    target.entities.push(
        { id: 'naruto', name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        { id: 'setsuko', name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
    );
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Setsuko Uchiha', predicate: 'form of address for Naruto Uzumaki', value: 'Uzumaki-kun',
            category: 'social address', importance: 2, persistence: 'persistent',
        }],
        events: [],
    }), { chatKey: 'chat', from: 0, to: 7, allowStateUpdates: true });
    const factId = target.facts[0].id;
    mergeExtraction(target, extraction({
        facts: [{
            targetId: factId, subject: 'Setsuko', predicate: 'calls Naruto.', value: 'Uzumaki-san; dead last',
            category: 'forms of address', importance: 2, persistence: 'persistent',
        }],
        events: [],
    }), { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].id, factId);
    assert.equal(target.facts[0].subject, 'Setsuko Uchiha');
    assert.equal(target.facts[0].predicate, 'calls Naruto Uzumaki');
    assert.equal(target.facts[0].value, 'Uzumaki-kun; Uzumaki-san; dead last');
    assert.equal(target.facts[0].category, 'form of address');
});

test('address forms accumulate when identity matching succeeds without a target ID', () => {
    const target = world();
    const meta = { chatKey: 'chat', allowStateUpdates: true };
    target.entities.push(
        { id: 'alice', name: 'Alice Carter', aliases: ['Alice'] },
        { id: 'bob', name: 'Bob Evans', aliases: ['Bob'] },
    );
    mergeExtraction(target, extraction({ facts: [{
        targetId: '', subject: 'Alice Carter', predicate: 'calls Bob Evans', value: 'Captain',
        category: 'form of address', importance: 2, persistence: 'recurring',
    }] }), { ...meta, from: 0, to: 7 });
    const factId = target.facts[0].id;

    mergeExtraction(target, extraction({ facts: [{
        targetId: '', subject: 'Alice Carter', predicate: 'calls Bob Evans', value: 'Show-off',
        category: 'form of address', importance: 2, persistence: 'recurring',
    }] }), { ...meta, from: 8, to: 15 });

    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].id, factId);
    assert.equal(target.facts[0].value, 'Captain; Show-off');
});

test('replay drops malformed address placeholders before canonical merge', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Setsuko Uchiha', predicate: 'calls [canonical addressee]',
            value: '[canonical addressee unavailable]', category: 'form of address', importance: 2, persistence: 'persistent',
        }],
        events: [],
    }), { chatKey: 'chat', from: 192, to: 199, allowStateUpdates: true });
    assert.deepEqual(target.facts, []);
    assert.deepEqual(target.extractions[0].result.facts, []);
});

test('stable target IDs update values while preserving canonical fact identity', () => {
    const target = world();
    const first = extraction({
        facts: [{ targetId: '', subject: 'North Canal', predicate: 'maintenance objective', value: 'Reduce leakage before planting season', category: 'infrastructure', importance: 4, persistence: 'persistent' }],
        events: [],
    });
    mergeExtraction(target, first, { chatKey: 'simulation', from: 0, to: 7, allowStateUpdates: true });
    const factId = target.facts[0].id;
    assert.equal(first.facts[0].targetId, factId);

    const update = extraction({
        facts: [{ targetId: factId, subject: 'North Canal', predicate: 'maintenance objective', value: 'Leakage repairs are funded and must finish before planting season', category: 'infrastructure', importance: 4, persistence: 'persistent' }],
        events: [],
    });
    mergeExtraction(target, update, { chatKey: 'simulation', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].subject, 'North Canal');
    assert.equal(target.facts[0].predicate, 'maintenance objective');
    assert.equal(target.facts[0].value, 'Leakage repairs are funded and must finish before planting season');
    assert.deepEqual(target.facts[0].sources.map(source => [source.from, source.to]), [[0, 7], [8, 15]]);
});

test('an unrelated fact target ID cannot overwrite a canonical fact', () => {
    const target = world();
    const cleanup = extraction({
        facts: [{ targetId: '', subject: 'Team 7', predicate: 'cleanup responsibility', value: 'Repair Training Ground Three.', category: 'accountability', importance: 3, persistence: 'persistent' }],
        events: [],
    });
    mergeExtraction(target, cleanup, { chatKey: 'chat', from: 104, to: 111, allowStateUpdates: true });
    const cleanupId = target.facts[0].id;
    const schedule = extraction({
        facts: [{
            targetId: cleanupId, subject: 'Team 7', predicate: 'training and service structure',
            value: 'Training occurs MWF; missions occur TTHS.', category: 'team operations', importance: 4, persistence: 'recurring',
        }],
        events: [],
    });
    mergeExtraction(target, schedule, { chatKey: 'chat', from: 120, to: 127, allowStateUpdates: true });

    assert.equal(target.facts.length, 2);
    assert.equal(target.facts[0].id, cleanupId);
    assert.equal(target.facts[0].predicate, 'cleanup responsibility');
    assert.equal(target.facts[0].value, 'Repair Training Ground Three.');
    assert.equal(target.facts[1].predicate, 'training and service structure');
    assert.equal(schedule.facts[0].targetId, target.facts[1].id);
});

test('compact background strands update by stable topic and inject only when relevant', () => {
    const target = world();
    const first = extraction({
        backgrounds: [{ targetId: '', topic: 'Qing White Lotus suppression', summary: 'White Lotus bands are weakening while locally funded militias strengthen provincial gentry.', status: 'active', certainty: 'reported', participants: ['Qing China', 'White Lotus bands'], importance: 2 }],
    });
    mergeExtraction(target, first, { chatKey: 'world-sim', from: 0, to: 7, allowStateUpdates: true });
    const backgroundId = target.backgrounds[0].id;
    assert.equal(first.backgrounds[0].targetId, backgroundId);

    const update = extraction({
        backgrounds: [{ targetId: backgroundId, topic: 'Qing White Lotus suppression', summary: 'The rebellion has lost mountain strongholds, but militia reliance leaves durable provincial militarization.', status: 'active', certainty: 'confirmed', participants: ['Qing China'], importance: 2 }],
    });
    mergeExtraction(target, update, { chatKey: 'world-sim', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.backgrounds.length, 1);
    assert.equal(target.backgrounds[0].id, backgroundId);
    assert.equal(target.backgrounds[0].topic, 'Qing White Lotus suppression');
    assert.equal(target.backgrounds[0].certainty, 'confirmed');
    assert.match(target.backgrounds[0].summary, /provincial militarization/);
    assert.deepEqual(target.backgrounds[0].sources.map(source => [source.from, source.to]), [[0, 7], [8, 15]]);

    const relevant = buildMemoryPrompt(target, [{ name: 'User', mes: 'What is happening with Qing China and the White Lotus?' }], 1800, 'world-sim');
    assert.match(relevant.prompt, /Background:/);
    assert.match(relevant.prompt, /provincial militarization/);
    assert.match(relevant.prompt, /confirmed/);

    const unrelated = buildMemoryPrompt(target, [{ name: 'User', mes: 'Continue the French siege at Verona.' }], 1800, 'world-sim');
    assert.doesNotMatch(unrelated.prompt, /provincial militarization/);
});

test('an unrelated background target ID cannot fuse separate strands', () => {
    const target = world();
    const first = extraction({
        backgrounds: [{ targetId: '', topic: 'Courier collapse after the mountain crossing', summary: 'The exhausted courier fell asleep at a roadside shelter.', status: 'active', certainty: 'confirmed', participants: ['Courier', 'Traveler'], importance: 2 }],
    });
    mergeExtraction(target, first, { chatKey: 'simulation', from: 0, to: 7, allowStateUpdates: true });
    const originalId = target.backgrounds[0].id;

    const unrelated = extraction({
        backgrounds: [{ targetId: originalId, topic: 'Council response to the warehouse incident', summary: 'A council member heard a report and plans to question the inspectors.', status: 'active', certainty: 'reported', participants: ['Council member', 'Inspectors'], importance: 2 }],
    });
    mergeExtraction(target, unrelated, { chatKey: 'simulation', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.backgrounds.length, 2);
    assert.equal(target.backgrounds[0].id, originalId);
    assert.match(target.backgrounds[0].summary, /roadside shelter/);
    assert.deepEqual(target.backgrounds[0].sources.map(source => [source.from, source.to]), [[0, 7]]);
    assert.equal(target.backgrounds[1].topic, 'Council response to the warehouse incident');
    assert.deepEqual(target.backgrounds[1].sources.map(source => [source.from, source.to]), [[8, 15]]);
    assert.notEqual(unrelated.backgrounds[0].targetId, originalId);
});

test('an unrelated state target ID cannot overwrite another subject or attribute', () => {
    const target = world();
    target.entities.push(
        { id: 'entity_alpha', name: 'Alpha', aliases: [] },
        { id: 'entity_beta', name: 'Beta', aliases: [] },
    );
    const first = extraction({
        states: [{ targetId: '', subject: 'Alpha', attribute: 'location', value: 'North gate', scope: 'ongoing', operation: 'set', importance: 2 }],
    });
    mergeExtraction(target, first, { chatKey: 'simulation', from: 0, to: 7, allowStateUpdates: true });
    const originalId = target.states[0].id;

    const unrelated = extraction({
        states: [{ targetId: originalId, subject: 'Beta', attribute: 'injury', value: 'Bandaged hand', scope: 'ongoing', operation: 'set', importance: 2 }],
    });
    mergeExtraction(target, unrelated, { chatKey: 'simulation', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.states.length, 2);
    assert.equal(target.states.find(item => item.id === originalId).value, 'North gate');
    assert.equal(target.states.find(item => item.subject === 'Beta').value, 'Bandaged hand');
});

test('validated exact-identity merge instructions consolidate prior duplicates and preserve provenance', () => {
    const target = world();
    const source = { chatKey: 'life-sim', from: 0, to: 7, capturedAt: new Date().toISOString() };
    const canonical = { id: 'fact_goal_a', subject: 'Mara', predicate: 'long-term goal', value: 'Open a neighborhood bakery', category: 'goal', sources: [source] };
    const duplicate = { id: 'fact_goal_b', subject: 'Mara', predicate: 'long-term goal', value: 'Run a bakery for the neighborhood', category: 'goal', sources: [source] };
    target.facts.push(canonical, duplicate);

    mergeExtraction(target, extraction({
        facts: [],
        events: [],
        recordMerges: [{
            category: 'facts',
            canonicalId: canonical.id,
            duplicateIds: [duplicate.id],
            evidence: 'Both records describe Mara’s same bakery goal.',
        }],
    }), { chatKey: 'life-sim', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].id, canonical.id);
    assert.deepEqual(target.facts[0].sources.map(source => [source.from, source.to]), [[0, 7], [8, 15]]);
});

test('an explicit merge cannot fuse unrelated background strands', () => {
    const target = world();
    target.backgrounds.push(
        { id: 'background_a', topic: 'Courier collapse after the mountain crossing', summary: 'A courier collapsed.', sources: [] },
        { id: 'background_b', topic: 'Council response to the warehouse incident', summary: 'A council member heard a report.', sources: [] },
    );

    mergeExtraction(target, extraction({
        recordMerges: [{ category: 'backgrounds', canonicalId: 'background_a', duplicateIds: ['background_b'], evidence: 'Both involve an incident.' }],
    }), { chatKey: 'simulation', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.backgrounds.length, 2);
});

test('unknown target IDs are never adopted from ordinary incoming extraction', () => {
    const target = world();
    const result = extraction({
        backgrounds: [{ targetId: 'background_invented', topic: 'Northern bridge repairs', summary: 'Repairs started.', status: 'active', certainty: 'confirmed', participants: [], importance: 2 }],
    });
    mergeExtraction(target, result, { chatKey: 'simulation', from: 0, to: 7, allowStateUpdates: true });

    assert.equal(target.backgrounds.length, 1);
    assert.notEqual(target.backgrounds[0].id, 'background_invented');
    assert.equal(result.backgrounds[0].targetId, target.backgrounds[0].id);
});

test('facts with matching subject and predicate but different categories remain separate', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{ targetId: '', subject: 'North gate', predicate: 'status', value: 'Closed', category: 'access', importance: 2, persistence: 'temporary' }],
    }), { chatKey: 'simulation', from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        facts: [{ targetId: '', subject: 'North gate', predicate: 'status', value: 'Guard rotation delayed', category: 'staffing', importance: 2, persistence: 'temporary' }],
    }), { chatKey: 'simulation', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.facts.length, 2);
});

test('stored target IDs remain replay-safe after records are rebuilt from extraction results', () => {
    const original = world();
    const first = extraction({
        facts: [{ targetId: '', subject: 'Research Lab', predicate: 'power source', value: 'Backup generator', category: 'resource', importance: 3, persistence: 'persistent' }],
        events: [],
    });
    mergeExtraction(original, first, { chatKey: 'management', from: 0, to: 7, allowStateUpdates: true });
    const stableId = original.facts[0].id;
    const second = extraction({
        facts: [{ targetId: stableId, subject: 'Research Lab', predicate: 'power source', value: 'Grid power restored; generator retained for emergencies', category: 'resource', importance: 3, persistence: 'persistent' }],
        events: [],
    });
    mergeExtraction(original, second, { chatKey: 'management', from: 8, to: 15, allowStateUpdates: true });

    const replayed = world();
    mergeExtraction(replayed, structuredClone(first), { chatKey: 'management', from: 0, to: 7, allowStateUpdates: true, replayStoredExtraction: true });
    mergeExtraction(replayed, structuredClone(second), { chatKey: 'management', from: 8, to: 15, allowStateUpdates: true, replayStoredExtraction: true });
    assert.equal(replayed.facts.length, 1);
    assert.equal(replayed.facts[0].id, stableId);
    assert.equal(replayed.facts[0].value, 'Grid power restored; generator retained for emergencies');
});

test('narrative identity resolutions migrate and deduplicate durable references', () => {
    const target = world();
    const chatKey = 'chat';
    const reference = 'the man responsible for his clan’s destruction';
    mergeExtraction(target, extraction({
        entities: [{ name: 'Sasuke Uchiha', type: 'character', aliases: ['Sasuke'], description: 'An avenger.', importance: 5 }],
        facts: [{ subject: reference, predicate: 'identity', value: 'unknown', category: 'identity', importance: 4, persistence: 'persistent' }],
        relationships: [{ from: 'Sasuke Uchiha', to: reference, kind: 'revenge target', status: 'unresolved', dynamic: 'Sasuke intends to kill him.', importance: 5 }],
        events: [{ ...extraction().events[0], participants: ['Sasuke Uchiha', reference] }],
        threads: [{ title: 'Sasuke’s revenge', detail: 'Identify and confront the killer.', status: 'open', participants: ['Sasuke Uchiha', reference], importance: 5 }],
    }), { chatKey, from: 128, to: 135, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        entities: [{ name: 'Itachi Uchiha', type: 'character', aliases: ['Itachi'], description: 'Sasuke’s elder brother.', importance: 5 }],
        identityResolutions: [{ reference, canonical: 'Itachi Uchiha', evidence: 'The narrative identifies Itachi as the previously unnamed man.' }],
        facts: [{ subject: 'Itachi Uchiha', predicate: 'identity', value: 'Sasuke’s elder brother and revenge target', category: 'identity', importance: 5, persistence: 'persistent' }],
        relationships: [{ from: 'Sasuke Uchiha', to: 'Itachi Uchiha', kind: 'revenge target', status: 'identified', dynamic: 'Sasuke now names Itachi as his target.', importance: 5 }],
        events: [],
        threads: [{ title: 'Sasuke’s revenge', detail: 'Sasuke intends to confront Itachi.', status: 'open', participants: ['Sasuke Uchiha', 'Itachi Uchiha'], importance: 5 }],
    }), { chatKey, from: 216, to: 223, allowStateUpdates: true });

    assert.equal(target.relationships.length, 1);
    assert.equal(target.relationships[0].to, 'Itachi Uchiha');
    assert.equal(target.relationships[0].status, 'identified');
    assert.deepEqual(target.relationships[0].sources.map(source => [source.from, source.to]), [[128, 135], [216, 223]]);
    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].subject, 'Itachi Uchiha');
    assert.equal(target.facts[0].value, 'Sasuke’s elder brother and revenge target');
    assert.deepEqual(target.entities.find(item => item.name === 'Itachi Uchiha').aliases, ['Itachi', reference]);
    assert.deepEqual(target.events[0].participants, ['Sasuke Uchiha', 'Itachi Uchiha']);
    assert.deepEqual(target.threads[0].participants, ['Sasuke Uchiha', 'Itachi Uchiha']);
});

test('identity resolution fails closed without one unambiguous canonical entity', () => {
    const target = world();
    const reference = 'the masked commander';
    mergeExtraction(target, extraction({
        entities: [
            { name: 'Candidate One', type: 'character', aliases: [reference], description: '', importance: 3 },
            { name: 'Candidate Two', type: 'character', aliases: [reference], description: '', importance: 3 },
            { name: 'Confirmed Name', type: 'character', aliases: [], description: '', importance: 3 },
        ],
        relationships: [{ from: 'Yui', to: reference, kind: 'opponent', status: 'unknown', dynamic: '', importance: 3 }],
    }), { chatKey: 'chat', from: 0, to: 7, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        entities: [{ name: 'Confirmed Name', type: 'character', aliases: [], description: '', importance: 3 }],
        identityResolutions: [{ reference, canonical: 'Confirmed Name', evidence: 'Ambiguous test evidence.' }],
        relationships: [],
        events: [],
    }), { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.relationships[0].to, reference);
    assert.deepEqual(target.entities.find(item => item.name === 'Confirmed Name').aliases, []);
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
            coverageWarnings: ['Potential durable detail remains only in L1: Yui vowed to return.'],
        },
    }), { chatKey: 'chat', from: 0, to: 9, allowStateUpdates: true });

    const [capsule] = target.capsules;
    assert.equal(capsule.beats.length, 10);
    assert.equal(capsule.opening.length, 320);
    assert.ok(capsule.beats.every(beat => beat.length === 400));
    assert.equal(capsule.emotionalArc.length, 320);
    assert.equal(capsule.closing.length, 320);
    assert.deepEqual(capsule.coverageWarnings, ['Potential durable detail remains only in L1: Yui vowed to return.']);
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

test('newer historical ranges advance durable records without allowing older ranges to regress them', () => {
    const target = world();
    const chatKey = 'chat';
    mergeExtraction(target, extraction({
        entities: [{ name: 'Tea Circle Amphitheater', type: 'place', aliases: ['Tea Circle'], description: 'Venue where Team 7 will assemble a stage.', importance: 3 }],
        facts: [{ subject: 'D-014', predicate: 'status', value: 'scheduled', category: 'mission', importance: 3, persistence: 'temporary' }],
        relationships: [{ from: 'Team 7', to: 'D-014', kind: 'assignment', status: 'Pending', dynamic: '', importance: 3 }],
        threads: [{ title: 'Complete D-014', detail: 'Team 7 must assemble the stage.', status: 'open', participants: ['Team 7'], importance: 3 }],
    }), { chatKey, from: 0, to: 4, allowStateUpdates: false });
    mergeExtraction(target, extraction({
        entities: [{ name: 'Tea Circle Amphitheater', type: 'place', aliases: [], description: 'East-district venue and site of Team 7’s completed D-014 stage setup.', importance: 3 }],
        facts: [{ subject: 'D-014', predicate: 'status', value: 'completed and accepted', category: 'mission', importance: 4, persistence: 'persistent' }],
        relationships: [{ from: 'Team 7', to: 'D-014', kind: 'assignment', status: 'Completed', dynamic: 'Accepted by the client.', importance: 4 }],
        threads: [{ title: 'Complete D-014', detail: 'The stage setup was accepted.', status: 'resolved', participants: ['Sakura'], importance: 4 }],
    }), { chatKey, from: 5, to: 9, allowStateUpdates: false });

    assert.equal(target.entities[0].description, 'East-district venue and site of Team 7’s completed D-014 stage setup.');
    assert.deepEqual(target.entities[0].aliases, ['Tea Circle']);
    assert.equal(target.facts[0].value, 'completed and accepted');
    assert.equal(target.relationships[0].status, 'Completed');
    assert.equal(target.threads[0].status, 'resolved');
    assert.deepEqual(target.threads[0].participants, ['Team 7', 'Sakura']);

    mergeExtraction(target, extraction({
        entities: [{ name: 'Tea Circle Amphitheater', type: 'place', aliases: [], description: 'Venue where Team 7 will assemble a stage.', importance: 3 }],
        facts: [{ subject: 'D-014', predicate: 'status', value: 'scheduled', category: 'mission', importance: 3, persistence: 'temporary' }],
        relationships: [{ from: 'Team 7', to: 'D-014', kind: 'assignment', status: 'Pending', dynamic: '', importance: 3 }],
        threads: [{ title: 'Complete D-014', detail: 'Team 7 must assemble the stage.', status: 'open', participants: ['Team 7'], importance: 3 }],
    }), { chatKey, from: 2, to: 4, allowStateUpdates: false });

    assert.equal(target.entities[0].description, 'East-district venue and site of Team 7’s completed D-014 stage setup.');
    assert.equal(target.facts[0].value, 'completed and accepted');
    assert.equal(target.relationships[0].status, 'Completed');
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
    assert.doesNotMatch(prompt.prompt, /Checkpoint:/);
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
    assert.match(result.prompt, /Recent continuity:/);
    assert.ok(result.estimatedTokens <= 1200);
});

test('retrieval reserves room for every populated memory category', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'Yui and Mio continue their music practice, friendship, cake, and weekend performance plans.' }], 1000, 'chat');
    for (const heading of [
        'Checkpoint',
        'Recent continuity',
        'Open matters',
        'Entities',
        'Current state',
        'Relationships',
        'Facts',
        'Past events',
    ]) assert.match(result.prompt, new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
    assert.ok(result.estimatedTokens <= 1000);
});

test('retrieval does not fill category space with unrelated memories', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'A distant storm approaches the harbor.' }], 3000, 'chat');
    assert.match(result.prompt, /Checkpoint:/);
    assert.match(result.prompt, /Recent continuity:/);
    assert.doesNotMatch(result.prompt, /Facts:/);
    assert.doesNotMatch(result.prompt, /Past events:/);
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
    assert.doesNotMatch(result.prompt, /Checkpoint:/);
    assert.match(result.prompt, /favorite snack/);
    assert.match(result.prompt, /Recent continuity:/);
});

test('retrieval suppresses records from invalid extraction ranges before repair completes', () => {
    const target = world();
    const chatKey = 'chat';
    mergeExtraction(target, extraction({
        facts: [{ subject: 'Yui', predicate: 'obsolete destination', value: 'Abandoned observatory', category: 'plan', importance: 5, persistence: 'temporary' }],
        events: [{ title: 'Obsolete observatory plan', summary: 'Yui planned to visit the abandoned observatory.', participants: ['Yui'], location: 'Observatory', storyTime: 'Earlier', consequences: '', importance: 5 }],
    }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        facts: [{ subject: 'Yui', predicate: 'current destination', value: 'Harbor', category: 'plan', importance: 5, persistence: 'temporary' }],
        events: [{ title: 'Harbor departure', summary: 'Yui left for the harbor.', participants: ['Yui'], location: 'Harbor', storyTime: 'Later', consequences: '', importance: 5 }],
    }), { chatKey, from: 8, to: 15, allowStateUpdates: true });
    target.facts.push({
        id: 'corrected-destination', correctionId: 'correction-1', subject: 'Yui', predicate: 'authoritative fallback',
        value: 'Lighthouse if the harbor closes', category: 'plan', importance: 5, persistence: 'temporary',
        sources: [{ chatKey, from: 0, to: 7 }],
    });

    const result = buildMemoryPrompt(
        target,
        [{ name: 'User', mes: 'Where is Yui going, the observatory, harbor, or lighthouse?' }],
        2600,
        chatKey,
        [],
        undefined,
        new Map(),
        { invalidSourceRanges: [{ chatKey, from: 0, to: 7 }] },
    );
    assert.doesNotMatch(result.prompt, /Abandoned observatory|Obsolete observatory plan/i);
    assert.match(result.prompt, /Harbor/);
    assert.match(result.prompt, /Lighthouse if the harbor closes/);
});

test('relevant past events are sent chronologically after relevance selection', () => {
    const target = world();
    target.events = [
        { id: 'latest', title: 'Festival closes', summary: 'The festival closes in the capital.', storyTime: '14 June 1803', importance: 5, sources: [{ chatKey: 'chat', from: 10, to: 11 }] },
        { id: 'earliest', title: 'Festival opens', summary: 'The festival opens in the capital.', storyTime: 'January 1801', importance: 3, sources: [{ chatKey: 'chat', from: 30, to: 31 }] },
        { id: 'middle', title: 'Festival expands', summary: 'The festival expands through the capital.', storyTime: 'February 1802', importance: 4, sources: [{ chatKey: 'chat', from: 20, to: 21 }] },
        { id: 'undated-later-source', title: 'Festival rumor', summary: 'A festival rumor spreads in the capital.', storyTime: '', importance: 5, sources: [{ chatKey: 'chat', from: 25, to: 26 }] },
    ];

    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'What happened at the festival in the capital?' }], 3000, 'chat');
    const rows = result.prompt.slice(result.prompt.indexOf('Past events:')).split('\n').filter(row => row.startsWith('- '));
    assert.deepEqual(rows.map(row => row.match(/Festival (?:opens|expands|rumor|closes)/)?.[0]), [
        'Festival opens', 'Festival expands', 'Festival rumor', 'Festival closes',
    ]);
});

test('undated relevant events fall back to source message order', () => {
    const target = world();
    target.events = [
        { id: 'second', title: 'Harbor alarm ends', summary: 'The harbor alarm ends.', importance: 5, sources: [{ chatKey: 'chat', from: 40, to: 41 }] },
        { id: 'first', title: 'Harbor alarm begins', summary: 'The harbor alarm begins.', importance: 2, sources: [{ chatKey: 'chat', from: 12, to: 13 }] },
    ];

    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'What happened with the harbor alarm?' }], 3000, 'chat');
    assert.ok(result.prompt.indexOf('Harbor alarm begins') < result.prompt.indexOf('Harbor alarm ends'));
});

test('chronological event ordering recognizes stored numeric, placeholder-year, and numbered-day dates', () => {
    const source = (from) => [{ chatKey: 'chat', from, to: from }];
    const numeric = orderEventsChronologically([
        { id: 'numeric-late', storyTime: '12/14/1829', sources: source(1) },
        { id: 'numeric-early', storyTime: '03/14/1821', sources: source(2) },
    ], 'chat');
    const placeholder = orderEventsChronologically([
        { id: 'same-day-late', storyTime: '04.03.XXXX, Friday evening', sources: source(3) },
        { id: 'next-day', storyTime: '04.04.XXXX, morning', sources: source(1) },
        { id: 'same-day-early', storyTime: '04.03.XXXX, noon', sources: source(2) },
    ], 'chat');
    const numbered = orderEventsChronologically([
        { id: 'day-two', storyTime: 'RP Day 2, morning', sources: source(1) },
        { id: 'day-one', storyTime: 'RP Day 1, evening', sources: source(2) },
    ], 'chat');

    assert.deepEqual(numeric.map(item => item.id), ['numeric-early', 'numeric-late']);
    assert.deepEqual(placeholder.map(item => item.id), ['same-day-early', 'same-day-late', 'next-day']);
    assert.deepEqual(numbered.map(item => item.id), ['day-one', 'day-two']);
});

test('undated events follow stored narrative relations across later flashbacks', () => {
    const source = (from) => [{ chatKey: 'chat', from, to: from }];
    const presentAnchor = 'L1-chat-0-7';
    const flashbackAnchor = 'L1-chat-8-15';
    const capsules = [
        { chatKey: 'chat', from: 0, to: 7, temporal: { anchorId: presentAnchor, referenceId: '', relation: 'unknown' } },
        { chatKey: 'chat', from: 8, to: 15, temporal: { anchorId: flashbackAnchor, referenceId: presentAnchor, relation: 'before' } },
    ];
    const ordered = orderEventsChronologically([
        { id: 'present', sources: source(1), temporal: { referenceId: presentAnchor, relation: 'same-period' } },
        { id: 'flashback', sources: source(9), temporal: { referenceId: flashbackAnchor, relation: 'same-period' } },
    ], 'chat', capsules);

    assert.deepEqual(ordered.map(item => item.id), ['flashback', 'present']);
});

test('undated events use before and after positions within one L1 anchor', () => {
    const anchorId = 'L1-chat-0-7';
    const source = [{ chatKey: 'chat', from: 0, to: 7 }];
    const ordered = orderEventsChronologically([
        { id: 'after', sources: source, temporal: { referenceId: anchorId, relation: 'after' } },
        { id: 'same', sources: source, temporal: { referenceId: anchorId, relation: 'same-period' } },
        { id: 'before', sources: source, temporal: { referenceId: anchorId, relation: 'before' } },
    ], 'chat', [{ chatKey: 'chat', from: 0, to: 7, temporal: { anchorId, referenceId: '', relation: 'unknown' } }]);

    assert.deepEqual(ordered.map(item => item.id), ['before', 'same', 'after']);
});

test('contradictory undated temporal relations fail closed to source order', () => {
    const firstAnchor = 'L1-chat-0-7';
    const secondAnchor = 'L1-chat-8-15';
    const capsules = [
        { temporal: { anchorId: firstAnchor, referenceId: secondAnchor, relation: 'after' } },
        { temporal: { anchorId: secondAnchor, referenceId: firstAnchor, relation: 'after' } },
    ];
    const ordered = orderEventsChronologically([
        { id: 'first', sources: [{ chatKey: 'chat', from: 1, to: 1 }], temporal: { referenceId: firstAnchor, relation: 'same-period' } },
        { id: 'second', sources: [{ chatKey: 'chat', from: 9, to: 9 }], temporal: { referenceId: secondAnchor, relation: 'same-period' } },
    ], 'chat', capsules);

    assert.deepEqual(ordered.map(item => item.id), ['first', 'second']);
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
    assert.match(prompt.prompt, /L2 continuity:/);
    assert.match(prompt.prompt, /Music club beginnings/);

    mergeExtraction(target, extraction({ sceneCapsule: { ...extraction().sceneCapsule, closing: 'The rehearsal plan was cancelled.' } }), meta);
    assert.equal(target.capsules.length, 1);
    assert.equal(target.arcs.length, 0);
});

test('L2 preserves a complete generated summary through storage and retrieval', () => {
    const target = world();
    const chatKey = 'long-l2-chat';
    mergeExtraction(target, extraction(), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    const completeSummary = `${'Alpha development remained causally important. '.repeat(80)}FINAL_L2_SENTENCE.`;
    const completeTitle = `${'Complete alpha title context. '.repeat(8)}FINAL_L2_TITLE.`;
    const completeStoryTime = `${'Relative narrative interval. '.repeat(8)}FINAL_L2_TIME.`;
    const completeTurningPoint = `${'A detailed causal turning point remained important. '.repeat(8)}FINAL_L2_TURN.`;
    const completeThread = `${'A detailed unresolved thread remained important. '.repeat(7)}FINAL_L2_THREAD.`;
    assert.ok(completeSummary.length > 1800);
    assert.ok(completeTitle.length > 140);
    assert.ok(completeStoryTime.length > 180);

    const completeProgression = `${'Trust changed through each major development. '.repeat(20)}FINAL_L2_PROGRESSION.`;
    const completeClosing = `${'The interval closed with a durable consequence. '.repeat(20)}FINAL_L2_CLOSING.`;
    const arc = addDerivedArc(target, {
        title: completeTitle, storyTime: completeStoryTime, participants: ['Yui', 'Mio'],
        summary: completeSummary, turningPoints: [completeTurningPoint], emotionalArc: completeProgression,
        closingState: completeClosing, openThreads: [completeThread], importance: 4,
    }, [target.capsules[0]]);

    assert.equal(arc.summary, completeSummary);
    assert.ok(arc.title.length <= 140);
    assert.ok(arc.storyTime.length <= 180);
    assert.ok(arc.title.endsWith('…'));
    assert.ok(arc.storyTime.endsWith('…'));
    assert.equal(arc.turningPoints[0], completeTurningPoint);
    assert.equal(arc.emotionalArc, completeProgression);
    assert.equal(arc.closingState, completeClosing);
    assert.equal(arc.openThreads[0], completeThread);
    assert.ok(!arc.summary.endsWith('…'));
    assert.ok(!arc.emotionalArc.endsWith('…'));
    assert.ok(!arc.closingState.endsWith('…'));
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'Continue the alpha history.' }], 12000, chatKey);
    assert.match(prompt.prompt, /FINAL_L2_SENTENCE\./);
    assert.match(prompt.prompt, /FINAL_L2_CLOSING\./);
});

test('hierarchy compaction removes only exact repeated field text', () => {
    const compact = compactHierarchyFields({
        summary: 'Setsuko called Naruto Suki-chan.',
        turningPoints: ['Setsuko called Naruto Suki-chan', 'Setsuko began using his first name.'],
        emotionalArc: 'Setsuko began using his first name.',
        closingState: 'Their familiarity increased.',
        openThreads: ['Their familiarity increased', 'Whether the new address will persist.'],
    });

    assert.equal(compact.summary, 'Setsuko called Naruto Suki-chan.');
    assert.deepEqual(compact.turningPoints, ['Setsuko began using his first name.']);
    assert.equal(compact.emotionalArc, '');
    assert.equal(compact.closingState, 'Their familiarity increased.');
    assert.deepEqual(compact.openThreads, ['Whether the new address will persist.']);
});

test('L1 retrieval preserves the complete bounded capsule', () => {
    const target = world();
    const chatKey = 'complete-l1-chat';
    const boundedCapsule = {
        ...extraction().sceneCapsule,
        opening: `${'Opening context remained relevant. '.repeat(8)}OPENING_END.`,
        beats: Array.from({ length: 10 }, (_, index) => `Beat ${index + 1}: ${'causal development remained relevant. '.repeat(8)}BEAT_${index + 1}_END.`),
        emotionalArc: `${'The relationship continued to change. '.repeat(7)}EMOTIONAL_END.`,
        closing: `${'The resulting situation remained unresolved. '.repeat(6)}FINAL_L1_SENTENCE.`,
    };
    mergeExtraction(target, extraction({ sceneCapsule: boundedCapsule }), { chatKey, from: 0, to: 7, allowStateUpdates: true });

    const capsule = target.capsules[0];
    assert.ok(capsule.opening.length <= 320);
    assert.ok(capsule.beats.every(beat => beat.length <= 400));
    assert.ok(capsule.emotionalArc.length <= 320);
    assert.ok(capsule.closing.length <= 320);
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'Continue the unresolved situation.' }], 12000, chatKey);
    assert.match(prompt.prompt, /FINAL_L1_SENTENCE\./);
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
    assert.match(prompt.prompt, /L3 continuity:/);
    assert.match(prompt.prompt, /The club foundation era/);

    replaceExtraction(target, extraction({ sceneCapsule: { ...extraction().sceneCapsule, closing: 'The club disbanded.' } }), meta);
    assert.equal(target.arcs.length, 0);
    assert.equal(target.eras.length, 0);
});

test('L3 preserves a complete generated summary through storage and retrieval', () => {
    const target = world();
    const chatKey = 'long-l3-chat';
    mergeExtraction(target, extraction(), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    const arc = addDerivedArc(target, {
        title: 'Omega arc', storyTime: 'Spring', participants: ['Yui', 'Mio'],
        summary: 'The omega history began.', turningPoints: ['Their first rehearsal'], emotionalArc: 'Trust grew.',
        closingState: 'The club remained active.', openThreads: ['First concert'], importance: 4,
    }, [target.capsules[0]]);
    const completeSummary = `${'Omega era development remained causally important. '.repeat(80)}FINAL_L3_SENTENCE.`;
    const completeTitle = `${'Complete omega title context. '.repeat(8)}FINAL_L3_TITLE.`;
    const completeStoryTime = `${'Long-range narrative interval. '.repeat(9)}FINAL_L3_TIME.`;
    const completeTurningPoint = `${'A detailed long-range turning point remained important. '.repeat(9)}FINAL_L3_TURN.`;
    const completeThread = `${'A detailed long-range unresolved thread remained important. '.repeat(7)}FINAL_L3_THREAD.`;
    assert.ok(completeSummary.length > 2600);
    assert.ok(completeTitle.length > 160);
    assert.ok(completeStoryTime.length > 220);

    const completeProgression = `${'The long-range progression remained causally significant. '.repeat(20)}FINAL_L3_PROGRESSION.`;
    const completeClosing = `${'The era closed with a durable long-range consequence. '.repeat(20)}FINAL_L3_CLOSING.`;
    const era = addDerivedEra(target, {
        title: completeTitle, storyTime: completeStoryTime, participants: ['Yui', 'Mio'],
        summary: completeSummary, turningPoints: [completeTurningPoint], emotionalArc: completeProgression,
        closingState: completeClosing, openThreads: [completeThread], importance: 5,
    }, [arc]);

    assert.equal(era.summary, completeSummary);
    assert.ok(era.title.length <= 160);
    assert.ok(era.storyTime.length <= 220);
    assert.ok(era.title.endsWith('…'));
    assert.ok(era.storyTime.endsWith('…'));
    assert.equal(era.turningPoints[0], completeTurningPoint);
    assert.equal(era.emotionalArc, completeProgression);
    assert.equal(era.closingState, completeClosing);
    assert.equal(era.openThreads[0], completeThread);
    assert.ok(!era.summary.endsWith('…'));
    assert.ok(!era.emotionalArc.endsWith('…'));
    assert.ok(!era.closingState.endsWith('…'));
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'Continue the omega era.' }], 12000, chatKey);
    assert.match(prompt.prompt, /FINAL_L3_SENTENCE\./);
    assert.match(prompt.prompt, /FINAL_L3_CLOSING\./);
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

test('undo latest L1 keeps chat messages pending and removes all dependent memory', () => {
    const target = world();
    const chatKey = 'chat';
    const first = extraction();
    const second = extraction({
        scene: { ...extraction().scene, location: 'Concert hall' },
        sceneCapsule: { ...extraction().sceneCapsule, title: 'Concert performance', location: 'Concert hall' },
        facts: [
            { subject: 'Yui', predicate: 'favorite snack', value: 'strawberry cake', category: 'preference', importance: 4, persistence: 'persistent' },
            { subject: 'Yui', predicate: 'concert role', value: 'lead guitarist', category: 'identity', importance: 4, persistence: 'persistent' },
        ],
        events: [{ ...extraction().events[0], title: 'Concert performance', location: 'Concert hall' }],
    });
    const fingerprints = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => ({ index: from + offset, fingerprint: `fingerprint-${from + offset}` }));
    mergeExtraction(target, first, { chatKey, from: 0, to: 4, allowStateUpdates: true, messageFingerprints: fingerprints(0, 4) });
    const retainedCapsule = target.capsules[0];
    const retainedArc = addDerivedArc(target, {
        title: 'Practice arc', storyTime: '', participants: [], summary: 'The original practice.',
        turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3,
    }, [retainedCapsule]);
    const retainedEra = addDerivedEra(target, {
        title: 'Practice era', storyTime: '', participants: [], summary: 'The original practice era.',
        turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3,
    }, [retainedArc]);
    mergeExtraction(target, second, { chatKey, from: 5, to: 9, allowStateUpdates: true, messageFingerprints: fingerprints(5, 9) });
    const dependentArc = addDerivedArc(target, {
        title: 'Concert arc', storyTime: '', participants: [], summary: 'Practice led to the concert.',
        turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 4,
    }, target.capsules);
    const dependentEra = addDerivedEra(target, {
        title: 'Concert era', storyTime: '', participants: [], summary: 'The concert era.',
        turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 4,
    }, [retainedArc, dependentArc]);
    mergeExtraction(target, extraction({
        facts: [{ subject: 'Mio', predicate: 'instrument', value: 'bass', category: 'identity', importance: 4, persistence: 'persistent' }],
    }), { chatKey: 'other', from: 0, to: 4, allowStateUpdates: false, messageFingerprints: fingerprints(0, 4) });

    const status = getLatestL1UndoStatus(target, chatKey);
    assert.deepEqual({ available: status.available, replayable: status.replayable, from: status.from, to: status.to, dependentL2: status.dependentL2, dependentL3: status.dependentL3 }, {
        available: true, replayable: true, from: 5, to: 9, dependentL2: 1, dependentL3: 1,
    });

    const result = undoLatestL1Extraction(target, chatKey, status.extractionId);
    assert.deepEqual({ from: result.from, to: result.to, removedL2: result.removedL2, removedL3: result.removedL3, retainedL1: result.retainedL1 }, {
        from: 5, to: 9, removedL2: 1, removedL3: 1, retainedL1: 1,
    });
    assert.deepEqual(target.extractions.filter(item => item.chatKey === chatKey).map(item => [item.from, item.to]), [[0, 4]]);
    assert.deepEqual(target.sources[chatKey].processedMessages.map(item => item.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(target.sources[chatKey].requiredMemoryIndexes, [5, 6, 7, 8, 9]);
    assert.equal(target.capsules.some(item => item.chatKey === chatKey && Number(item.from) === 5), false);
    assert.equal(target.facts.find(item => item.subject === 'Yui' && item.predicate === 'favorite snack').value, 'cake');
    assert.equal(target.facts.some(item => item.predicate === 'concert role'), false);
    assert.equal(target.events.some(item => item.title === 'Concert performance'), false);
    assert.equal(target.scene.location, 'Music room');
    assert.equal(target.arcs.some(item => item.id === retainedArc.id), true);
    assert.equal(target.arcs.some(item => item.id === dependentArc.id), false);
    assert.equal(target.eras.some(item => item.id === retainedEra.id), true);
    assert.equal(target.eras.some(item => item.id === dependentEra.id), false);
    assert.equal(target.facts.some(item => item.subject === 'Mio'), true);
    assert.ok(target.sources.other);

    mergeExtraction(target, second, { chatKey, from: 5, to: 9, allowStateUpdates: true, messageFingerprints: fingerprints(5, 9) });
    assert.deepEqual(target.sources[chatKey].requiredMemoryIndexes, []);
    undoLatestL1Extraction(target, chatKey);
    undoLatestL1Extraction(target, chatKey);
    assert.equal(getLatestL1UndoStatus(target, chatKey).available, false);
    assert.deepEqual(target.sources[chatKey].requiredMemoryIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(target.extractions.some(item => item.chatKey === 'other'), true);
});

test('undo latest L1 refuses incomplete legacy replay data without changing memory', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    delete target.extractions[0].result;
    const before = structuredClone(target);

    assert.equal(getLatestL1UndoStatus(target, 'chat').replayable, false);
    assert.throws(() => undoLatestL1Extraction(target, 'chat'), /cannot safely undo one range/i);
    assert.deepEqual(target, before);
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
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'backgrounds', 'corrections']) {
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
