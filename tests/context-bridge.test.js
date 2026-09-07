import assert from 'node:assert/strict';
import test from 'node:test';
import { createContinuityContextBridge } from '../extension/context-bridge.js';

function testContext() {
    return {
        chatId: 'chat-1',
        characterId: 7,
        chat: [{ name: 'User', is_user: true, mes: 'Hello' }],
    };
}

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
