import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isWorldBoundToOtherConversation, rankSuperiorSyncedWorlds, resolveMissingWorldBinding } from '../extension/chat-ownership.js';
import { buildEmbeddingDocuments } from '../extension/embedding-index.js';
import { alignWorldToChat, collectFingerprintMessages, fingerprintMessage } from '../extension/message-digest.js';
import { freshResetResiduals, mergeExtraction } from '../extension/memory-model.js';
import { recoverTruncatedChatPrefix } from '../extension/branch-cache.js';

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
        isWorldBoundToOtherConversation, rankSuperiorSyncedWorlds, resolveMissingWorldBinding, alignWorldToChat, collectFingerprintMessages, freshResetResiduals, recoverTruncatedChatPrefix,
        bindCurrentChat: id => { settings.chatWorlds[scope.activeChat] = id; },
        updateRuntime: patch => Object.assign(scope.runtime, patch), renderRuntime() {},
        embedWorldInChat: async world => { calls.embed.push(structuredClone(world)); }, clearPortableSnapshot: async () => {},
        toast: (...args) => calls.toast.push(args), saveSettings: () => { calls.settings++; },
        getPortableSnapshot: () => null,
        api: {
            health: async () => ({ ok: true, detachedJobs: true }),
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
        'recoverStoredWorldForCurrentChat', 'recoverTruncatedPortableMemory', 'ensureCurrentChatMemory']) install(ui, name, scope);
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

function invalidPortableHarness() {
    const h = harness();
    const portable = { world: { ...structuredClone(h.original), sources: {}, facts: [{ id: 'retained-fact' }] } };
    h.settings.chatWorlds.chat = 'missing-binding';
    h.scope.runtime.world = null;
    h.scope.creatingChatMemory = null;
    h.scope.branchParentChatKey = () => '';
    h.scope.getPortableSnapshot = () => portable;
    h.scope.worlds = [{ id: h.original.id }];
    h.calls.embedOptions = [];
    h.scope.embedWorldInChat = async (world, options) => {
        h.calls.embed.push(structuredClone(world));
        h.calls.embedOptions.push(options);
        return true;
    };
    install(ui, 'verifyMemoryAlignment', h.scope);
    return { ...h, portable };
}

function truncatedPortableHarness() {
    const h = invalidPortableHarness();
    const chat = Array.from({ length: 32 }, (_, index) => ({ name: 'Narrator', mes: `Message ${index}`, is_user: false }));
    const messages = collectFingerprintMessages(chat);
    h.scope.getContext().chat.splice(0, 3, ...chat.slice(0, 31));
    const world = { ...structuredClone(h.original), sources: {}, extractions: [], facts: [] };
    for (let from = 0; from < 32; from += 8) {
        mergeExtraction(world, { entities: [], facts: [], sceneCapsule: {
            title: `Part ${from}`, opening: `Verified narrative for batch ${from}.`, beats: [], closing: '',
        } }, { chatKey: 'chat', from, to: from + 7, allowStateUpdates: true,
            messageFingerprints: messages.slice(from, from + 8).map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
        });
    }
    h.portable.world = world;
    h.scope.worlds = [];
    h.scope.api.importWorld = async world => {
        h.calls.import++;
        const id = world.id || `import-${h.calls.import}`;
        const next = { ...structuredClone(world), id, revision: 0 };
        h.saved.set(id, next);
        return { world: structuredClone(next) };
    };
    return h;
}

test('truncated portable memory backs up the complete original before attaching a verified prefix, once', async () => {
    const h = truncatedPortableHarness();
    const before = structuredClone(h.portable.world);
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.equal(result.id, 'import-2');
    assert.equal(result.sources.chat.processedMessages.length, 24);
    assert.equal(result.extractions.length, 3);
    const backup = h.saved.get('import-1');
    assert.match(backup.name, /Before tail recovery/);
    assert.deepEqual(backup.sources, before.sources);
    assert.deepEqual(backup.extractions, before.extractions);
    assert.deepEqual(h.calls.read, ['import-1', h.original.id], 'verify the full backup and inspect the canonical destination before publishing');
    assert.deepEqual(h.portable.world, before, 'do not mutate the original portable object');
    assert.equal(h.calls.embed.length, 1);
    assert.equal(h.calls.embedOptions[0].force, true);
    assert.equal(h.settings.chatWorlds.chat, result.id);
    assert.equal(h.calls.save.length, 0, 'never overwrite canonical worlds');
    assert.equal(h.calls.toast[0][0], 'warning');
    assert.equal((await h.scope.ensureCurrentChatMemory()).id, result.id);
    h.scope.runtime.world = null;
    assert.equal((await h.scope.ensureCurrentChatMemory()).id, result.id, 'the saved binding also survives a fresh load');
    assert.equal(h.calls.import, 2, 'subsequent use does not repeat recovery');
});

test('simultaneous shortened-chat recovery requests share one backup and prefix import', async () => {
    const h = truncatedPortableHarness();
    const results = await Promise.all([h.scope.ensureCurrentChatMemory(false, true), h.scope.ensureCurrentChatMemory(false, true)]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(h.calls.import, 2);
    assert.equal(h.calls.embed.length, 1);
});

test('tail recovery preserves the embedding collection ID when its exact canonical snapshot is safely backed up', async () => {
    const h = truncatedPortableHarness();
    h.saved.set(h.original.id, structuredClone(h.portable.world));
    const before = structuredClone(h.portable.world);
    const hashes = new Set(buildEmbeddingDocuments(structuredClone(before)).map(item => item.hash));
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.equal(result.id, before.id, 'retain the existing vector collection');
    assert.equal(h.calls.import, 1, 'only the full backup needs a new ID');
    assert.equal(h.calls.save.length, 1);
    assert.equal(result.sources.chat.processedMessages.length, 24);
    assert.deepEqual(h.saved.get('import-1').extractions, before.extractions);
    assert.ok(buildEmbeddingDocuments(result).some(item => hashes.has(item.hash)), 'verified records keep reusable vector hashes');
});

test('a missing canonical memory is restored under its original ID so synced vectors still attach', async () => {
    const h = truncatedPortableHarness();
    h.saved.delete(h.original.id);
    const read = h.scope.api.getWorld;
    h.scope.api.getWorld = async id => {
        if (!h.saved.has(id)) throw Object.assign(new Error('Not found'), { status: 404 });
        return await read(id);
    };
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.equal(result.id, h.original.id);
    assert.equal(h.calls.import, 2);
    assert.equal(h.calls.save.length, 0);
});

for (const problem of ['newer', 'changed', 'shared']) test(`tail repair does not overwrite a ${problem} canonical memory to retain vectors`, async () => {
    const h = truncatedPortableHarness();
    const stored = structuredClone(h.portable.world);
    if (problem === 'newer') stored.revision++;
    if (problem === 'changed') stored.facts.push({ id: 'different-fact' });
    if (problem === 'shared') h.settings.chatWorlds.other = stored.id;
    h.saved.set(stored.id, stored);
    const before = structuredClone(stored);
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.notEqual(result.id, stored.id);
    assert.deepEqual(h.saved.get(stored.id), before);
    assert.equal(h.calls.save.length, 0);
});

test('a canonical revision conflict during ID-preserving tail repair leaves the original backup and binding intact', async () => {
    const h = truncatedPortableHarness();
    h.saved.set(h.original.id, structuredClone(h.portable.world));
    h.scope.api.saveWorld = async () => { throw Object.assign(new Error('Revision conflict'), { status: 409 }); };
    assert.equal(await h.scope.ensureCurrentChatMemory(false, true), null);
    assert.equal(h.settings.chatWorlds.chat, 'missing-binding');
    assert.deepEqual(h.saved.get('import-1').extractions, h.portable.world.extractions);
    assert.deepEqual(h.calls.embed, []);
});

for (const outcome of ['throw', 'skipped']) test(`a ${outcome} metadata save does not undo a committed recovery`, async () => {
    const h = truncatedPortableHarness();
    h.scope.embedWorldInChat = async () => {
        if (outcome === 'throw') throw new Error('Metadata save unavailable');
        return false;
    };
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.equal(result.id, 'import-2');
    assert.equal(h.scope.runtime.world.id, result.id);
    assert.equal(h.settings.chatWorlds.chat, result.id);
    assert.match(h.calls.toast[0][1], /portable chat backup.*not.*saved/);
});

for (const failure of ['backup-write', 'backup-read', 'backup-corrupt', 'prefix-write']) {
    test(`tail recovery preserves the rejected snapshot and binding on ${failure}`, async () => {
        const h = truncatedPortableHarness();
        const before = structuredClone(h.portable.world);
        const write = h.scope.api.importWorld;
        h.scope.api.importWorld = async world => {
            if ((failure === 'backup-write' && !h.calls.import) || (failure === 'prefix-write' && h.calls.import === 1)) throw new Error('Disk unavailable');
            return await write(world);
        };
        const read = h.scope.api.getWorld;
        h.scope.api.getWorld = async id => {
            if (failure === 'backup-read') throw new Error('Backup unavailable');
            const result = await read(id);
            if (failure === 'backup-corrupt') result.world.extractions.pop();
            return result;
        };
        assert.equal(await h.scope.ensureCurrentChatMemory(false, true), null);
        assert.equal(h.settings.chatWorlds.chat, 'missing-binding');
        assert.equal(h.scope.runtime.world, null);
        assert.deepEqual(h.calls.embed, []);
        assert.deepEqual(h.portable.world, before);
        assert.match(h.scope.runtime.lastError, /Safe tail recovery stopped/);
    });
}

for (const stage of ['backup-write', 'backup-read', 'prefix-write']) for (const change of ['disable', 'chat', 'generation', 'binding', 'messages']) {
    test(`tail recovery stops on ${change} during ${stage}`, async () => {
        const h = truncatedPortableHarness();
        const mutate = () => {
            if (change === 'disable') h.settings.enabled = false;
            if (change === 'chat') h.scope.activeChat = 'other';
            if (change === 'generation') h.scope.runtime.generation++;
            if (change === 'binding') h.settings.chatWorlds.chat = 'other-world';
            if (change === 'messages') h.scope.getContext().chat[0].mes = 'Changed while saving';
        };
        const write = h.scope.api.importWorld;
        h.scope.api.importWorld = async world => {
            const result = await write(world);
            if ((stage === 'backup-write' && h.calls.import === 1) || (stage === 'prefix-write' && h.calls.import === 2)) mutate();
            return result;
        };
        const read = h.scope.api.getWorld;
        h.scope.api.getWorld = async id => {
            const result = await read(id);
            if (stage === 'backup-read') mutate();
            return result;
        };
        assert.equal(await h.scope.ensureCurrentChatMemory(false, true), null);
        assert.equal(h.scope.runtime.world, null);
        assert.deepEqual(h.calls.embed, []);
        assert.equal(h.settings.chatWorlds.chat, change === 'binding' ? 'other-world' : 'missing-binding');
        assert.equal(h.calls.import, stage === 'prefix-write' ? 2 : 1);
    });
}

test('memory actions distinguish an open chat with an attachment failure from no open chat', () => {
    const h = harness();
    install(ui, 'memoryUnavailableMessage', h.scope);
    h.scope.runtime.lastError = 'Memory recovery was blocked.';
    assert.equal(h.scope.memoryUnavailableMessage(), h.scope.runtime.lastError);
    h.scope.activeChat = '';
    assert.match(h.scope.memoryUnavailableMessage(), /Open a chat/);
});

test('a new chat never reads or attaches another chat memory with identical messages', async () => {
    const h = harness();
    delete h.settings.chatWorlds.chat;
    h.scope.worlds = [{ id: h.candidate.id, name: 'Person · Earlier chat' }];
    const result = await h.scope.recoverStoredWorldForCurrentChat('');
    assert.equal(result.world, null);
    assert.deepEqual(h.calls.read, []);
    assert.deepEqual(h.calls.save, []);
    assert.deepEqual(h.calls.embed, []);
    assert.equal(h.settings.chatWorlds.chat, undefined);
});

test('missing binding recovery reads only the same named conversation and verifies its messages', async () => {
    const h = harness();
    h.settings.chatWorlds.chat = 'missing-binding';
    h.scope.worlds = [
        { id: 'unrelated', name: 'Person · Earlier chat' },
        { id: h.candidate.id, name: h.candidate.name },
    ];
    const result = await h.scope.recoverStoredWorldForCurrentChat('missing-binding');
    assert.equal(result.world.id, h.candidate.id);
    assert.deepEqual(h.calls.read, [h.candidate.id]);
    assert.equal(h.settings.chatWorlds.chat, h.candidate.id);
    assert.equal(h.calls.embed.length, 1);
});

test('same named recovery still rejects changed conversation history', async () => {
    const h = harness();
    delete h.settings.chatWorlds.chat;
    h.saved.get(h.candidate.id).sources['old-device-chat'].processedMessages[0].fingerprint = 'different';
    const result = await h.scope.recoverStoredWorldForCurrentChat('');
    assert.equal(result.world, null);
    assert.deepEqual(h.calls.save, []);
    assert.deepEqual(h.calls.embed, []);
    assert.equal(h.settings.chatWorlds.chat, undefined);
});

function deviceAliasHarness() {
    const h = invalidPortableHarness();
    const oldKey = 'character:91:chat:Chat';
    const currentKey = 'character:0:chat:Chat';
    h.scope.activeChat = currentKey;
    h.settings.chatWorlds = { [oldKey]: h.original.id };
    h.original.sources = { [oldKey]: h.original.sources.chat };
    h.original.facts = [{ id: 'same-record', subject: 'Guide', predicate: 'owns', value: 'a compass' }];
    h.portable.world = structuredClone(h.original);
    h.saved.delete(h.candidate.id);
    h.scope.worlds = [{ id: h.original.id, name: h.original.name }];
    const documents = buildEmbeddingDocuments(structuredClone(h.original));
    // Simulates the already-paid vector collection keyed by world ID. Changing
    // that ID would make coverage zero even with identical record hashes.
    const storedVectors = new Map([[h.original.id, new Set(documents.map(item => item.hash))]]);
    const assertVectorsRetained = world => {
        const hashes = storedVectors.get(world.id) || new Set();
        const currentDocuments = buildEmbeddingDocuments(structuredClone(world));
        assert.ok(currentDocuments.length > 0);
        assert.equal(currentDocuments.filter(item => hashes.has(item.hash)).length, currentDocuments.length);
    };
    return { ...h, oldKey, currentKey, assertVectorsRetained };
}

for (const embedded of ['valid', 'invalid']) test(`${embedded} portable restore preserves the vector collection across a device index change`, async () => {
    const h = deviceAliasHarness();
    if (embedded === 'invalid') h.portable.world.sources = {};
    const result = await h.scope.ensureCurrentChatMemory(false);
    assert.equal(result.id, h.original.id);
    assert.equal(result.sources[h.oldKey], undefined);
    assert.equal(result.sources[h.currentKey].processedMessages.length, 1);
    assert.equal(h.settings.chatWorlds[h.oldKey], h.original.id);
    assert.equal(h.settings.chatWorlds[h.currentKey], h.original.id);
    assert.equal(h.calls.import, 0, 'do not fork memory or start a new embedding collection');
    h.assertVectorsRetained(result);

    h.scope.activeChat = h.oldKey;
    h.scope.runtime.world = null;
    const returned = await h.scope.refreshWorlds();
    assert.equal(returned.id, h.original.id);
    assert.equal(returned.sources[h.currentKey], undefined);
    assert.equal(returned.sources[h.oldKey].processedMessages.length, 1);
    assert.equal(h.calls.import, 0, 'switching back to the first device must not fork either');
    h.assertVectorsRetained(returned);
});

test('stored-only same-chat recovery keeps its vector collection despite an old device binding', async () => {
    const h = deviceAliasHarness();
    const result = await h.scope.recoverStoredWorldForCurrentChat('missing');
    assert.equal(result.world.id, h.original.id);
    assert.equal(h.calls.import, 0);
    h.assertVectorsRetained(result.world);
});

test('superior synced recovery retains the destination ID when its other binding is a verified device alias', async () => {
    const h = harness();
    const oldKey = 'character:91:chat:Chat', currentKey = 'character:0:chat:Chat';
    h.scope.activeChat = currentKey;
    h.settings.chatWorlds = { [oldKey]: h.original.id, [currentKey]: h.original.id };
    h.original.sources = { [oldKey]: h.original.sources.chat };
    h.candidate.sources = { [oldKey]: h.candidate.sources['old-device-chat'] };
    const result = await h.scope.recoverSuperiorSyncedWorld(h.original);
    assert.equal(result.id, h.original.id);
    assert.equal(result.sources[currentKey].processedMessages.length, 3);
    assert.equal(h.calls.import, 0);
    assert.equal(h.calls.save.length, 1);
});

test('a genuine different-chat binding still forces a copy even alongside verified device aliases', async () => {
    const h = deviceAliasHarness();
    h.settings.chatWorlds['character:91:chat:Different conversation'] = h.original.id;
    const before = structuredClone(h.original);
    const result = await h.scope.ensureCurrentChatMemory(false);
    assert.equal(result.id, 'private-copy');
    assert.equal(h.calls.import, 1);
    assert.deepEqual(h.saved.get(h.original.id), before);
});

test('changed source history cannot use a device alias to bypass fingerprint verification', async () => {
    const h = deviceAliasHarness();
    h.scope.getContext().chat[0].mes = 'Changed history';
    assert.equal(await h.scope.ensureCurrentChatMemory(false), null);
    assert.equal(h.calls.import, 0);
    assert.deepEqual(h.calls.save, []);
    assert.deepEqual(h.calls.embed, []);
    assert.equal(h.settings.chatWorlds[h.currentKey], undefined);
});

test('invalid embedded fingerprints recover from an independently verified same-revision stored copy', async () => {
    const h = invalidPortableHarness();
    const before = structuredClone(h.portable);
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.equal(result.id, h.original.id);
    assert.equal(result.sources.chat.processedMessages.length, 1);
    assert.equal(h.settings.chatWorlds.chat, h.original.id);
    assert.deepEqual(h.calls.read, [h.original.id], 'reuse the already verified stored copy');
    assert.deepEqual(h.calls.embed, [h.original]);
    assert.equal(h.calls.embedOptions[0].force, true, 'repair same-revision metadata instead of skipping it');
    assert.deepEqual(h.calls.toast, []);
    assert.deepEqual(h.calls.save, []);
    assert.equal(h.calls.import, 0);
    assert.deepEqual(h.portable, before, 'never mutate the rejected snapshot in place');
});

test('newer verified stored memory is remapped for the destination before repairing its embedded copy', async () => {
    const h = invalidPortableHarness();
    const stored = { ...h.makeWorld(h.original.id, 3, 'old-device-chat'), revision: h.original.revision + 1 };
    h.saved.set(stored.id, stored);
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.equal(result.sources.chat.processedMessages.length, 3);
    assert.equal(result.sources['old-device-chat'], undefined);
    assert.equal(h.calls.save.length, 1);
    assert.equal(h.calls.embedOptions[0].force, true);
    assert.deepEqual(h.calls.toast, []);
});

test('stored replacement bound to another chat is copied without changing that chat binding or memory', async () => {
    const h = invalidPortableHarness();
    h.settings.chatWorlds.other = h.original.id;
    const result = await h.scope.ensureCurrentChatMemory(false, true);
    assert.equal(result.id, 'private-copy');
    assert.equal(h.settings.chatWorlds.chat, 'private-copy');
    assert.equal(h.settings.chatWorlds.other, h.original.id);
    assert.deepEqual(h.saved.get(h.original.id), h.original);
    assert.equal(h.calls.import, 1);
    assert.deepEqual(h.calls.save, []);
});

for (const problem of ['missing', 'corrupt', 'older', 'changed', 'ahead', 'empty', 'wrong-id', 'unverifiable']) {
    test(`invalid embedded memory stays blocked when its stored replacement is ${problem}`, async () => {
        const h = invalidPortableHarness();
        const stored = h.saved.get(h.original.id);
        if (problem === 'missing') h.scope.worlds = [];
        if (problem === 'corrupt') h.scope.worlds[0].corrupt = true;
        if (problem === 'older') stored.revision--;
        if (problem === 'changed') stored.sources.chat.processedMessages[0].fingerprint = 'changed';
        if (problem === 'ahead') stored.sources.chat.processedMessages[0].index = 99;
        if (problem === 'empty') { stored.sources = {}; stored.extractions = []; }
        if (problem === 'wrong-id') stored.id = 'unrelated';
        if (problem === 'unverifiable') stored.sources = {};
        assert.equal(await h.scope.ensureCurrentChatMemory(true, true), null);
        assert.equal(h.settings.chatWorlds.chat, 'missing-binding');
        assert.equal(h.calls.toast.length, 1);
        assert.match(h.calls.toast[0][1], /No equally recent verified stored copy/);
        assert.deepEqual(h.calls.save, []);
        assert.deepEqual(h.calls.embed, []);
        assert.equal(h.calls.import, 0);
    });
}

for (const change of ['disable', 'chat', 'generation', 'binding']) {
    test(`invalid embedded recovery stops on ${change} during stored loading`, async () => {
        const h = invalidPortableHarness();
        const read = h.scope.api.getWorld;
        h.scope.api.getWorld = async id => {
            const result = await read(id);
            if (change === 'disable') h.settings.enabled = false;
            if (change === 'chat') h.scope.activeChat = 'other';
            if (change === 'generation') h.scope.runtime.generation++;
            if (change === 'binding') h.settings.chatWorlds.chat = 'other-world';
            return result;
        };
        assert.equal(await h.scope.ensureCurrentChatMemory(false, true), null);
        assert.deepEqual(h.calls.save, []);
        assert.deepEqual(h.calls.embed, []);
        assert.deepEqual(h.calls.toast, []);
        assert.equal(h.calls.import, 0);
    });
}
