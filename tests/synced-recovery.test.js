import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { rankSuperiorSyncedWorlds } from '../extension/chat-ownership.js';
import { alignWorldToChat, collectFingerprintMessages, fingerprintMessage } from '../extension/message-digest.js';
import { freshResetResiduals } from '../extension/memory-model.js';

const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../extension/synced-recovery-policy.js', import.meta.url), 'utf8');
function install(source, name, scope) {
    const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0].replace(/^export /u, ''), scope);
}
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
    const chat = Array.from({ length: 3 }, (_, i) => ({ name: 'Narrator', mes: `Accepted message ${i}.`, is_user: false }));
    const messages = collectFingerprintMessages(chat);
    const makeWorld = (id, count, key = 'chat') => ({ id, name: 'Person · Chat', revision: 2, createdAt: 'original-date',
        extractions: Array.from({ length: count }, () => ({})),
        sources: count ? { [key]: { processedMessages: messages.slice(0, count).map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })) } } : {},
    });
    const original = makeWorld('bound', 1), candidate = makeWorld('synced', 3, 'old-device-chat');
    const saved = new Map([[original.id, original], [candidate.id, candidate]]);
    const settings = { enabled: true, embedMemoryInChat: true, chatWorlds: { chat: 'bound' }, deletedWorldIds: [] };
    const calls = { list: 0, read: [], save: [], import: 0, embed: [], toast: [], settings: 0 };
    const scope = vm.createContext({ structuredClone, console, worlds: [{ id: 'synced', name: candidate.name, counts: { retryableDigest: 3 } }],
        refreshingWorlds: null, runtime: { world: structuredClone(original), generation: 0, processing: false },
        activeChat: 'chat', settings, getSettings: () => settings,
        getContext: () => ({ name2: 'Person', chatId: 'Chat', chat }),
        getChatKey: () => scope.activeChat, getBoundWorldId: () => settings.chatWorlds[scope.activeChat] || '',
        rankSuperiorSyncedWorlds, alignWorldToChat, collectFingerprintMessages, freshResetResiduals,
        bindCurrentChat: id => { settings.chatWorlds[scope.activeChat] = id; },
        updateRuntime: patch => Object.assign(scope.runtime, patch), renderRuntime() {},
        embedWorldInChat: async world => { calls.embed.push(structuredClone(world)); }, clearPortableSnapshot: async () => {},
        toast: (...args) => calls.toast.push(args), saveSettings: () => { calls.settings++; },
        getPortableSnapshot: () => null,
        api: {
            listWorlds: async () => { calls.list++; return { worlds: [...saved.values()].map(world => ({ id: world.id, name: world.name,
                counts: { retryableDigest: world.extractions.length } })) }; },
            getWorld: async id => { calls.read.push(id); return { world: structuredClone(saved.get(id)) }; },
            saveWorld: async world => {
                calls.save.push(structuredClone(world));
                const next = { ...structuredClone(world), revision: world.revision + 1 };
                saved.set(next.id, next);
                return { world: structuredClone(next) };
            },
            importWorld: async world => {
                calls.import++;
                const next = { ...structuredClone(world), id: 'private-copy', revision: 0 };
                saved.set(next.id, next);
                return { world: structuredClone(next) };
            },
        },
    });
    install(policy, 'blockSyncedRecovery', scope);
    for (const name of ['refreshWorlds', 'refreshCurrentChatWorlds', 'recoverSuperiorSyncedWorld', 'reconcileBoundWorldSource',
        'recoverStoredWorldForCurrentChat', 'ensureCurrentChatMemory']) install(ui, name, scope);
    scope.loadBoundWorldOnce = async id => (await scope.api.getWorld(id)).world;
    return { scope, settings, calls, saved, original, candidate, makeWorld };
}

test('disabled refresh and automatic entry points perform no recovery, writes or notifications', async () => {
    const h = harness(); h.settings.enabled = false;
    assert.equal(await h.scope.refreshWorlds(), null);
    assert.equal(await h.scope.ensureCurrentChatMemory(true), null);
    await h.scope.recoverSuperiorSyncedWorld(h.original);
    await h.scope.recoverStoredWorldForCurrentChat('missing');
    await h.scope.reconcileBoundWorldSource(h.candidate);
    assert.equal(h.calls.list, 0);
    assert.deepEqual(h.calls.read, []);
    assert.deepEqual(h.calls.save, []);
    assert.deepEqual(h.calls.embed, []);
    assert.deepEqual(h.calls.toast, []);
});

test('simultaneous refreshes recover once, retain the current binding, and stay resolved after reload', async () => {
    const h = harness();
    await Promise.all([h.scope.refreshWorlds(), h.scope.refreshWorlds(), h.scope.refreshWorlds()]);
    assert.equal(h.calls.list, 1);
    assert.equal(h.calls.save.length, 1);
    assert.equal(h.calls.import, 0);
    assert.equal(h.settings.chatWorlds.chat, 'bound');
    assert.equal(h.saved.get('bound').sources.chat.processedMessages.length, 3);
    assert.deepEqual(h.saved.get('synced'), h.candidate, 'the synced source stays untouched');
    assert.equal(h.saved.get('bound').createdAt, 'original-date');
    h.scope.runtime.world = null;
    await h.scope.refreshWorlds();
    assert.equal(h.calls.save.length, 1);
    assert.deepEqual(h.calls.toast, []);
});

test('stale runtime coverage cannot re-recover an already saved world', async () => {
    const h = harness();
    const first = await h.scope.recoverSuperiorSyncedWorld(h.original);
    const second = await h.scope.recoverSuperiorSyncedWorld(h.original);
    assert.equal(first.sources.chat.processedMessages.length, 3);
    assert.equal(second.sources.chat.processedMessages.length, 3);
    assert.equal(h.calls.save.length, 1);
    assert.deepEqual(h.calls.toast, []);
});

for (const change of ['disable', 'chat', 'generation']) test(`${change} during candidate loading prevents publication and writes`, async () => {
    const h = harness();
    const read = h.scope.api.getWorld;
    h.scope.api.getWorld = async id => {
        const result = await read(id);
        if (id === 'synced') {
            if (change === 'disable') h.settings.enabled = false;
            else if (change === 'chat') h.scope.activeChat = 'another-chat';
            else h.scope.runtime.generation++;
        }
        return result;
    };
    await h.scope.recoverSuperiorSyncedWorld(h.original);
    assert.deepEqual(h.calls.save, []);
    assert.equal(h.calls.import, 0);
    assert.deepEqual(h.calls.embed, []);
    assert.deepEqual(h.calls.toast, []);
    assert.equal(h.settings.chatWorlds.chat, 'bound');
});

test('disabling during world listing stops refresh before any world load', async () => {
    const h = harness();
    h.scope.api.listWorlds = async () => { h.settings.enabled = false; return { worlds: [] }; };
    assert.equal(await h.scope.refreshWorlds(), null);
    assert.deepEqual(h.calls.read, []);
    assert.deepEqual(h.calls.save, []);
});

test('shared destination recovery forks once without changing another chat memory', async () => {
    const h = harness(); h.settings.chatWorlds.other = 'bound';
    await h.scope.refreshWorlds();
    assert.equal(h.calls.import, 1);
    assert.equal(h.settings.chatWorlds.chat, 'private-copy');
    assert.equal(h.settings.chatWorlds.other, 'bound');
    assert.deepEqual(h.saved.get('bound'), h.original);
    await h.scope.refreshWorlds();
    assert.equal(h.calls.import, 1);
});

test('explicit fresh starts and older saved empty worlds cannot be filled from an old synced copy', async () => {
    for (const alreadyBlocked of [false, true]) {
        const h = harness();
        const world = alreadyBlocked ? h.original : h.makeWorld('bound', 0);
        h.saved.set('bound', world);
        if (alreadyBlocked) h.scope.blockSyncedRecovery('bound');
        await h.scope.recoverSuperiorSyncedWorld(world);
        assert.equal(h.settings.syncedRecoveryBlockedWorldIds.includes('bound'), true);
        assert.equal(h.calls.save.length, 0);
        const rebuilt = h.makeWorld('bound', 1);
        await h.scope.recoverSuperiorSyncedWorld(rebuilt);
        assert.equal(h.calls.save.length, 0, 'new rebuild chunks do not re-enable recovery');
    }
});

test('brand-new empty memory can recover while deleted candidates are ignored', async () => {
    const h = harness(); const empty = { ...h.makeWorld('bound', 0), revision: 0 }; h.saved.set('bound', empty);
    h.settings.deletedWorldIds = ['synced'];
    await h.scope.recoverSuperiorSyncedWorld(empty);
    assert.equal(h.calls.save.length, 0);
    h.settings.deletedWorldIds = [];
    const recovered = await h.scope.recoverSuperiorSyncedWorld(empty);
    assert.equal(recovered.sources.chat.processedMessages.length, 3);
    assert.equal(h.calls.save.length, 1);
});

test('a competing tab save is respected without another import or stale overwrite', async () => {
    const h = harness();
    h.scope.api.saveWorld = async () => {
        h.saved.set('bound', { ...h.makeWorld('bound', 3), revision: 10 });
        throw Object.assign(new Error('Revision conflict'), { status: 409 });
    };
    const result = await h.scope.recoverSuperiorSyncedWorld(h.original);
    assert.equal(result.revision, 10);
    assert.equal(h.scope.runtime.world.revision, 10);
    assert.equal(h.calls.import, 0);
    assert.deepEqual(h.calls.toast, []);
});

test('saved fresh-start opt-out survives configuration reset and prevents repeated saves', () => {
    const h = harness();
    h.scope.blockSyncedRecovery('bound'); h.scope.blockSyncedRecovery('bound');
    assert.equal(h.calls.settings, 1);
    h.scope.DEFAULTS = { enabled: true, chatWorlds: {}, deletedWorldIds: [] };
    install(readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8'), 'resetConfigurationSettings', h.scope);
    h.scope.resetConfigurationSettings();
    assert.deepEqual(plain(h.settings.syncedRecoveryBlockedWorldIds), ['bound']);
});

test('bound-world loading stops if disabled before its storage response returns', async () => {
    const h = harness();
    install(engine, 'loadBoundWorld', h.scope);
    h.scope.api.getWorld = async () => { h.settings.enabled = false; return { world: h.original }; };
    assert.equal(await h.scope.loadBoundWorld(), null);
    assert.deepEqual(h.calls.embed, []);
    assert.deepEqual(h.calls.save, []);
});

test('erase and rebuild persist an opt-out before writing verified-empty memory', async () => {
    const h = harness();
    install(engine, 'persistVerifiedEmptyWorld', h.scope);
    h.scope.resetWorldMemory = world => { world.extractions = []; world.sources = {}; };
    const save = h.scope.api.saveWorld;
    h.scope.api.saveWorld = async world => {
        assert.equal(h.settings.syncedRecoveryBlockedWorldIds.includes(world.id), true);
        return await save(world);
    };
    const result = await h.scope.persistVerifiedEmptyWorld('bound');
    assert.deepEqual(plain(result.sources), {});
    assert.deepEqual(plain(result.extractions), []);
});

test('disabling the checkbox invalidates an in-flight generation even if enabled again immediately', async () => {
    const h = harness();
    let listener;
    let checked = false;
    h.scope.$ = () => ({ on: (_event, callback) => { listener = callback; }, is: () => true, prop: () => checked });
    h.scope.invalidateRuntimeWork = () => { h.scope.runtime.generation++; };
    install(ui, 'setSetting', h.scope);
    h.scope.setSetting('enabled-checkbox', 'enabled', Boolean);
    const epoch = h.scope.runtime.generation;
    listener();
    assert.equal(h.settings.enabled, false);
    assert.equal(h.scope.runtime.generation, epoch + 1);
    checked = true;
    listener();
    assert.equal(h.settings.enabled, true);
    await h.scope.refreshingWorlds?.promise;
});

test('a cancelled bound-world load is not published or treated as a mismatched-world failure', async () => {
    const h = harness();
    h.scope.runtime.world = null;
    h.scope.loadingBoundWorld = null;
    install(ui, 'loadBoundWorldOnce', h.scope);
    let finish;
    h.scope.loadBoundWorld = () => new Promise(resolve => { finish = resolve; });
    const loading = h.scope.loadBoundWorldOnce('bound');
    h.scope.runtime.generation++;
    finish(null);
    assert.equal(await loading, null);
    assert.equal(h.scope.loadingBoundWorld, null);
    h.scope.loadBoundWorld = async () => h.original;
    assert.equal((await h.scope.loadBoundWorldOnce('bound')).id, 'bound');
});
