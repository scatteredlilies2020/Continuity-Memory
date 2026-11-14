import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { mergeExtraction, removeChatContributions, restoreRetainedReplayRecords } from '../extension/memory-model.js';
import { fingerprintMessage } from '../extension/message-digest.js';
import { analyzeBranchDivergence } from '../extension/coverage.js';
import { digestStabilityRepairFrom } from '../extension/digest-policy.js';
import { assertChronicleChanges } from '../extension/chronicle-validation.js';

function extraction() {
    return {
        chronicleEntry: 'Alice reached the city. She met Bob. They waited.',
        sceneCapsule: { title: 'Arrival', opening: 'Alice reached the city.',
            beats: ['She met Bob.'], closing: 'They waited.', participants: [], importance: 3 },
        entities: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [],
    };
}
const meta = { chatKey: 'chat', from: 0, to: 7, allowStateUpdates: true };

test('stored replay recovers malformed legacy Chronicle entries only from the same Digest prose', () => {
    for (const chronicleEntry of ['R', ' A. ', '', '...', '界。', null, 7]) {
        const result = { ...extraction(), chronicleEntry };
        const original = structuredClone(result);
        const world = {};
        mergeExtraction(world, result, { ...meta, replayStoredExtraction: true });
        assert.equal(world.capsules[0].chronicleText, extraction().chronicleEntry);
        assert.equal(world.chronicle[0].text, extraction().chronicleEntry);
        assert.equal(world.extractions[0].result.chronicleEntry, extraction().chronicleEntry);
        assert.deepEqual(result, original, 'Replay must not mutate the saved input snapshot.');
        assert.doesNotThrow(() => assertChronicleChanges(world));
    }
});

test('fresh model results remain rejected even when their Digest could supply fallback prose', () => {
    for (const replayStoredExtraction of [undefined, false]) {
        const world = {}, before = structuredClone(world);
        assert.throws(() => mergeExtraction(world, { ...extraction(), chronicleEntry: 'R' },
            { ...meta, replayStoredExtraction }), { code: 'CM_INCOMPLETE_RECORDS' });
        assert.deepEqual(world, before);
    }
});

test('stored replay cannot manufacture narrative from a title, metadata, or another record', () => {
    for (const chronicleEntry of ['R', '', null]) {
        const result = { ...extraction(), chronicleEntry,
            sceneCapsule: { title: 'A complete looking title', storyTime: 'Day one', opening: '', beats: [], closing: '' } };
        const world = { capsules: [{ chronicleText: 'Unrelated later events.' }] };
        const before = structuredClone(world);
        assert.throws(() => mergeExtraction(world, result, { ...meta, replayStoredExtraction: true }));
        assert.deepEqual(world, before);
    }
});

test('valid and pre-Chronicle stored entries retain their existing replay behavior', () => {
    for (const chronicleEntry of [undefined, '天亮。', 'Alice arrived quietly.']) {
        const result = { ...extraction(), chronicleEntry }, world = {};
        mergeExtraction(world, result, { ...meta, replayStoredExtraction: true });
        assert.equal(world.extractions[0].result.chronicleEntry, chronicleEntry);
        if (chronicleEntry) assert.equal(world.capsules[0].chronicleText, chronicleEntry);
    }
});

test('deletion repair replays legacy entries, removes the stale suffix, and clears the reply repair flag', async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ index, text: `Source ${index}` }));
    const world = { id: 'world' };
    for (const from of [0, 8, 16]) {
        mergeExtraction(world, extraction(), { ...meta, from, to: from + 7,
            messageFingerprints: messages.slice(from, from + 8).map(message => ({
                index: message.index, fingerprint: fingerprintMessage(message),
            })) });
    }
    world.extractions[0].result.chronicleEntry = 'R';
    world.capsules[0].chronicleText = 'R';
    const previous = structuredClone(world);
    const retainedId = world.capsules[0].id;
    // Delete the tail back into the second range. No model extraction should
    // run with this small backlog; only local retained-prefix replay is needed.
    const remaining = messages.slice(0, 13);
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
    const runtime = { world, processing: false, paused: false };
    let saves = 0;
    const scope = {
        runtime, structuredClone, getBoundWorldId: () => 'world', getChatKey: () => 'chat',
        getContext: () => ({ chat: remaining }), collectMemoryEligibleMessages: chat => chat,
        requireRetryStorage: async () => {}, digestStabilityRepairFrom,
        getBranchRepairStatus: (value, active) => analyzeBranchDivergence(active,
            value.sources.chat.processedMessages, value.extractions, 'chat'),
        stableStoryMessages: active => active, fingerprintMessage,
        planStoryMutationRecovery: () => ({ changed: false, checkpointTo: null }),
        mergeExtraction, removeChatContributions, restoreRetainedReplayRecords,
        updateRuntime: patch => Object.assign(runtime, patch),
        api: { saveWorld: async value => { saves++; assertChronicleChanges(value, previous); return { world: value }; } },
        embedWorldInChat: async () => {}, queueMicrotask: () => {}, processQueue: () => {},
        mutationRepairPromise: null, mutationSync: null, divergenceRepairRequested: true,
        clearTimeout: () => {}, getTailRollbackStatus: () => ({ detected: false }),
        syncChangedExtractions: async () => ({ synced: false }),
    };
    const repair = engine.match(/export async function repairDivergedBranch\([^]*?^}/m)[0].replace('export ', '');
    const sync = source.match(/function synchronizeSourceMutation\([^]*?^}/m)[0];
    const synchronize = runInNewContext(`${repair}\n${sync}\nsynchronizeSourceMutation`, scope);
    const result = await synchronize();
    assert.equal(result.repaired, true);
    assert.equal(result.repairFrom, 8);
    assert.equal(saves, 1);
    assert.deepEqual(runtime.world.extractions.map(item => [item.from, item.to]), [[0, 7]]);
    assert.equal(runtime.world.capsules[0].id, retainedId);
    assert.equal(runtime.world.capsules[0].chronicleText, extraction().chronicleEntry);
    assert.equal(scope.divergenceRepairRequested, false);
    assert.equal(scope.mutationRepairPromise, null);
    // A later no-change sync does not replay, save, or re-arm the reply gate.
    await synchronize();
    assert.equal(saves, 1);
    assert.equal(scope.divergenceRepairRequested, false);
});
