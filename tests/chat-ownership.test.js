import assert from 'node:assert/strict';
import test from 'node:test';
import { rankSuperiorSyncedWorlds, resolveDeletedChatBinding, resolveMissingWorldBinding, resolveRenamedChatBinding } from '../extension/chat-ownership.js';

test('resolves one isolated character or group chat memory for deletion', () => {
    const bindings = {
        'character:4:chat:First chat': 'world-1',
        'group:8:chat:Group chat': 'world-2',
    };
    assert.deepEqual(resolveDeletedChatBinding(bindings, 'First chat', 'character').binding, {
        chatKey: 'character:4:chat:First chat',
        worldId: 'world-1',
        sharedElsewhere: false,
    });
    assert.equal(resolveDeletedChatBinding(bindings, 'Group chat', 'group').binding.worldId, 'world-2');
});

test('refuses ambiguous deletion events and preserves a legacy shared world', () => {
    const ambiguous = {
        'character:4:chat:Same name': 'world-1',
        'character:7:chat:Same name': 'world-2',
    };
    assert.equal(resolveDeletedChatBinding(ambiguous, 'Same name', 'character').ambiguous, true);

    const shared = {
        'character:4:chat:First': 'shared-world',
        'character:4:chat:Second': 'shared-world',
    };
    assert.equal(resolveDeletedChatBinding(shared, 'First', 'character').binding.sharedElsewhere, true);
});

test('moves one chat binding when SillyTavern renames the chat file', () => {
    const bindings = { 'character:4:chat:Old name': 'world-1' };
    assert.deepEqual(resolveRenamedChatBinding(bindings, { oldFileName: 'Old name.jsonl', newFileName: 'New name.jsonl' }).binding, {
        oldChatKey: 'character:4:chat:Old name',
        newChatKey: 'character:4:chat:New name',
        worldId: 'world-1',
    });

    const groupBindings = { 'group:8:chat:Old group chat': 'world-2' };
    assert.equal(resolveRenamedChatBinding(groupBindings, { groupId: '8', oldFileName: 'Old group chat', newFileName: 'New group chat' }).binding.newChatKey, 'group:8:chat:New group chat');
});

test('finds one stale imported or restored binding by its exact character and chat name', () => {
    const worlds = [
        { id: 'restored-world', name: 'Naruto · Naruto - 2026-08-03' },
        { id: 'other-world', name: 'Kirino · Imported chat' },
    ];
    assert.equal(resolveMissingWorldBinding(worlds, 'missing-world', {
        characterName: 'Naruto',
        chatId: 'Naruto - 2026-08-03',
    }).world.id, 'restored-world');
    assert.equal(resolveMissingWorldBinding(worlds, 'restored-world', {
        characterName: 'Naruto',
        chatId: 'Naruto - 2026-08-03',
    }).world, null);
});

test('does not guess when restored world recovery is ambiguous', () => {
    const worlds = [
        { id: 'copy-a', name: 'Naruto · Same chat' },
        { id: 'copy-b', name: 'Naruto · Same chat' },
    ];
    const result = resolveMissingWorldBinding(worlds, 'missing-world', {
        characterName: 'Naruto',
        chatId: 'Same chat',
    });
    assert.equal(result.world, null);
    assert.equal(result.ambiguous, true);
});

test('ranks only same-chat Syncthing copies with greater L1 coverage', () => {
    const current = { id: 'old-copy', extractions: [{}, {}] };
    const worlds = [
        { id: 'old-copy', name: 'Toska · RP', counts: { retryableL1: 2 }, revision: 9 },
        { id: 'partial-copy', name: 'Toska · RP', counts: { retryableL1: 21 }, revision: 515 },
        { id: 'complete-copy', name: 'Toska · RP', counts: { retryableL1: 53 }, revision: 255 },
        { id: 'other-chat', name: 'Toska · Different RP', counts: { retryableL1: 80 }, revision: 900 },
    ];
    assert.deepEqual(rankSuperiorSyncedWorlds(worlds, current, { characterName: 'Toska', chatId: 'RP' }).map(item => item.id), [
        'complete-copy',
        'partial-copy',
    ]);
    assert.deepEqual(rankSuperiorSyncedWorlds(worlds, { id: 'complete-copy', extractions: Array(53) }, { characterName: 'Toska', chatId: 'RP' }), []);
});
