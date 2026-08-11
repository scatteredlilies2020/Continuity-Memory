import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCorrectionProposal, augmentCorrectionChronology, isSuppressedByCorrection, selectCorrectionContext, validateCorrectionProposal } from '../extension/memory-correction.js';
import { mergeExtraction } from '../extension/memory-model.js';
import { buildEmbeddingDocuments } from '../extension/embedding-index.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';

function memoryWorld() {
    return {
        id: 'world', revision: 3, scene: null,
        entities: [], states: [], relationships: [], threads: [], extractions: [], corrections: [], sources: {},
        facts: [{
            id: 'fact-knowledge', subject: 'Sasuke', predicate: 'knowledge of Elizabeth', value: 'Learned her identity during the tower meeting',
            category: 'knowledge', persistence: 'persistent', importance: 4, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            sources: [{ chatKey: 'chat', from: 12, to: 17 }],
        }, { id: 'fact-unrelated', subject: 'Naruto', predicate: 'favorite food', value: 'ramen', importance: 3, sources: [] }],
        events: [],
        capsules: [{
            id: 'capsule-tower', title: 'Tower meeting', storyTime: 'Friday', location: 'Hokage Tower', participants: ['Sasuke', 'Elizabeth'],
            opening: 'Sasuke meets Elizabeth.', beats: ['Sasuke learns Elizabeth’s identity.'], emotionalArc: '', closing: 'He understands who she is.', importance: 3,
            chatKey: 'chat', from: 12, to: 17, sources: [{ chatKey: 'chat', from: 12, to: 17 }],
        }],
        arcs: [{ id: 'arc-affected', capsuleIds: ['capsule-tower'] }, { id: 'arc-safe', capsuleIds: ['capsule-safe'] }],
        eras: [{ id: 'era-affected', arcIds: ['arc-affected'], capsuleIds: ['capsule-tower'] }, { id: 'era-safe', arcIds: ['arc-safe'], capsuleIds: ['capsule-safe'] }],
    };
}

test('correction context selects matching records without dumping unrelated memory', () => {
    const selected = selectCorrectionContext(memoryWorld(), 'Sasuke already knew Elizabeth before the tower meeting');
    assert.ok(selected.some(item => item.id === 'fact-knowledge'));
    assert.ok(selected.some(item => item.id === 'capsule-tower'));
    assert.equal(selected.some(item => item.id === 'fact-unrelated'), false);
});

test('scopes a character correction to that belief without rewriting established facts', () => {
    const world = memoryWorld();
    world.facts.push({
        id: 'belief-alice-mask', subject: 'Alice', predicate: 'belief about masked visitor — identity', value: 'the prince',
        category: 'character belief', persistence: 'persistent', importance: 4,
        sources: [{ chatKey: 'chat', from: 20, to: 23 }],
    });
    const originalEstablishedFacts = structuredClone(world.facts.filter(item => item.category !== 'character belief'));
    const proposal = validateCorrectionProposal(world, {
        summary: 'Alice was wrong about the masked visitor; what happened remains unrevealed.',
        operations: [{
            action: 'update', category: 'facts', targetId: 'belief-alice-mask', reason: 'Change only Alice’s perspective.',
            recordJson: JSON.stringify({
                subject: 'Alice', predicate: 'belief about masked visitor — identity', value: 'no longer believes the visitor is the prince',
                category: 'character belief', persistence: 'persistent', importance: 4,
            }),
        }],
    }, 'Alice was wrong about the masked visitor, but the truth is not known yet.');

    applyCorrectionProposal(world, proposal);
    assert.deepEqual(world.facts.filter(item => item.category !== 'character belief'), originalEstablishedFacts);
    const belief = world.facts.find(item => item.id === 'belief-alice-mask');
    assert.equal(belief.subject, 'Alice');
    assert.match(belief.value, /no longer believes/i);
    assert.equal(world.facts.some(item => item.subject === 'masked visitor' && item.predicate === 'identity'), false);
});

test('reviewed correction updates established records and invalidates only contaminated hierarchy', () => {
    const world = memoryWorld();
    const proposal = validateCorrectionProposal(world, {
        summary: 'Sasuke knew Elizabeth before the meeting.',
        operations: [{
            action: 'update', category: 'facts', targetId: 'fact-knowledge', reason: 'Correct when Sasuke learned this.',
            recordJson: JSON.stringify({ subject: 'Sasuke', predicate: 'knowledge of Elizabeth', value: 'Already knew her identity before the tower meeting', category: 'knowledge', persistence: 'persistent', importance: 4 }),
        }, {
            action: 'update', category: 'capsules', targetId: 'capsule-tower', reason: 'Remove the false discovery beat from L1.',
            recordJson: JSON.stringify({ title: 'Tower meeting', storyTime: 'Friday', location: 'Hokage Tower', participants: ['Sasuke', 'Elizabeth'], opening: 'Sasuke meets Elizabeth, whose identity he already knows.', beats: ['They discuss the mission.'], emotionalArc: '', closing: 'The meeting ends.', importance: 3 }),
        }],
    }, 'Sasuke already knew Elizabeth beforehand.');

    const result = applyCorrectionProposal(world, proposal);
    assert.equal(world.facts[0].value, 'Already knew her identity before the tower meeting');
    assert.equal(world.capsules[0].beats[0], 'They discuss the mission.');
    assert.ok(world.facts[0].correctionId);
    assert.equal(world.corrections.length, 1);
    assert.deepEqual(world.arcs.map(item => item.id), ['arc-safe']);
    assert.deepEqual(world.eras.map(item => item.id), ['era-safe']);
    assert.equal(result.invalidatedArcs, 1);
    assert.equal(result.invalidatedEras, 1);
    assert.equal(result.invalidatedArcRecords[0].id, 'arc-affected');
    assert.equal(result.invalidatedEraRecords[0].id, 'era-affected');
    assert.ok(buildEmbeddingDocuments(world).some(item => item.key.startsWith('correction:')));
    const injected = buildMemoryPrompt(world, [{ name: 'User', mes: 'What did Sasuke know about Elizabeth?' }], 2000, 'chat');
    assert.match(injected.prompt, /User corrections:/);
    assert.match(injected.prompt, /already knew Elizabeth/i);
});

test('a newly asserted historical event is propagated into L1 before hierarchy rebuilding', () => {
    const world = memoryWorld();
    const proposal = augmentCorrectionChronology(world, validateCorrectionProposal(world, {
        summary: 'Add the missing injury event.',
        operations: [{
            action: 'add', category: 'events', targetId: '', reason: 'Missing event.',
            recordJson: JSON.stringify({
                title: 'Tower injury', summary: 'Elizabeth shatters Hiruzen’s ribs.', participants: ['Elizabeth', 'Hiruzen'],
                location: 'Hokage Tower', storyTime: 'Friday', consequences: 'Hiruzen has shattered ribs.', importance: 5,
            }),
        }],
    }, 'Elizabeth shattered Hiruzen’s ribs.'));

    assert.equal(proposal.operations.length, 2);
    assert.equal(proposal.operations[1].category, 'capsules');
    assert.equal(proposal.operations[1].action, 'update');
    assert.match(proposal.operations[1].replacement.beats.join(' '), /shatters Hiruzen/i);
    const result = applyCorrectionProposal(world, proposal);
    assert.equal(result.invalidatedArcs, 1);
    assert.equal(result.invalidatedEras, 1);
});

test('a historical event without a matching chronology creates an authoritative L1 source', () => {
    const world = memoryWorld();
    world.capsules = [];
    world.arcs = [];
    world.eras = [];
    const proposal = augmentCorrectionChronology(world, validateCorrectionProposal(world, {
        summary: 'Add a remote event.',
        operations: [{
            action: 'add', category: 'events', targetId: '', reason: 'Missing event.',
            recordJson: JSON.stringify({ title: 'Harbor storm', summary: 'A storm destroys the harbor.', participants: [], location: 'Harbor', storyTime: 'Monday', consequences: 'Ships are damaged.', importance: 4 }),
        }],
    }, 'A storm destroyed the harbor.'));

    assert.equal(proposal.operations[1].action, 'add');
    assert.equal(proposal.operations[1].category, 'capsules');
    const result = applyCorrectionProposal(world, proposal);
    assert.equal(world.capsules.length, 1);
    assert.match(world.capsules[0].chatKey, /^correction:/);
    assert.deepEqual(result.addedCapsuleIds, [world.capsules[0].id]);
});

test('stored correction suppresses replay of the prior fact and preserves corrected L1', () => {
    const world = memoryWorld();
    const proposal = validateCorrectionProposal(world, {
        summary: 'Correct prior knowledge.',
        operations: [{
            action: 'update', category: 'facts', targetId: 'fact-knowledge', reason: 'Prior knowledge.',
            recordJson: JSON.stringify({ subject: 'Sasuke', predicate: 'knowledge of Elizabeth', value: 'Already knew her identity', category: 'knowledge', persistence: 'persistent', importance: 4 }),
        }, {
            action: 'update', category: 'capsules', targetId: 'capsule-tower', reason: 'Correct L1.',
            recordJson: JSON.stringify({ ...world.capsules[0], beats: ['Sasuke speaks with Elizabeth as an existing acquaintance.'] }),
        }],
    }, 'Sasuke already knew Elizabeth.');
    applyCorrectionProposal(world, proposal);

    mergeExtraction(world, {
        scene: null,
        sceneCapsule: { ...world.capsules[0], beats: ['Sasuke learns Elizabeth’s identity.'] },
        entities: [], states: [], relationships: [], events: [], threads: [],
        facts: [{ subject: 'Sasuke', predicate: 'knowledge of Elizabeth', value: 'Learned her identity during the tower meeting', category: 'knowledge', persistence: 'persistent', importance: 4 }],
    }, { chatKey: 'chat', from: 12, to: 17, allowStateUpdates: true, messageFingerprints: [] });

    assert.equal(world.facts.length, 2);
    assert.equal(world.facts.find(item => item.id === 'fact-knowledge').value, 'Already knew her identity');
    assert.equal(world.capsules[0].beats[0], 'Sasuke speaks with Elizabeth as an existing acquaintance.');
    assert.equal(isSuppressedByCorrection(world, 'facts', { subject: 'Sasuke', predicate: 'knowledge of Elizabeth' }), true);
});

test('correction review rejects missing targets instead of guessing', () => {
    assert.throws(() => validateCorrectionProposal(memoryWorld(), {
        summary: 'Bad target',
        operations: [{ action: 'delete', category: 'facts', targetId: 'missing', reason: '', recordJson: '{}' }],
    }, 'remove it'), /targeted a missing facts record/);
});
