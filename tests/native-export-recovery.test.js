import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildNativeChatExportRequest, readNativeChatExportResponse } from '../extension/chat-export-request.js';
import { embedPortableMemoryInChatExport, getPortableSnapshotFromChatExport, parseChatExport, removePortableMemoryFromChatExport } from '../extension/chat-export-portability.js';
import { alignWorldToChat, collectFingerprintMessages, fingerprintMessage } from '../extension/message-digest.js';

const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');

function harness() {
    const chat = [{ name: 'User', is_user: true, mes: 'A unique conversation.' }];
    const world = { id: 'memory', revision: 1, facts: [{ id: 'fact' }], sources: {
        chat: { processedMessages: collectFingerprintMessages(chat).map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })) },
    } };
    const raw = [JSON.stringify({ chat_metadata: { continuityMemory: { schemaVersion: 1, world }, other: 'retained' } }),
        ...chat.map(message => JSON.stringify(message)), ''].join('\n');
    const calls = { downloads: [], toast: [], save: 0 };
    const scope = vm.createContext({
        characters: [{ avatar: 'card.png' }], this_chid: 0,
        getContext: () => ({ chatId: 'Chat' }), getRequestHeaders: () => ({}),
        saveChatConditional: async () => { calls.save++; },
        fetch: async () => ({ ok: true, text: async () => JSON.stringify({ result: raw }) }),
        api: { getWorld: async () => ({ world }) },
        buildNativeChatExportRequest, readNativeChatExportResponse,
        embedPortableMemoryInChatExport, getPortableSnapshotFromChatExport, parseChatExport, removePortableMemoryFromChatExport,
        alignWorldToChat, collectFingerprintMessages,
        downloadPortableChat: (text, filename) => calls.downloads.push({ text, filename }),
        toast: (...args) => calls.toast.push(args),
    });
    const match = ui.match(/async function exportNativeChatWithPortableMemory\([^]*?^}/m);
    assert.ok(match);
    vm.runInContext(match[0], scope);
    return { scope, world, raw, calls,
        run: (include = true) => scope.exportNativeChatWithPortableMemory({}, 'Chat.jsonl', 'Chat', 'chat', 'memory', include) };
}

for (const problem of ['missing', 'unverifiable', 'changed', 'unavailable']) {
    test(`chat messages remain exportable when memory is ${problem}`, async () => {
        const h = harness();
        if (problem === 'missing') h.scope.api.getWorld = async () => { throw Object.assign(new Error('Missing memory'), { status: 404 }); };
        if (problem === 'unavailable') h.scope.api.getWorld = async () => { throw Object.assign(new Error('Storage unavailable'), { status: 503 }); };
        if (problem === 'unverifiable') h.world.sources = {};
        if (problem === 'changed') h.world.sources.chat.processedMessages[0].fingerprint = 'different';
        // A missing server copy has no usable embedded replacement either.
        if (problem === 'missing') h.scope.getPortableSnapshotFromChatExport = () => null;
        const expectedWorld = JSON.stringify(h.world);
        await h.run();
        assert.equal(h.calls.downloads.length, 1);
        const exported = parseChatExport(h.calls.downloads[0].text);
        assert.deepEqual(exported.messages, parseChatExport(h.raw).messages);
        assert.equal(exported.header.chat_metadata.other, 'retained');
        assert.equal(getPortableSnapshotFromChatExport(h.calls.downloads[0].text), null);
        assert.equal(h.calls.toast[0][0], 'warning');
        assert.match(h.calls.toast[0][1], /without Continuity memory/);
        assert.equal(JSON.stringify(h.world), expectedWorld);
        assert.equal(getPortableSnapshotFromChatExport(h.raw).world.id, 'memory');
    });
}

test('valid memory is still included in the downloaded chat', async () => {
    const h = harness();
    await h.run();
    assert.equal(getPortableSnapshotFromChatExport(h.calls.downloads[0].text).world.id, 'memory');
    assert.equal(h.calls.toast[0][0], 'success');
});

test('a verified embedded copy remains portable when the stored memory is missing', async () => {
    const h = harness();
    h.scope.api.getWorld = async () => { throw Object.assign(new Error('Missing memory'), { status: 404 }); };
    await h.run();
    assert.equal(getPortableSnapshotFromChatExport(h.calls.downloads[0].text).world.id, 'memory');
    assert.equal(h.calls.toast[0][0], 'success');
});

test('turning off portable memory exports messages without reading memory storage', async () => {
    const h = harness();
    h.scope.api.getWorld = async () => { assert.fail('Memory storage should not be read'); };
    await h.run(false);
    assert.equal(getPortableSnapshotFromChatExport(h.calls.downloads[0].text), null);
    assert.equal(h.calls.toast[0][0], 'success');
});

test('native server export errors remain visible and do not create a download', async () => {
    const h = harness();
    h.scope.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ message: 'Chat file missing' }) });
    await assert.rejects(h.run(), /Chat file missing/);
    assert.deepEqual(h.calls.downloads, []);
});
