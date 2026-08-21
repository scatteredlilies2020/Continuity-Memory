import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMemoryEligibleMessages } from '../extension/message-digest.js';
import { roleplayBacklogPolicy, roleplaySourceMessages, roleplayWaitNotification, shouldGateRoleplayGeneration, sourceMutationPolicy } from '../extension/generation-policy.js';

const chat = [{ index: 0, mes: 'Hello' }];

test('gates ordinary roleplay generations when Continuity is enabled', () => {
    for (const type of ['normal', 'continue', 'swipe', 'regenerate']) {
        assert.equal(shouldGateRoleplayGeneration({ enabled: true }, chat, type), true);
    }
});

test('does not gate internal, impersonation, disabled, or empty generations', () => {
    assert.equal(shouldGateRoleplayGeneration({ enabled: true }, chat, 'quiet'), false);
    assert.equal(shouldGateRoleplayGeneration({ enabled: true }, chat, 'impersonate'), false);
    assert.equal(shouldGateRoleplayGeneration({ enabled: false }, chat, 'normal'), false);
    assert.equal(shouldGateRoleplayGeneration({ enabled: true }, [], 'normal'), false);
    assert.equal(shouldGateRoleplayGeneration({ enabled: true }, [], 'swipe'), true);
    assert.equal(shouldGateRoleplayGeneration({ enabled: true }, [], 'regenerate'), true);
});

test('temporarily excludes the reply being replaced during swipe generation', () => {
    const messages = [{ index: 0 }, { index: 1 }, { index: 2 }];
    assert.deepEqual(roleplaySourceMessages(messages, 'swipe'), [{ index: 0 }, { index: 1 }]);
    assert.deepEqual(roleplaySourceMessages(messages, 'regenerate'), messages);
});

test('old source mutations cancel overlapping work and repair their suffix', () => {
    assert.deepEqual(sourceMutationPolicy(false), {
        invalidateActiveWork: true,
        repairSuffix: true,
    });
    assert.deepEqual(sourceMutationPolicy(true), {
        invalidateActiveWork: false,
        repairSuffix: false,
    });
});

test('allows one background L1 batch of headroom before roleplay must catch up', () => {
    assert.deepEqual(roleplayBacklogPolicy(1, 8), {
        pending: 1,
        eligible: 0,
        required: 0,
        blocking: 0,
        backgroundThreshold: 8,
        hardLimit: 16,
        shouldCatchUp: false,
    });
    assert.equal(roleplayBacklogPolicy(8, 8).shouldCatchUp, false);
    assert.equal(roleplayBacklogPolicy(15, 8).shouldCatchUp, false);
    assert.equal(roleplayBacklogPolicy(16, 8).shouldCatchUp, true);
    assert.equal(roleplayBacklogPolicy(16, 8).eligible, 16);
});

test('excludes the provisional newest AI output from the catch-up boundary', () => {
    const eligible = Array.from({ length: 15 }, (_, index) => ({
        mes: `Stable ${index}`,
        name: 'User',
        is_user: true,
    }));
    const provisional = { mes: 'Mutable newest reply', name: 'Character', is_user: false };
    const pending = collectMemoryEligibleMessages([...eligible, provisional]).length;
    assert.equal(pending, 15);
    assert.equal(roleplayBacklogPolicy(pending, 8).shouldCatchUp, false);
    assert.equal(roleplayBacklogPolicy([...eligible, { mes: 'Stable 15', is_user: true }].length, 8).shouldCatchUp, true);
});

test('scales the protected background headroom with the configured L1 group size', () => {
    assert.deepEqual(roleplayBacklogPolicy(23, 12), {
        pending: 23,
        eligible: 12,
        required: 0,
        blocking: 12,
        backgroundThreshold: 12,
        hardLimit: 24,
        shouldCatchUp: false,
    });
    assert.equal(roleplayBacklogPolicy(24, 12).shouldCatchUp, true);
});

test('deliberately undone memory blocks roleplay below the normal backlog limit', () => {
    const result = roleplayBacklogPolicy(2, 10, 2);
    assert.equal(result.eligible, 0);
    assert.equal(result.required, 2);
    assert.equal(result.blocking, 2);
    assert.equal(result.shouldCatchUp, true);
});

test('describes memory work that delays roleplay generation', () => {
    const message = roleplayWaitNotification({
        processing: true,
        paused: false,
        queue: [{}, {}],
        progress: { from: 204, to: 211 },
    }, 48);
    assert.match(message, /48 messages awaiting L1 extraction/);
    assert.match(message, /currently processing messages 204–211/);
    assert.match(message, /2 queued memory jobs/);
    assert.match(message, /start automatically/);
});

test('does not notify when roleplay can begin immediately', () => {
    assert.equal(roleplayWaitNotification({ processing: false, paused: false, queue: [] }, 0), '');
});
