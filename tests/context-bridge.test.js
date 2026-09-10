import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlanningEvidence, createContinuityContextBridge } from '../extension/context-bridge.js';
import { analyzeCoverage } from '../extension/coverage.js';

function testContext() {
    return {
        chatId: 'chat-1',
        characterId: 7,
        chat: [{ name: 'User', is_user: true, mes: 'Hello' }],
    };
}

test('planning evidence accepts actual coverage output and excludes records beyond the source boundary', () => {
    const context = testContext();
    const coverage = analyzeCoverage([
        { index: 0, name: 'User', text: 'The gate is locked.' },
        { index: 1, name: 'Character', text: 'I will find the key.' },
    ]);
    const source = to => [{ chatKey: 'chat-1', from: 0, to }];
    const world = {
        revision: 7,
        facts: [
            { id: 'covered', subject: 'Gate', predicate: 'is', value: 'locked', importance: 4, sources: source(1) },
            { id: 'future', subject: 'Gate', predicate: 'is', value: 'open', importance: 5, sources: source(2) },
        ],
    };
    const before = structuredClone(world);
    assert.equal(coverage.latestIndex, 1);
    assert.equal(coverage.throughMessageIndex, undefined);
    const evidence = buildPlanningEvidence(world, 'chat-1', coverage);
    assert.deepEqual(evidence.map(item => item.id), ['covered']);
    assert.equal(evidence[0].cmRevision, 7);
    assert.deepEqual(evidence[0].sourceRange, { chatKey: 'chat-1', from: 0, to: 1 });
    assert.deepEqual(world, before, 'building evidence must not mutate saved memory');

    const { bridge, publish } = createContinuityContextBridge(() => context);
    publish('', { coverage: { throughMessageIndex: coverage.latestIndex }, planningEvidence: evidence });
    const snapshot = bridge.getContextSnapshot();
    assert.equal(snapshot.status, 'current');
    assert.equal(snapshot.coverage.throughMessageIndex, 1);
    assert.equal(snapshot.planningEvidence[0].id, 'covered');
});

test('planning evidence fails closed for sourced records without a valid coverage boundary', () => {
    const world = { facts: [{ id: 'fact', subject: 'Gate', value: 'locked', sources: [{ chatKey: 'chat-1', from: 0, to: 0 }] }] };
    for (const coverage of [undefined, {}, { latestIndex: NaN }, { latestIndex: Infinity }, analyzeCoverage([])]) {
        assert.deepEqual(buildPlanningEvidence(world, 'chat-1', coverage), []);
    }
});

test('planning evidence preserves importance ordering and the 64-record limit', () => {
    const world = { facts: Array.from({ length: 70 }, (_, index) => ({
        id: `fact-${index}`, subject: 'Gate', value: `detail ${index}`, importance: index === 0 ? 5 : 1,
        sources: [{ chatKey: 'chat-1', from: index, to: index }],
    })) };
    const evidence = buildPlanningEvidence(world, 'chat-1', { latestIndex: 69 });
    assert.equal(evidence.length, 64);
    assert.equal(evidence[0].id, 'fact-0');
    assert.equal(evidence[1].id, 'fact-69');
});

test('context bridge exposes only an aligned read-only v2 snapshot', () => {
    const context = testContext();
    const { bridge, publish } = createContinuityContextBridge(() => context);

    publish('remember this');
    const snapshot = bridge.getContextSnapshot();
    assert.deepEqual(snapshot, {
        version: 2,
        chatId: 'chat-1',
        prompt: 'remember this',
        revision: 1,
        updatedAt: snapshot.updatedAt,
        status: 'current',
        coverage: { throughMessageIndex: -1, signature: snapshot.coverage.signature },
        planningEvidence: [],
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.coverage), true);
    assert.equal(bridge.publish, undefined);
    snapshot.prompt = 'mutated outside the bridge';
    assert.equal(bridge.getContextSnapshot().prompt, 'remember this');

    context.chat.push({ name: 'Character', mes: 'A new reply' });
    assert.equal(bridge.getContextSnapshot().status, 'stale');

    publish('updated memory');
    assert.equal(snapshot.prompt, 'remember this', 'an older snapshot remains a point-in-time value');
    assert.equal(bridge.getContextSnapshot().status, 'current');
    assert.equal(bridge.getContextSnapshot().revision, 2);
});

test('context bridge bounds and freezes structured evidence and notifies each published revision', () => {
    const context = testContext();
    const { bridge, publish } = createContinuityContextBridge(() => context);
    const revisions = [];
    const unsubscribe = bridge.subscribe(snapshot => revisions.push(snapshot.revision));
    const evidence = Array.from({ length: 70 }, (_, index) => ({
        id: `record-${index}`,
        cmRevision: 12,
        category: index ? 'facts' : 'threads',
        canonicalStatus: index ? 'current' : 'open',
        importance: 4,
        text: `Canonical record ${index}`,
        participants: ['A', 'B'],
        sourceRange: { chatKey: 'chat-1', from: index, to: index },
        temporalAnchor: 'today',
        retrievalReason: 'current canonical record',
    }));

    publish('legacy fallback', {
        coverage: { throughMessageIndex: 69, signature: 'coverage-signature' },
        planningEvidence: evidence,
    });
    const snapshot = bridge.getContextSnapshot();
    assert.equal(snapshot.planningEvidence.length, 64);
    assert.equal(snapshot.planningEvidence[0].cmRevision, 12);
    assert.deepEqual(snapshot.coverage, { throughMessageIndex: 69, signature: 'coverage-signature' });
    assert.equal(Object.isFrozen(snapshot.planningEvidence), true);
    assert.equal(Object.isFrozen(snapshot.planningEvidence[0]), true);
    assert.equal(Object.isFrozen(snapshot.planningEvidence[0].participants), true);
    assert.equal(Object.isFrozen(snapshot.planningEvidence[0].sourceRange), true);
    assert.deepEqual(revisions, [1]);

    unsubscribe();
    publish('second revision');
    assert.deepEqual(revisions, [1]);
});

test('structured evidence remains current without requiring a legacy prompt', () => {
    const context = testContext();
    const { bridge, publish } = createContinuityContextBridge(() => context);
    publish('', { planningEvidence: [{ id: 'fact-1', text: 'A structured fact.' }] });
    const snapshot = bridge.getContextSnapshot();
    assert.equal(snapshot.status, 'current');
    assert.equal(snapshot.prompt, '');
    assert.equal(snapshot.planningEvidence[0].text, 'A structured fact.');
});

test('context bridge does not expose a previous chat as current', () => {
    const context = testContext();
    const { bridge, publish } = createContinuityContextBridge(() => context);
    publish('first chat memory');

    context.chatId = 'chat-2';
    assert.equal(bridge.getContextSnapshot().status, 'stale');

    publish('');
    assert.equal(bridge.getContextSnapshot().status, 'unavailable');
    assert.equal(bridge.getContextSnapshot().prompt, '');
});
