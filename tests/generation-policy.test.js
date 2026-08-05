import assert from 'node:assert/strict';
import test from 'node:test';
import { roleplaySourceMessages, shouldGateRoleplayGeneration } from '../extension/generation-policy.js';

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
