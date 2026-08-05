import assert from 'node:assert/strict';
import test from 'node:test';
import { canReduceContext } from '../extension/reduction-policy.js';

const chat = [{ index: 0, mes: 'Hello' }];

test('context reduction follows the master and reduction controls', () => {
    const settings = { enabled: true, contextReductionEnabled: true };
    assert.equal(canReduceContext(settings, chat, 'normal'), true);
    assert.equal(canReduceContext({ ...settings, enabled: false }, chat, 'normal'), false);
    assert.equal(canReduceContext({ ...settings, contextReductionEnabled: false }, chat, 'normal'), false);
});

test('context reduction remains off for unsupported and empty generations', () => {
    const settings = { enabled: true, contextReductionEnabled: true };
    assert.equal(canReduceContext(settings, [], 'normal'), false);
    assert.equal(canReduceContext(settings, chat, 'quiet'), false);
    assert.equal(canReduceContext(settings, chat, 'impersonate'), false);
});
