import assert from 'node:assert/strict';
import test from 'node:test';
import { embedPortableMemoryInChatExport, getPortableSnapshotFromChatExport, parseChatExport, removePortableMemoryFromChatExport } from '../extension/chat-export-portability.js';

function rawChat(metadata = {}) {
    return [
        JSON.stringify({ chat_metadata: metadata, user_name: 'unused', character_name: 'unused' }),
        JSON.stringify({ name: 'User', is_user: true, mes: 'Hello' }),
        JSON.stringify({ name: 'Alice', is_user: false, mes: 'Hi' }),
        '',
    ].join('\n');
}

test('native JSONL chat exports receive a current portable memory copy', () => {
    const world = { id: 'world-1', name: 'Chat memory', revision: 7, facts: [{ id: 'fact-1', value: 'kept' }] };
    const result = embedPortableMemoryInChatExport(rawChat({ existing: 'preserved' }), world, '2026-08-12T00:00:00.000Z');
    const parsed = parseChatExport(result);
    const portable = getPortableSnapshotFromChatExport(result);

    assert.equal(parsed.header.chat_metadata.existing, 'preserved');
    assert.equal(parsed.messages.length, 2);
    assert.equal(portable.world.id, 'world-1');
    assert.equal(portable.world.revision, 7);
    assert.equal(portable.world.facts[0].value, 'kept');
    assert.equal(portable.embeddedAt, '2026-08-12T00:00:00.000Z');
    assert.equal(result.endsWith('\n'), true);
});

test('native export refresh replaces a stale portable copy without mutating the world', () => {
    const world = { id: 'world-1', revision: 9, facts: [] };
    const stale = { schemaVersion: 1, world: { id: 'world-1', revision: 2 } };
    const result = embedPortableMemoryInChatExport(rawChat({ continuityMemory: stale }), world);

    assert.equal(getPortableSnapshotFromChatExport(result).world.revision, 9);
    assert.equal(Object.hasOwn(world, 'embeddedAt'), false);
});

test('native export removes an existing portable copy when the setting is off', () => {
    const stale = { schemaVersion: 1, world: { id: 'world-1', revision: 2 } };
    const result = removePortableMemoryFromChatExport(rawChat({ existing: 'preserved', continuityMemory: stale }));
    const parsed = parseChatExport(result);

    assert.equal(parsed.header.chat_metadata.existing, 'preserved');
    assert.equal(Object.hasOwn(parsed.header.chat_metadata, 'continuityMemory'), false);
    assert.equal(parsed.messages.length, 2);
    assert.equal(result.endsWith('\n'), true);
});

test('portable export rejects files that are not SillyTavern JSONL chats', () => {
    assert.throws(() => embedPortableMemoryInChatExport('{"mes":"not a header"}\n', { id: 'world' }), /not a SillyTavern JSONL chat/);
});
