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

test('context bridge exposes only an aligned read-only snapshot', () => {
    const context = testContext();
    const { bridge, publish } = createContinuityContextBridge(() => context);

    publish('remember this');
    const snapshot = bridge.getContextSnapshot();
    assert.deepEqual(snapshot, {
        chatId: 'chat-1',
        prompt: 'remember this',
        revision: 1,
        updatedAt: snapshot.updatedAt,
        status: 'current',
    });
    assert.equal(bridge.publish, undefined);
    snapshot.prompt = 'mutated outside the bridge';
    assert.equal(bridge.getContextSnapshot().prompt, 'remember this');

    context.chat.push({ name: 'Character', mes: 'A new reply' });
    assert.equal(bridge.getContextSnapshot().status, 'stale');

    publish('updated memory');
    assert.equal(bridge.getContextSnapshot().status, 'current');
    assert.equal(bridge.getContextSnapshot().revision, 2);
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
