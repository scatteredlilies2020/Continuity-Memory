import assert from 'node:assert/strict';
import test from 'node:test';
import { canSafelySaveChatMetadata } from '../extension/chat-metadata-save-guard.js';

function context(overrides = {}) {
    return {
        chatId: 'star-wars-chat',
        groupId: null,
        characterId: 42,
        chat: [{ mes: 'A long time ago…' }],
        chatMetadata: {},
        ...overrides,
    };
}

test('allows metadata save only for the same loaded non-empty chat', () => {
    const expected = context();
    assert.equal(canSafelySaveChatMetadata(expected, expected), true);
});

test('blocks the empty-chat save that would overwrite a JSONL conversation', () => {
    const expected = context({ chat: [] });
    assert.equal(canSafelySaveChatMetadata(expected, expected), false);
});

test('blocks saves after the active chat or metadata object changes', () => {
    const expected = context();
    assert.equal(canSafelySaveChatMetadata(expected, { ...expected, chatId: 'another-chat' }), false);
    assert.equal(canSafelySaveChatMetadata(expected, { ...expected, chatMetadata: {} }), false);
});

test('blocks saves after the active character or group changes', () => {
    const expected = context();
    assert.equal(canSafelySaveChatMetadata(expected, { ...expected, characterId: 99 }), false);
    assert.equal(canSafelySaveChatMetadata(expected, { ...expected, groupId: 'group-1' }), false);
});
