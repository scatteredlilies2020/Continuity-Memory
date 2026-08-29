import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmbeddingDocuments } from '../extension/embedding-index.js';
import { EXTRACTION_VERSION } from '../extension/coverage.js';
import { addDerivedArc, addDerivedEra, compactDuplicateMemoryRecords, compactHierarchyFields, compactRepeatedEntityDescriptions, freshResetResiduals, getLatestL1UndoStatus, mergeExtraction, promoteStoredTailSnapshot, removeChatContributions, replaceExtraction, resetWorldHierarchy, resetWorldMemory, restoreRetainedReplayRecords, undoLatestL1Extraction } from '../extension/memory-model.js';
import { buildMemoryPrompt, orderEventsChronologically } from '../extension/retrieval.js';
import { sanitizeReconciliationMetadata } from '../extension/reconciliation-policy.js';

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

test('L1 extraction updates only the matching chat rolling story snapshot', () => {
    const target = world();
    target.storySoFar = {};
    target.storySoFar.chat = { text: 'Authoritative independent story.', from: 0, to: 7 };
    mergeExtraction(target, extraction({ storySoFar: { premise: ['The original premise remains true.'], majorDevelopments: ['A new development occurred.'], boundaryState: ['The characters remain uncertain.'], openMatters: ['The threat is unresolved.'] } }), { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });
    mergeExtraction(target, extraction({ storySoFar: { premise: ['A separate chat premise.'], majorDevelopments: [], boundaryState: [], openMatters: [] } }), { chatKey: 'other', from: 0, to: 7, allowStateUpdates: true });

    assert.match(target.storySoFar.chat.text, /The original premise remains true/);
    assert.equal(target.storySoFar.chat.to, 15);
    assert.match(target.storySoFar.other.text, /A separate chat premise/);
});

test('a sparse relationship update cannot erase the established role description', () => {
    const target = world();
    target.entities.push(
        { id: 'caelen', name: 'Caelen Veyr', type: 'person', aliases: [] },
        { id: 'lucas', name: 'Lucas Alcazar', type: 'person', aliases: [] },
    );
    target.relationships.push({
        id: 'relationship_training', from: 'Caelen Veyr', to: 'Lucas Alcazar',
        kind: 'master and apprentice', status: 'ended',
        dynamic: 'Caelen Veyr was Lucas Alcazar’s Jedi Master, and Lucas Alcazar was his apprentice.',
        importance: 4, sources: [],
    });

    mergeExtraction(target, extraction({
        scene: null, sceneCapsule: null, entities: [], facts: [], states: [], events: [], threads: [],
        relationships: [{
            targetId: 'relationship_training', from: 'Caelen Veyr', to: 'Lucas Alcazar',
            kind: 'master and apprentice', status: 'ended',
            dynamic: 'Lucas Alcazar killed Caelen Veyr and retained his hilt.', importance: 4,
        }],
    }), { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });

    assert.match(target.relationships[0].dynamic, /Caelen Veyr was Lucas Alcazar’s Jedi Master/);
    assert.match(target.relationships[0].dynamic, /Lucas Alcazar killed Caelen Veyr/);
});

test('a validated character profile replacement cannot re-merge rejected stored details', () => {
    const target = world();
    target.entities.push({
        id: 'lucas', name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'], importance: 5,
        description: 'Role/background: former Council member, Caelen Veyr’s former apprentice; Appearance: blue eyes.',
        profile: {
            roleBackground: ['former Council member', 'Caelen Veyr’s former apprentice'],
            appearance: ['blue eyes'],
        },
    });
    const result = extraction({
        entities: [{
            targetId: 'lucas', name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'], importance: 5,
            description: 'Role/background: Caelen Veyr’s former apprentice.',
            profile: { roleBackground: ['Caelen Veyr’s former apprentice'] },
            _validatedProfileReplace: true,
            _profileValidationVersion: EXTRACTION_VERSION,
        }],
        events: [],
    });

    mergeExtraction(target, result, { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });

    assert.deepEqual(target.entities[0].profile, { roleBackground: ['Caelen Veyr’s former apprentice'] });
    assert.equal(target.entities[0].description, 'Role/background: Caelen Veyr’s former apprentice.');
    assert.equal(target.entities[0].profileValidationVersion, EXTRACTION_VERSION);
    assert.equal('_validatedProfileReplace' in target.entities[0], false);
});

test('promotes a stored historical tail snapshot without re-merging durable memory', () => {
    const target = world();
    const result = extraction({
        scene: { location: 'Coruscant landing platform', time: 'Evening', participants: ['Lucas'], activity: 'Disembarking for a meeting', mood: 'Tense' },
        states: [
            { subject: 'Lucas', attribute: 'current location', value: 'At the Imperial Palace', previous: '', importance: 5, scope: 'ongoing', operation: 'set' },
            { subject: 'Toska', attribute: 'current location', value: 'Remaining at the hidden moonbase', previous: '', importance: 5, scope: 'ongoing', operation: 'set' },
        ],
    });
    mergeExtraction(target, result, { chatKey: 'chat', from: 168, to: 175, allowStateUpdates: false });
    const durableCounts = Object.fromEntries(['entities', 'facts', 'relationships', 'events', 'capsules', 'threads'].map(category => [category, target[category].length]));

    assert.equal(target.scene, null);
    assert.equal(target.states.length, 0);
    assert.equal(promoteStoredTailSnapshot(target, 'chat', 175), true);
    assert.equal(target.scene.location, 'Coruscant landing platform');
    assert.deepEqual(target.states.map(item => item.subject), ['Lucas', 'Toska']);
    assert.equal(target.extractions[0].allowStateUpdates, true);
    assert.deepEqual(Object.fromEntries(Object.keys(durableCounts).map(category => [category, target[category].length])), durableCounts);
    assert.equal(promoteStoredTailSnapshot(target, 'chat', 175), false);
});

test('does not promote an extraction behind the latest complete L1 boundary', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 160, to: 167, allowStateUpdates: false });
    assert.equal(promoteStoredTailSnapshot(target, 'chat', 175), false);
    assert.equal(target.scene, null);
    assert.equal(target.states.length, 0);
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

test('an incompatible known fact target is discarded instead of becoming a false new fact', () => {
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

    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].id, cleanupId);
    assert.equal(target.facts[0].predicate, 'cleanup responsibility');
    assert.equal(target.facts[0].value, 'Repair Training Ground Three.');
    assert.equal(target.facts.some(item => item.predicate === 'training and service structure'), false);
    assert.equal(schedule.facts[0].targetId, '');
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

test('an incompatible known background target is discarded instead of becoming a false new strand', () => {
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

    assert.equal(target.backgrounds.length, 1);
    assert.equal(target.backgrounds[0].id, originalId);
    assert.match(target.backgrounds[0].summary, /roadside shelter/);
    assert.deepEqual(target.backgrounds[0].sources.map(source => [source.from, source.to]), [[0, 7]]);
    assert.equal(target.backgrounds.some(item => item.topic === 'Council response to the warehouse incident'), false);
    assert.equal(unrelated.backgrounds[0].targetId, '');
});

test('an incompatible known state target is discarded instead of becoming false current state', () => {
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

    assert.equal(target.states.length, 1);
    assert.equal(target.states.find(item => item.id === originalId).value, 'North gate');
    assert.equal(target.states.some(item => item.subject === 'Beta'), false);
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

test('replay cannot collapse a named actor into a related person or possessive object through reused entity IDs', () => {
    const target = world();
    const chatKey = 'roleplay';
    const toskaId = 'entity_toska';
    const caelenId = 'entity_caelen';

    mergeExtraction(target, extraction({
        scene: null,
        sceneCapsule: null,
        entities: [
            { targetId: toskaId, name: 'Toska', type: 'person', aliases: [], description: 'A Jedi Padawan.', importance: 5 },
            { targetId: toskaId, name: 'Toska’s deceased Jedi Master', type: 'person', aliases: ['Toska’s Master'], description: 'Her deceased Master.', importance: 4 },
        ],
        facts: [{ targetId: '', subject: 'Toska', predicate: 'rank', value: 'Jedi Padawan', category: 'identity', importance: 5, persistence: 'persistent' }],
        states: [], relationships: [], events: [], threads: [],
    }), { chatKey, from: 0, to: 7, allowStateUpdates: true, replayStoredExtraction: true });

    mergeExtraction(target, extraction({
        scene: null,
        sceneCapsule: null,
        entities: [{ targetId: caelenId, name: 'Caelen Veyr', type: 'person', aliases: ['Master Caelen Veyr'], description: 'A deceased Jedi Master and former Council member.', importance: 5 }],
        identityResolutions: [{ reference: 'Toska’s Master', canonical: 'Caelen Veyr', evidence: 'Toska names her former Master as Caelen Veyr.' }],
        facts: [{ targetId: '', subject: 'Caelen Veyr', predicate: 'former identity and service', value: 'Jedi Master and former Jedi Council member', category: 'identity', importance: 5, persistence: 'persistent' }],
        states: [], relationships: [], events: [], threads: [],
    }), { chatKey, from: 8, to: 15, allowStateUpdates: true, replayStoredExtraction: true });

    mergeExtraction(target, extraction({
        scene: null,
        sceneCapsule: null,
        entities: [
            { targetId: caelenId, name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'], description: 'A deceased Jedi Master and former Council member.', importance: 5 },
            { targetId: '', name: 'Caelen Veyr’s lightsaber', type: 'object', aliases: ['Caelen’s lightsaber'], description: 'His worn lightsaber hilt.', importance: 3 },
            { targetId: caelenId, name: 'Caelen Veyr', type: 'object', aliases: ['blue crystal'], description: 'A blue proof crystal.', importance: 3 },
        ],
        facts: [], states: [], relationships: [], events: [], threads: [],
    }), { chatKey, from: 16, to: 23, allowStateUpdates: true, replayStoredExtraction: true });

    const toska = target.entities.find(item => item.name === 'Toska');
    const caelen = target.entities.find(item => item.name === 'Caelen Veyr');
    const saber = target.entities.find(item => item.name === 'Caelen Veyr’s lightsaber');
    assert.ok(toska);
    assert.equal(toska.type, 'person');
    assert.doesNotMatch(toska.aliases.join(' '), /Master/);
    assert.deepEqual(toska.aliases, []);
    assert.ok(caelen);
    assert.equal(caelen.type, 'person');
    assert.match(caelen.description, /Jedi Master/);
    assert.equal(target.entities.some(item => item.name === 'Toska’s deceased Jedi Master'), false);
    assert.ok(saber);
    assert.equal(saber.type, 'object');
    assert.notEqual(saber.id, caelen.id);
    assert.equal(target.entities.some(item => item.type === 'object' && item.name === 'Caelen Veyr'), false);
    assert.equal(target.facts.find(item => item.predicate === 'rank').subject, 'Toska');
});

test('retrieval appends high-importance established identity canon to a matching entity', () => {
    const target = world();
    target.entities.push({ id: 'caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'], description: 'A deceased Jedi.', importance: 5, sources: [] });
    target.facts.push({
        id: 'caelen-service', subject: 'Caelen Veyr', predicate: 'former identity and service',
        value: 'Jedi Master and former Jedi Council member', category: 'identity', importance: 5,
        persistence: 'persistent', sources: [],
    });

    const injected = buildMemoryPrompt(target, [{ name: 'User', mes: 'What did Caelen Veyr do?' }], 2000, 'roleplay');
    assert.match(injected.prompt, /Caelen Veyr \(person\).*established canon: former identity and service: Jedi Master and former Jedi Council member/i);
    assert.match(injected.prompt, /Facts are objective canon unless corrected/);
    assert.doesNotMatch(injected.prompt, /avoid em dashes/i);
});

test('validated placeholder targets rename in place and migrate relationship endpoints', () => {
    const target = world();
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Toska’s deceased master', type: 'person', aliases: [],
            description: 'The deceased Jedi Master who trained Toska.', importance: 5,
        }],
        relationships: [{
            from: 'Toska', to: 'Toska’s deceased master', kind: 'Jedi master and Padawan',
            status: 'ended', dynamic: 'Toska was the deceased master’s Padawan.', importance: 4,
        }],
    }), { chatKey: 'chat', from: 0, to: 7, allowStateUpdates: true });
    const placeholder = target.entities.find(item => item.name === 'Toska’s deceased master');
    const relationship = target.relationships.find(item => item.to === 'Toska’s deceased master');

    mergeExtraction(target, extraction({
        entities: [{
            targetId: placeholder.id, name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
            description: 'Caelen Veyr was Toska’s Jedi Master.', importance: 5,
        }],
        identityResolutions: [{
            reference: 'Toska’s deceased master', canonical: 'Caelen Veyr',
            evidence: 'Toska identifies her deceased master as Jedi Master Caelen Veyr.',
        }],
        relationships: [{
            targetId: relationship.id, from: 'Toska', to: 'Caelen Veyr', kind: 'Jedi master and Padawan',
            status: 'ended', dynamic: 'Toska was Caelen Veyr’s Padawan.', importance: 4,
        }],
    }), { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.entities.some(item => item.name === 'Toska’s deceased master'), false);
    assert.equal(target.entities.find(item => item.name === 'Caelen Veyr')?.id, placeholder.id);
    assert.match(target.entities.find(item => item.name === 'Caelen Veyr')?.description || '', /Jedi Master/iu);
    assert.equal(target.relationships.length, 1);
    assert.equal(target.relationships[0].to, 'Caelen Veyr');
    assert.doesNotMatch(target.relationships[0].dynamic, /deceased master/iu);
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

test('person aliases reject relationship roles while retaining names and codenames', () => {
    const target = world();
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Lucas Alcazar', type: 'person',
            aliases: ["Toska's captor", 'Sith apprentice', 'Darth Lucifer', 'Lucas'],
            description: 'A Sith known as Darth Lucifer.', importance: 5,
        }],
        events: [],
    }), { chatKey: 'roleplay', from: 0, to: 7, allowStateUpdates: true });

    assert.deepEqual(target.entities.find(item => item.name === 'Lucas Alcazar').aliases, ['Darth Lucifer', 'Lucas']);
});

test('one canonical character name cannot remain another character alias', () => {
    const target = world();
    mergeExtraction(target, extraction({
        entities: [
            { name: 'Alice Carter', type: 'person', aliases: ['Alice'], description: 'An injured trainee.', importance: 5 },
            { name: 'Doctor Vale', type: 'deceased person', aliases: ['Vale', 'Alice Carter'], description: 'Alice’s deceased mentor.', importance: 5 },
        ],
        events: [],
    }), { chatKey: 'roleplay', from: 0, to: 7, allowStateUpdates: true });

    assert.deepEqual(target.entities.find(item => item.name === 'Alice Carter').aliases, ['Alice']);
    assert.deepEqual(target.entities.find(item => item.name === 'Doctor Vale').aliases, ['Vale']);
});

test('an explicit canonical description resolves a possessive person placeholder without model reconciliation', () => {
    const target = world();
    const reference = "Toska's former Jedi master";
    mergeExtraction(target, extraction({
        entities: [{ name: reference, type: 'person', aliases: [], description: 'Toska remembers her former Master.', importance: 4 }],
        relationships: [{ from: 'Toska', to: reference, kind: 'Jedi Master and Padawan', status: 'ended', dynamic: '', importance: 4 }],
        events: [],
    }), { chatKey: 'roleplay', from: 0, to: 7, allowStateUpdates: true });
    assert.equal(target.relationships[0].to, reference);
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'],
            description: `${reference} and a former Jedi Council member.`, importance: 5,
        }],
        events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.entities.some(item => item.name === reference), false);
    assert.ok(target.entities.find(item => item.name === 'Caelen Veyr'));
    assert.equal(target.relationships[0].to, 'Caelen Veyr');
});

test('identity merging preserves established placeholder detail when a named role arrives with an attribution fallback', () => {
    const target = world();
    const reference = 'Ari Lane’s former mentor';
    mergeExtraction(target, extraction({
        entities: [{
            name: reference, type: 'person', aliases: [],
            description: 'A renowned guild master who trained Ari Lane in archival diplomacy.', importance: 5,
        }],
        relationships: [{
            from: 'Ari Lane', to: reference, kind: 'former mentor and student', status: 'ended by death',
            dynamic: 'Ari Lane was trained by her former mentor.', importance: 5,
        }],
        events: [],
    }), { chatKey: 'neutral-roleplay', from: 0, to: 7, allowStateUpdates: true });
    const relationshipId = target.relationships[0].id;

    mergeExtraction(target, extraction({
        entities: [{
            name: 'Doctor Vale', type: 'deceased guild master', aliases: ['Vale'],
            description: 'Details about Doctor Vale remain disputed or attributed in this excerpt; consult character perspectives and source history.',
            importance: 4,
        }],
        identityResolutions: [{
            reference, canonical: 'Doctor Vale',
            evidence: 'Ari Lane explicitly names Doctor Vale as her former mentor.',
        }],
        relationships: [{
            targetId: relationshipId, from: 'Ari Lane', to: 'Doctor Vale',
            kind: 'former mentor and student', status: 'ended by death',
            dynamic: 'Doctor Vale was Ari Lane’s former mentor.', importance: 5,
        }],
        events: [],
    }), { chatKey: 'neutral-roleplay', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.entities.length, 1);
    assert.equal(target.entities[0].name, 'Doctor Vale');
    assert.equal(target.entities[0].type, 'deceased guild master');
    assert.equal(target.entities[0].description, 'A renowned guild master who trained Ari Lane in archival diplomacy.');
    assert.equal(target.relationships.length, 1);
    assert.equal(target.relationships[0].id, relationshipId);
    assert.equal(target.relationships[0].to, 'Doctor Vale');
});

test('a later attribution fallback cannot erase an established concrete entity description', () => {
    const target = world();
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Doctor Vale', type: 'guild master', aliases: [],
            description: 'A former guild master and retired council member.', importance: 5,
        }],
    }), { chatKey: 'guild', from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Doctor Vale', type: 'person', aliases: [],
            description: 'Details about Doctor Vale remain disputed or attributed in this excerpt; consult character perspectives and source history.',
            importance: 3,
        }],
    }), { chatKey: 'guild', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.entities.length, 1);
    assert.equal(target.entities[0].description, 'A former guild master and retired council member.');
});

test('typed character profiles survive sparse updates and retain independent durable details', () => {
    const target = world();
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Nima', type: 'person', aliases: [], importance: 3,
            description: 'Role/background: base-born teenage acolyte and personal attendant; Appearance: short, round-cheeked, with uneven jaw-length black hair; Personality/quirks: earnest, devoted, stammering, and habitually clumsy.',
        }],
    }), { chatKey: 'rp', from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Nima', type: 'person', aliases: [], importance: 3,
            description: 'Toska’s attentive personal attendant who provides practical care.',
        }],
    }), { chatKey: 'rp', from: 8, to: 15, allowStateUpdates: true });

    assert.match(target.entities[0].description, /base-born teenage acolyte/iu);
    assert.match(target.entities[0].description, /uneven jaw-length black hair/iu);
    assert.match(target.entities[0].description, /habitually clumsy/iu);

    mergeExtraction(target, extraction({
        entities: [{
            name: 'Nima', type: 'person', aliases: [], importance: 3,
            description: 'Role/background: Toska’s trusted personal attendant; Appearance: short, round-cheeked, with uneven jaw-length black hair; Personality/quirks: earnest, increasingly confident, stammering, and prone to comic stumbles.',
        }],
    }), { chatKey: 'rp', from: 16, to: 23, allowStateUpdates: true });

    assert.equal(target.entities[0].description, 'Role/background: base-born teenage acolyte, Toska’s trusted personal attendant; Appearance: short, round-cheeked, with uneven jaw-length black hair; Personality/quirks: earnest, devoted, stammering, habitually clumsy, increasingly confident, prone to comic stumbles.');
    assert.deepEqual(target.entities[0].profile, {
        roleBackground: ['base-born teenage acolyte', 'Toska’s trusted personal attendant'],
        appearance: ['short', 'round-cheeked', 'with uneven jaw-length black hair'],
        personalityQuirks: ['earnest', 'devoted', 'stammering', 'habitually clumsy', 'increasingly confident', 'prone to comic stumbles'],
    });
});

test('unstructured person summaries replace paraphrases instead of accumulating them', () => {
    const target = world();
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Toska', type: 'person', aliases: [], importance: 4,
            description: 'Captive Jedi Padawan formerly trained by Caelen Veyr; she endured years of concealment and flight.',
        }],
    }), { chatKey: 'rp', from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        entities: [{
            name: 'Toska', type: 'person', aliases: [], importance: 4,
            description: 'Captured Jedi Padawan and former refugee child, trained primarily in Soresu by Caelen Veyr.',
        }],
    }), { chatKey: 'rp', from: 8, to: 15, allowStateUpdates: true });

    assert.equal(target.entities[0].description, 'Captured Jedi Padawan and former refugee child, trained primarily in Soresu by Caelen Veyr.');
});

test('stored extraction paraphrases compact without erasing unrelated profile details', () => {
    const target = world();
    target.entities.push({
        name: 'Toska', type: 'person', aliases: [], importance: 4,
        description: 'Captive Jedi Padawan and Caelen Veyr’s former apprentice; guarded and defiant. Captive Jedi Padawan formerly trained by Caelen Veyr; she endured years of concealment and flight. Captured Jedi Padawan and former refugee child, trained primarily in Soresu by Caelen Veyr. Captive Jedi Padawan and former student of the deceased Caelen Veyr. Toska was the Jedi Padawan of the now-dead former Jedi Master. She has cropped auburn hair and a scarred left hand. She habitually counts exits before sitting.',
    });

    assert.equal(compactRepeatedEntityDescriptions(target), 1);
    assert.equal(target.entities[0].description, 'Captive Jedi Padawan and Caelen Veyr’s former apprentice; guarded and defiant. She has cropped auburn hair and a scarred left hand. She habitually counts exits before sitting.');
});

test('different biographical facts remain separate during description compaction', () => {
    const target = world();
    const established = 'Caelen Veyr was a Jedi Master. He trained Toska in Soresu. He served on the Jedi Council.';
    target.entities.push({ name: 'Caelen Veyr', type: 'person', aliases: [], importance: 5, description: established });

    assert.equal(compactRepeatedEntityDescriptions(target), 0);
    assert.equal(target.entities[0].description, established);
});

test('equivalent concealed-identity knowledge boundaries collapse to one canonical fact', () => {
    const target = world();
    target.entities.push(
        { id: 'toska', name: 'Toska', type: 'person', aliases: [], description: '', importance: 4 },
        { id: 'lucas', name: 'Lucas Alcazar', type: 'person', aliases: [], description: '', importance: 4 },
    );
    target.facts.push(
        {
            id: 'boundary_old', subject: 'Toska', predicate: 'knowledge of Lucas Alcazar — concealed identity',
            category: 'knowledge boundary', value: 'Toska does not know the Sith is Lucas Alcazar.', importance: 5,
            updatedAt: '2026-01-01T00:00:00.000Z', sources: [],
        },
        {
            id: 'boundary_new', subject: 'Toska', predicate: 'knowledge of Lucas Alcazar’s identity',
            category: 'knowledge gap', value: 'Toska still does not know the current figure is Lucas Alcazar.', importance: 5,
            updatedAt: '2026-01-02T00:00:00.000Z', sources: [],
        },
    );

    mergeExtraction(target, extraction({
        entities: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [],
    }), { chatKey: 'rp', from: 0, to: 7, allowStateUpdates: true });

    const boundaries = target.facts.filter(item => item.subject === 'Toska' && /knowledge of Lucas Alcazar/iu.test(item.predicate));
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].predicate, 'knowledge of Lucas Alcazar’s identity');
    assert.equal(boundaries[0].category, 'knowledge gap');
});

test('visible semantic duplicates compact by category while distinct chronology remains', () => {
    const target = world();
    target.entities.push(
        { id: 'toska', name: 'Toska', type: 'person', aliases: [], description: '', importance: 4 },
        { id: 'lucas', name: 'Lucas Alcazar', type: 'person', aliases: [], description: '', importance: 4 },
        { id: 'pilot', name: 'Loyalist Pilot', type: 'person', aliases: [], description: '', importance: 3 },
    );
    target.threads.push(
        {
            id: 'thread_old', title: 'Recover Toska’s green lightsaber', detail: 'A team must recover Toska’s green lightsaber from the desert hut.',
            status: 'open', participants: ['Toska', 'Lucas Alcazar'], importance: 4, updatedAt: '2026-01-01T00:00:00.000Z', sources: [],
        },
        {
            id: 'thread_new', title: 'Recovery of Toska’s green lightsaber', detail: 'The retrieval team must recover Toska’s green lightsaber from the desert-world hut.',
            status: 'open', participants: ['Lucas Alcazar', 'Toska'], importance: 4, updatedAt: '2026-01-02T00:00:00.000Z', sources: [],
        },
    );
    target.backgrounds.push(
        { id: 'bg_old', topic: 'Moon-base landing-defense fault', summary: 'The landing-defense turret fault remains under diagnosis.', status: 'active', participants: [], updatedAt: '2026-01-01T00:00:00.000Z', sources: [] },
        { id: 'bg_new', topic: 'Landing defense fault at the moon base', summary: 'The moon-base landing-defense turret fault remains under diagnosis.', status: 'active', participants: [], updatedAt: '2026-01-02T00:00:00.000Z', sources: [] },
    );
    const sharedEvent = {
        participants: ['Lucas Alcazar', 'Toska', 'Loyalist Pilot'], location: 'Moonbase private landing bay', importance: 4,
    };
    target.events.push(
        {
            ...sharedEvent, id: 'event_old', title: 'Lucas removes Toska’s restraint',
            summary: 'Lucas unclips Toska’s wrist restraint and orders the pilot to open the shuttle hatch.',
            updatedAt: '2026-01-01T00:00:00.000Z', sources: [{ chatKey: 'rp', from: 48, to: 55 }],
        },
        {
            ...sharedEvent, id: 'event_new', title: 'Lucas releases Toska and opens the shuttle hatch',
            summary: 'Lucas removed Toska’s wrist restraint and ordered the Loyalist Pilot to open the shuttle hatch.',
            updatedAt: '2026-01-02T00:00:00.000Z', sources: [{ chatKey: 'rp', from: 56, to: 63 }],
        },
        {
            ...sharedEvent, id: 'event_later', title: 'Lucas restrains Toska during a later escape',
            summary: 'Much later, Lucas restrains Toska after a separate escape attempt.',
            updatedAt: '2026-01-03T00:00:00.000Z', sources: [{ chatKey: 'rp', from: 160, to: 167 }],
        },
    );

    assert.equal(compactDuplicateMemoryRecords(target), 3);
    assert.equal(target.threads.length, 1);
    assert.equal(target.backgrounds.length, 1);
    assert.equal(target.events.length, 2);
    assert.ok(target.events.some(item => item.id === 'event_new'));
    assert.ok(target.events.some(item => item.id === 'event_later'));
});

test('semantic entity compaction merges possessive and closed-compound names and rewrites references', () => {
    const target = world();
    target.entities.push(
        {
            id: 'base_owned', name: 'Mara’s hidden moon base', type: 'place', aliases: ['private moon base'],
            description: 'A concealed mobile moon base controlled by Mara with isolated landing procedures.', importance: 4, sources: [],
        },
        {
            id: 'base_short', name: 'Hidden Moonbase', type: 'mobile secret fortress', aliases: [],
            description: 'A mobile moonbase concealed from outside detection with a private landing bay.', importance: 4, sources: [],
        },
    );
    target.facts.push({
        id: 'fact_base', subject: 'Hidden Moonbase', predicate: 'security', value: 'Hidden Moonbase avoids outside detection.',
        category: 'security', persistence: 'persistent', sources: [],
    });
    target.events.push({
        id: 'event_base', title: 'Arrival', summary: 'Mara arrives at Hidden Moonbase.', participants: ['Mara', 'Hidden Moonbase'], sources: [],
    });

    assert.equal(compactDuplicateMemoryRecords(target), 1);
    assert.equal(target.entities.length, 1);
    assert.equal(target.facts[0].subject, target.entities[0].name);
    assert.equal(target.events[0].participants[1], target.entities[0].name);
});

test('semantic entity compaction preserves unrelated entities between duplicate candidates', () => {
    const target = world();
    target.entities.push(
        {
            id: 'owned_house', name: 'Mara’s hidden safe house', type: 'place', aliases: [],
            description: 'A concealed safe house with a private landing bay and sealed records.', importance: 4,
        },
        {
            id: 'unrelated', name: 'Archive Tower', type: 'place', aliases: [],
            description: 'A public archive tower in the capital.', importance: 2,
        },
        {
            id: 'closed_house', name: 'Hidden Safehouse', type: 'secure place', aliases: [],
            description: 'A concealed safehouse with a private landing bay and sealed records.', importance: 4,
        },
    );

    assert.equal(compactDuplicateMemoryRecords(target), 1);
    assert.equal(target.entities.length, 2);
    assert.ok(target.entities.some(item => item.name === 'Archive Tower'));
    assert.ok(target.entities.some(item => item.name === 'Hidden Safehouse'));
});

test('stored composite state subjects compact into independent entity-owned states', () => {
    const target = world();
    target.entities.push(
        { id: 'mara', name: 'Mara', type: 'person', aliases: [] },
        { id: 'sol', name: 'Sol', type: 'person', aliases: [] },
    );
    target.states.push({
        id: 'state_location', subject: 'Mara and Sol', attribute: 'location', value: 'Inside the archive vault.',
        previous: 'Outside the archive vault.', scope: 'scene', operation: 'set', sources: [],
    });

    assert.equal(compactDuplicateMemoryRecords(target), 1);
    assert.deepEqual(target.states.map(item => item.subject), ['Mara', 'Sol']);
    assert.equal(new Set(target.states.map(item => item.id)).size, 2);
});

test('stored reconciliation repairs established records using processed messages only', () => {
    const target = world();
    target.entities.push(
        { id: 'ari', name: 'Ari Lane', type: 'person', aliases: [], description: '', importance: 4 },
        { id: 'vale', name: 'Doctor Vale', type: 'person', aliases: [], description: '', importance: 4 },
        { id: 'nox', name: 'Courier Nox', type: 'person', aliases: [], description: '', importance: 3 },
        { id: 'toska', name: 'Toska', type: 'person', aliases: [], description: '', importance: 4 },
        { id: 'lucas', name: 'Lucas Alcazar', type: 'person', aliases: [], description: '', importance: 4 },
    );
    target.facts.push({
        id: 'fact_apprentice', subject: 'Ari Lane', predicate: 'former apprentice of Doctor Vale',
        value: 'Ari Lane was Doctor Vale’s former apprentice before Courier Nox delivered her archived records.',
        category: 'biographical history', persistence: 'persistent', importance: 4, sources: [],
    }, {
        id: 'fact_hiding', subject: 'Ari Lane', predicate: 'experience of life in hiding',
        value: 'Ari Lane describes years of scarce food, cramped rooms, repeated relocation, and sensing danger while living in hiding.',
        category: 'personal history', persistence: 'persistent', importance: 4, sources: [],
    });
    target.facts.push({
        id: 'fact_misowned', subject: 'Lucas Alcazar', predicate: 'belief about Toska — knowledge of the hidden base',
        value: 'Toska now knows that Lucas controls the hidden base.', category: 'character belief', persistence: 'persistent', importance: 3, sources: [],
    });
    target.capsules.push({
        beats: ['Ari Lane describes years of scarce food, cramped rooms, repeated relocation, and sensing danger while living in hiding.'],
    });
    target.threads.push(
        {
            id: 'thread_hiding', title: 'Answer Ari Lane’s life in hiding',
            detail: 'Ari Lane has not yet described how she lived in hiding.', status: 'open',
            participants: ['Ari Lane', 'Doctor Vale'], importance: 3,
        },
        {
            id: 'thread_destination', title: 'Answer Ari Lane’s current destination',
            detail: 'Ari Lane’s current destination remains unknown.', status: 'open',
            participants: ['Ari Lane'], importance: 3,
        },
    );
    target.sources.roleplay = {
        processedMessages: [{ index: 4, fingerprint: 'processed', version: EXTRACTION_VERSION }],
    };
    const messages = [
        {
            index: 4, name: 'Narrator',
            text: 'Ari Lane was Doctor Vale’s former apprentice. Ari Lane describes years of scarce food, cramped rooms, repeated relocation, and sensing danger while living in hiding.',
        },
        {
            index: 5, name: 'Narrator',
            text: 'Ari Lane states that her current destination is the North Tower.',
        },
    ];

    assert.ok(compactDuplicateMemoryRecords(target, messages) >= 2);
    assert.ok(target.relationships.some(item =>
        [item.from, item.to].includes('Ari Lane') && [item.from, item.to].includes('Doctor Vale')));
    assert.equal(target.facts.find(item => item.id === 'fact_misowned').subject, 'Toska');
    assert.equal(target.facts.find(item => item.id === 'fact_misowned').category, 'knowledge');
    assert.equal(target.threads.find(item => item.id === 'thread_hiding').status, 'resolved');
    assert.equal(target.threads.find(item => item.id === 'thread_destination').status, 'open');
});

test('stored relationship compaction removes a repeated command lead with an article', () => {
    const target = world();
    target.relationships.push({
        id: 'relationship_pilot', from: 'Doctor Vale', to: 'Archive Pilot', kind: 'commander and retainer', status: 'active',
        dynamic: 'Doctor Vale commands the Archive Pilot, who maintains the approach; Doctor Vale commands the Archive Pilot, who opens the hatch.',
    });

    compactDuplicateMemoryRecords(target);
    assert.equal(target.relationships[0].dynamic, 'Doctor Vale commands the Archive Pilot, who maintains the approach; Archive Pilot opens the hatch.');
});

test('composite identity evidence upgrades a placeholder relationship in place', () => {
    const target = world();
    const chatKey = 'roleplay';
    const first = extraction({
        entities: [
            { name: 'Toska', type: 'person', aliases: [], description: 'A Jedi Padawan.', importance: 5 },
            { name: 'Toska’s former Jedi Master', type: 'person', aliases: [], description: 'A deceased Jedi Master.', importance: 5 },
        ],
        relationships: [{
            from: 'Toska', to: 'Toska’s former Jedi Master', kind: 'Jedi Master and Padawan', status: 'ended by death',
            dynamic: 'Relationship between Toska and Toska’s former Jedi Master: Toska was his Padawan and grieves him.', importance: 5,
        }],
        events: [],
    });
    sanitizeReconciliationMetadata(first, target);
    mergeExtraction(target, first, { chatKey, from: 0, to: 7, allowStateUpdates: true });
    const relationshipId = target.relationships[0].id;

    const second = extraction({
        entities: [{
            name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
            description: 'Toska’s deceased former Jedi Master, identified as Caelen Veyr.', importance: 5,
        }],
        identityResolutions: [{
            reference: 'the dead Jedi / Toska’s former Master / Pell', canonical: 'Caelen Veyr',
            evidence: 'Toska explicitly identifies her deceased former Master as Caelen Veyr and says he used the name Pell.',
        }],
        relationships: [{
            targetId: relationshipId, from: 'Toska', to: 'Caelen Veyr', kind: 'Jedi Master and Padawan', status: 'ended by death',
            dynamic: 'Relationship between Toska and Caelen Veyr: Caelen Veyr was Toska’s Jedi Master; Toska remains loyal to and grieving for him.', importance: 5,
        }],
        events: [],
    });
    const validation = sanitizeReconciliationMetadata(second, target);
    mergeExtraction(target, second, { chatKey, from: 8, to: 15, allowStateUpdates: true });

    assert.equal(validation.relationshipEndpointConflicts.length, 0);
    assert.equal(target.entities.some(item => item.name === 'Toska’s former Jedi Master'), false);
    assert.equal(target.relationships.length, 1);
    assert.equal(target.relationships[0].id, relationshipId);
    assert.equal(target.relationships[0].to, 'Caelen Veyr');
    assert.match(target.relationships[0].dynamic, /Relationship between Toska and Caelen Veyr/u);
});

test('reversed relationship endpoints update one description-first canonical pair', () => {
    const target = world();
    const chatKey = 'roleplay';
    mergeExtraction(target, extraction({
        relationships: [{
            from: 'Toska', to: 'Nima', kind: 'mistress and personal attendant', status: 'active',
            dynamic: 'Toska is Nima’s mistress, and Nima serves Toska as her personal attendant.', importance: 4,
        }],
        events: [],
    }), { chatKey, from: 72, to: 79, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        relationships: [{
            from: 'Nima', to: 'Toska', kind: 'protective attendant and encouraged senior', status: 'active',
            dynamic: 'Nima remains Toska’s personal attendant and now provides protective recovery care; Toska accepts and encourages Nima’s help.', importance: 4,
        }],
        events: [],
    }), { chatKey, from: 160, to: 167, allowStateUpdates: true });

    assert.equal(target.relationships.length, 1);
    assert.equal(target.relationships[0].from, 'Toska');
    assert.equal(target.relationships[0].to, 'Nima');
    assert.equal(target.relationships[0].kind, 'mistress and personal attendant');
    assert.match(target.relationships[0].dynamic, /Nima remains Toska’s personal attendant/);
    assert.deepEqual(target.relationships[0].sources.map(source => [source.from, source.to]), [[72, 79], [160, 167]]);
});

test('a clean zero-correction replay preserves identity, prior knowledge, secrecy, and current meeting continuity', () => {
    const target = world();
    const chatKey = 'roleplay';
    const first = extraction({
        scene: null,
        entities: [
            { name: 'Lucas Alcazar', type: 'person', aliases: ["Toska's captor"], description: "A Sith who killed Toska's former Jedi master.", importance: 5 },
            { name: 'Toska', type: 'person', aliases: ['Jedi Padawan'], description: 'A captive Padawan.', importance: 5 },
            { name: 'Darth Segundus', type: 'person', aliases: ["Lucas's master"], description: "Lucas's Sith master.", importance: 5 },
            { name: "Toska's former Jedi master", type: 'person', aliases: [], description: 'A formerly renowned Jedi Master.', importance: 5 },
        ],
        facts: [{ subject: 'Lucas Alcazar', predicate: 'intent to conceal Toska from Darth Segundus', value: 'Toska remains hidden.', category: 'intention', importance: 5, persistence: 'persistent' }],
        relationships: [{ from: 'Toska', to: "Toska's former Jedi master", kind: 'Jedi Master and Padawan', status: 'ended', dynamic: '', importance: 5 }],
        events: [], threads: [],
    });
    sanitizeReconciliationMetadata(first, target, []);
    mergeExtraction(target, first, { chatKey, from: 0, to: 7, allowStateUpdates: true });

    const identity = extraction({
        scene: null,
        entities: [{ name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'], description: "Toska's former Jedi master and a former Council member.", importance: 5 }],
        facts: [{ subject: 'Caelen Veyr', predicate: 'former identity and service', value: 'Jedi Master and former Jedi Council member', category: 'biography', importance: 5, persistence: 'persistent' }],
        relationships: [], events: [], threads: [],
    });
    sanitizeReconciliationMetadata(identity, target, []);
    mergeExtraction(target, identity, { chatKey, from: 8, to: 15, allowStateUpdates: true });

    const recognition = extraction({
        scene: { location: 'Audience chamber', time: 'Morning', participants: ['Lucas Alcazar', 'Darth Segundus'], activity: "Lucas presents Caelen Veyr's proof to Segundus.", mood: 'Confrontational' },
        sceneCapsule: {
            ...extraction().sceneCapsule,
            title: 'Earlier masked call', participants: ['Lucas Alcazar', 'Darth Segundus', 'Caelen Veyr'],
            beats: ['Segundus cites the archive record for Jedi Master Caelen Veyr, while Lucas disputes its classification.'],
        },
        entities: [], facts: [], relationships: [], threads: [],
        events: [{ title: 'Segundus cites Caelen record', summary: 'Segundus cites the archive record for Jedi Master Caelen Veyr.', participants: ['Lucas Alcazar', 'Darth Segundus', 'Caelen Veyr'], location: 'Comms sanctum', storyTime: 'Earlier', consequences: '', importance: 5, temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'explicit' } }],
    });
    sanitizeReconciliationMetadata(recognition, target, []);
    mergeExtraction(target, recognition, { chatKey, from: 80, to: 87, allowStateUpdates: true });

    assert.deepEqual(target.corrections, []);
    assert.equal(target.entities.some(item => item.name === "Toska's former Jedi master"), false);
    assert.equal(target.relationships.find(item => /Jedi Master and Padawan/i.test(item.kind)).to, 'Caelen Veyr');
    assert.ok(target.facts.some(item => item.subject === 'Darth Segundus' && item.predicate === 'knowledge of Toska' && item.category === 'knowledge boundary'));
    assert.ok(target.facts.some(item => item.subject === 'Darth Segundus' && item.predicate === 'knowledge of Caelen Veyr' && item.category === 'knowledge'));

    const injected = buildMemoryPrompt(target, [{ name: 'Lucas', mes: 'Did you know it was a Jedi Council Member there?' }], 5000, chatKey);
    assert.match(injected.prompt, /Established character knowledge:[\s\S]*Darth Segundus — knowledge of Caelen Veyr/i);
    assert.match(injected.prompt, /Caelen Veyr \(person\).*Jedi Master and former Jedi Council member/i);

    const secrecy = buildMemoryPrompt(target, [{ name: 'Lucas', mes: 'Does Darth Segundus know Toska?' }], 5000, chatKey);
    assert.match(secrecy.prompt, /Darth Segundus — knowledge of Toska.*HARD LIMIT/i);
});

test('later explicit knowledge retires the matching stale knowledge boundary', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Darth Segundus', predicate: 'knowledge of Toska',
            value: 'Toska is deliberately concealed from Darth Segundus; no disclosure is established.',
            category: 'knowledge boundary', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 0, to: 7, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Darth Segundus', predicate: 'knowledge of Toska',
            value: 'Darth Segundus has now learned that Toska is alive.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    const records = target.facts.filter(item => item.subject === 'Darth Segundus' && item.predicate === 'knowledge of Toska');
    assert.equal(records.length, 1);
    assert.equal(records[0].category, 'knowledge');
    assert.match(records[0].value, /has now learned/i);
});

test('a learned canonical identity retires an older not-yet-known identity boundary', () => {
    const target = world();
    const predicate = 'knowledge of Toska’s former Jedi Master’s identity';
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Lucas Alcazar', predicate,
            value: 'Lucas is asking Toska for the Master’s true name and former identity; the answer is not yet known.',
            category: 'knowledge boundary', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 0, to: 7, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Lucas Alcazar', predicate,
            value: 'Lucas knows that Caelen Veyr was a member of the High Council and had a former apprentice.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    const records = target.facts.filter(item => item.subject === 'Lucas Alcazar' && item.predicate === predicate);
    assert.equal(records.length, 1);
    assert.equal(records[0].category, 'knowledge');
    assert.match(records[0].value, /Caelen Veyr/iu);
    assert.doesNotMatch(records[0].value, /not yet known/iu);
});

test('a later remembered identity retires an older no-answer-yet clause', () => {
    const target = world();
    const predicate = 'knowledge of Caelen Veyr';
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate,
            value: 'Lucas has asked whether she knows his true name and former identity; no answer has yet been given.',
            category: 'knowledge', importance: 4, persistence: 'temporary',
        }], events: [],
    }), { chatKey: 'roleplay', from: 0, to: 7, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate,
            value: 'Toska remembers Caelen Veyr’s concealed records and identifies him as her former Jedi Master.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    const record = target.facts.find(item => item.subject === 'Toska' && item.predicate === predicate);
    assert.match(record.value, /identifies him as her former Jedi Master/iu);
    assert.doesNotMatch(record.value, /no answer has yet been given/iu);
});

test('later knowledge of the same subject adds detail without erasing established history', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska identifies Caelen Veyr as a Jedi Master and former Jedi Council member.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });
    const stableId = target.facts[0].id;

    mergeExtraction(target, extraction({
        facts: [{
            targetId: stableId, subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska now knows Caelen previously trained an apprentice named Lucas Alcazar.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 16, to: 23, allowStateUpdates: true });

    const record = target.facts.find(item => item.id === stableId);
    assert.match(record.value, /Jedi Master and former Jedi Council member/iu);
    assert.match(record.value, /apprentice named Lucas Alcazar/iu);
});

test('newly established knowledge replaces an older negative clause for the same canonical topic', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska knows Caelen used the name Pell; she did not know he held a Council seat.',
            category: 'knowledge', importance: 4, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska identifies Caelen Veyr as a former Council member who used the name Pell.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 16, to: 23, allowStateUpdates: true });

    const record = target.facts.find(item => item.subject === 'Toska' && item.predicate === 'knowledge of Caelen Veyr');
    assert.match(record.value, /former Council member/iu);
    assert.doesNotMatch(record.value, /did not know/iu);
});

test('mixed knowledge updates retire a stale boundary while preserving a different gap', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'She has not yet disclosed whether she knows his true name or what he was before.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }],
    }), { chatKey: 'chat', from: 0, to: 7, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'She knows his true name is Caelen Veyr and that he served as an investigator; she did not know he had a former apprentice.',
            category: 'knowledge', importance: 5, persistence: 'persistent',
        }],
    }), { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });

    const facts = target.facts.filter(item => item.subject === 'Toska' && item.predicate === 'knowledge of Caelen Veyr');
    assert.equal(facts.length, 1);
    assert.match(facts[0].value, /knows his true name is Caelen Veyr/iu);
    assert.match(facts[0].value, /did not know he had a former apprentice/iu);
    assert.doesNotMatch(facts[0].value, /not yet disclosed/iu);
});

test('a broad knowledge update does not erase a different unresolved subtopic', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska knows Caelen used the name Pell; she did not know he was a Council member or had an earlier apprentice.',
            category: 'knowledge', importance: 4, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska identifies Caelen as a High Council investigator and fleet commander who used the name Pell.',
            category: 'knowledge', importance: 4, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 16, to: 23, allowStateUpdates: true });

    const record = target.facts.find(item => item.subject === 'Toska' && item.predicate === 'knowledge of Caelen Veyr');
    assert.match(record.value, /High Council investigator/iu);
    assert.match(record.value, /did not know.*Council member.*earlier apprentice/iu);
});

test('a positive update mislabeled as a boundary becomes established knowledge', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Darth Segundus', predicate: 'knowledge of Toska', value: 'Darth Segundus does not know Toska exists.',
            category: 'knowledge boundary', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 0, to: 7, allowStateUpdates: true });

    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Darth Segundus', predicate: 'knowledge of Toska', value: 'Darth Segundus is now aware of Toska.',
            category: 'knowledge boundary', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    const record = target.facts.find(item => item.subject === 'Darth Segundus' && item.predicate === 'knowledge of Toska');
    assert.equal(record.category, 'knowledge');
    assert.match(record.value, /now aware/i);
});

test('current knowledge overrides a historical did-not-know clause in the same update', () => {
    const target = world();
    mergeExtraction(target, extraction({
        facts: [{
            subject: 'Ari Lane', predicate: 'knowledge of Doctor Vale’s former student',
            value: 'Ari now knows the former student was Borin; she previously did not know his identity.',
            category: 'knowledge boundary', importance: 5, persistence: 'persistent',
        }], events: [],
    }), { chatKey: 'roleplay', from: 8, to: 15, allowStateUpdates: true });

    const record = target.facts.find(item => item.subject === 'Ari Lane');
    assert.equal(record.category, 'knowledge');
    assert.match(record.value, /now knows/iu);
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
    assert.match(result.prompt, /They plan to rehearse Saturday/);
    assert.match(result.prompt, /Recent continuity:/);
    assert.ok(result.estimatedTokens <= 1200);
});

test('retrieval prioritizes relevant forms of address in one compact section', () => {
    const target = world();
    target.entities.push(
        { id: 'naruto', name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        { id: 'setsuko', name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
    );
    target.facts.push(
        {
            id: 'address-forward', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'Uzumaki-kun; dead last',
            category: 'form of address', importance: 2, persistence: 'persistent',
        },
        {
            id: 'address-reverse', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Setsuko; Suki-chan',
            category: 'form of address', importance: 2, persistence: 'persistent',
        },
    );

    const result = buildMemoryPrompt(target, [{ name: 'Setsuko', mes: 'Naruto arrives for training.' }], 1000, 'chat');

    assert.match(result.prompt, /Addresses:/);
    assert.match(result.prompt, /Setsuko Uchiha→Naruto Uzumaki: Uzumaki-kun; dead last/);
    assert.match(result.prompt, /Naruto Uzumaki→Setsuko Uchiha: Setsuko; Suki-chan/);
    assert.match(result.prompt, / \| /);
    assert.equal(result.prompt.match(/Uzumaki-kun/g)?.length, 1);
    assert.equal(result.prompt.match(/Suki-chan/g)?.length, 1);
    assert.ok(result.estimatedTokens <= 1000);
});

test('retrieval reserves room for every populated memory category', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'Yui and Mio continue their music practice, friendship, cake, and weekend performance plans.' }], 1000, 'chat');
    for (const heading of [
        'Checkpoint',
        'Recursive Chronicle layers (complete active frontier)',
        'Open matters',
        'Entities',
        'Current state',
        'Relationships',
        'Facts',
        'Past events',
    ]) assert.match(result.prompt, new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
    assert.ok(result.estimatedTokens <= 1000);
});

test('retrieval makes a relevant character knowledge boundary an explicit hard constraint', () => {
    const target = world();
    target.entities.push(
        { id: 'lucas', name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'], description: 'A Sith.', importance: 5 },
        { id: 'segundus', name: 'Darth Segundus', type: 'person', aliases: ['Segundus'], description: 'Lucas’s master.', importance: 5 },
        { id: 'toska', name: 'Toska', type: 'person', aliases: [], description: 'Hidden at Lucas’s moonbase.', importance: 5 },
    );
    target.facts.push({
        id: 'segundus-toska-boundary',
        subject: 'Darth Segundus',
        predicate: 'knowledge of Toska',
        value: 'Does not know Toska exists or that Lucas took her alive; Lucas has provided no disclosure or evidence until an explicit later disclosure.',
        category: 'knowledge boundary',
        persistence: 'persistent',
        importance: 5,
    });
    target.events.push({
        id: 'toska-capture', title: 'Lucas captures Toska', summary: 'Lucas secretly takes Toska alive.',
        participants: ['Lucas Alcazar', 'Toska'], importance: 5,
    });

    const result = buildMemoryPrompt(target, [
        { name: 'Narrator', is_user: false, mes: 'Darth Segundus studies Lucas across the audience chamber.' },
        { name: 'User', is_user: true, mes: 'I ask Segundus whether he expected me to die.' },
    ], 2200, 'chat', ['Darth Segundus reaction to Lucas']);

    assert.match(result.prompt, /Knowledge boundaries — hard constraints:/);
    assert.match(result.prompt, /Darth Segundus — knowledge of Toska: Does not know Toska exists/i);
    assert.match(result.prompt, /HARD LIMIT: world truth elsewhere does not grant this character knowledge/i);
    assert.doesNotMatch(result.prompt, /exact anchor unavailable/i);
    assert.equal(result.prompt.match(/knowledge of Toska/g)?.length, 1);
});

test('retrieval does not fill category space with unrelated memories', () => {
    const target = world();
    mergeExtraction(target, extraction(), { chatKey: 'chat', from: 0, to: 4, allowStateUpdates: true });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: 'A distant storm approaches the harbor.' }], 3000, 'chat');
    assert.match(result.prompt, /Checkpoint:/);
    assert.match(result.prompt, /Recursive Chronicle layers/);
    assert.doesNotMatch(result.prompt, /Facts:/);
    assert.doesNotMatch(result.prompt, /Past events:/);
    assert.doesNotMatch(result.prompt, /favorite snack/);
});

test('retrieval admits strong recall matches but rejects context-only and weak generic matches', () => {
    const target = world();
    target.facts = [
        {
            id: 'fact-trading-house', subject: 'Subaru Natsuki', predicate: 'visited trading house',
            value: 'Subaru accompanied Samael and Felt during the trading-house negotiation.', importance: 3,
        },
        {
            id: 'fact-loot-house', subject: 'Felt', predicate: 'remembers Subaru',
            value: 'Felt previously met Subaru at the loot house.', importance: 3,
        },
        {
            id: 'fact-rabies', subject: 'Rabies', predicate: 'is an illness',
            value: 'Fear of water appears after the infection reaches the brain.', importance: 3,
        },
        {
            id: 'fact-flowers', subject: 'Emilia', predicate: 'belief about flowers',
            value: 'White flowers once reminded Emilia of frost.', importance: 3,
        },
    ];
    const recent = [
        {
            name: 'Narrator', is_user: false,
            mes: '<stat>Psyche: fear of abandonment</stat><background_updates>Emilia tends white flowers.</background_updates>Felt waits with Subaru.',
        },
        { name: 'User', is_user: true, mes: 'He was the one with us at the trading house.' },
    ];

    const result = buildMemoryPrompt(target, recent, 12000, 'chat', ['previously met Subaru', 'former trading-house associate']);

    assert.match(result.prompt, /visited trading house/);
    assert.match(result.prompt, /remembers Subaru/);
    assert.doesNotMatch(result.prompt, /Rabies/);
    assert.doesNotMatch(result.prompt, /White flowers/);
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
    assert.match(result.prompt, /Recursive Chronicle layers/);
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
    const selectedL2 = result.prompt.match(/L2 continuity:\n([\s\S]*?)(?:\n\n|<\/continuity>)/)?.[1] || '';
    assert.match(selectedL2, /Strong match/);
    assert.match(selectedL2, /High five/);
    assert.doesNotMatch(selectedL2, /High four/);
});

test('multilingual injection soft-overflows its recall target instead of clipping a complete row', () => {
    const target = world();
    target.entities.push({ id: 'wide', name: '台灣', type: 'place', description: `${'狀'.repeat(2500)}完整結尾`, importance: 3 });
    const result = buildMemoryPrompt(target, [{ name: 'User', mes: '台灣' }], 1000);
    assert.ok(result.estimatedTokens > 1000);
    assert.match(result.prompt, /完整結尾/u);
    assert.doesNotMatch(result.prompt, /…/u);
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
    target.chronicle = [];
    target.storySoFar = {};
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
    target.chronicle = [];
    target.storySoFar = {};
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
    target.chronicle = [];
    target.storySoFar = {};
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

test('fresh rebuild reset preserves reviewed corrections and corrected guardrail records', () => {
    const target = world();
    target.entities.push({ id: 'ordinary', name: 'Ordinary record' });
    target.facts.push({
        id: 'corrected-fact', subject: 'Darth Segundus', predicate: 'knowledge of Toska',
        value: 'Darth Segundus does not know Toska exists.', category: 'knowledge boundary',
        persistence: 'persistent', importance: 5, correctionId: 'correction-1',
        sources: [{ kind: 'correction', correctionId: 'correction-1' }],
    });
    target.corrections = [{
        id: 'correction-1', summary: 'Segundus does not know Toska exists.', operations: [{
            action: 'add', category: 'facts', recordId: 'corrected-fact', beforeSelector: '',
            after: { subject: 'Darth Segundus', predicate: 'knowledge of Toska', value: 'Darth Segundus does not know Toska exists.', category: 'knowledge boundary', persistence: 'persistent', importance: 5 },
        }],
    }];

    resetWorldMemory(target, { preserveCorrections: true });

    assert.deepEqual(target.entities, []);
    assert.equal(target.corrections.length, 1);
    assert.equal(target.facts.length, 1);
    assert.equal(target.facts[0].id, 'corrected-fact');
    assert.equal(target.facts[0].correctionId, 'correction-1');
    assert.deepEqual(target.sources, {});
    assert.deepEqual(freshResetResiduals(target, { allowCorrections: true }), []);
    assert.deepEqual(freshResetResiduals(target), ['corrections:1', 'facts:1']);
});

test('fresh rebuild verification detects stale records left after a claimed reset', () => {
    const target = world();
    target.relationships.push({
        id: 'relationship_stale', from: 'Lucas Alcazar', to: 'Caelen Veyr',
        dynamic: 'Stale relationship from an earlier scan.',
    });
    target.sources.chat = { processedMessages: [{ index: 0, version: 18 }] };

    assert.deepEqual(freshResetResiduals(target), ['sources', 'relationships:1']);
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

test('established identity history enriches a sparse relationship-backed person description', () => {
    const target = world();
    const result = extraction({
        entities: [
            { name: 'Toska', type: 'person', aliases: [], description: 'A Jedi Padawan.', importance: 4 },
            { name: 'Caelen Veyr', type: 'person', aliases: ['Pell'], description: 'Details about Caelen Veyr remain disputed or attributed in this excerpt; consult character perspectives and source history.', importance: 4 },
        ],
        facts: [{
            subject: 'Caelen Veyr', predicate: 'former roles and concealment identity',
            value: 'Former High Council member and commander of the Republic’s Twelfth Reconnaissance Fleet.',
            category: 'identity and history', importance: 4, persistence: 'persistent',
        }],
        relationships: [{
            from: 'Toska', to: 'Caelen Veyr', kind: 'Jedi master and Padawan', status: 'ended',
            dynamic: 'Caelen Veyr was Toska’s deceased Jedi master.', importance: 4,
        }],
        states: [], events: [], threads: [], backgrounds: [],
    });

    mergeExtraction(target, result, { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: true });

    const caelen = target.entities.find(item => item.name === 'Caelen Veyr');
    assert.match(caelen.description, /deceased Jedi master/iu);
    assert.match(caelen.description, /High Council member/iu);
    assert.match(caelen.description, /Twelfth Reconnaissance Fleet/iu);

    mergeExtraction(target, extraction({
        entities: [{ name: 'Caelen Veyr', type: 'person', aliases: ['Pell'], description: 'Caelen Veyr was Toska’s Jedi Master.', importance: 4 }],
        facts: [], relationships: [], states: [], events: [], threads: [], backgrounds: [],
    }), { chatKey: 'chat', from: 16, to: 23, allowStateUpdates: true });

    assert.match(target.entities.find(item => item.name === 'Caelen Veyr').description, /High Council member/iu);
    assert.match(target.entities.find(item => item.name === 'Caelen Veyr').description, /Twelfth Reconnaissance Fleet/iu);
});
