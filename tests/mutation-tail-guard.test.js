import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sourceMutationAffectsStoredMemory } from '../extension/coverage.js';
import { resolveInjectionPlacement } from '../extension/injection-placement.js';

const processedWorld = (indexes, extractions = []) => ({
    sources: { chat: { processedMessages: indexes.map(index => ({ index, fingerprint: 'f', version: 57 })) } },
    extractions,
});

test('only positions inside stored memory can require a repair', () => {
    const world = processedWorld([0, 1, 2, 3], [{ chatKey: 'chat', from: 0, to: 3 }]);
    assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', 4), false, 'the newest reply was never processed');
    assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', 3), true, 'the last processed position');
    assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', 0), true, 'older history');
    assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', 99), false);
});

test('stored extraction ranges count even without per-message records', () => {
    const world = { extractions: [{ chatKey: 'chat', from: 4, to: 7 }] };
    assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', 7), true);
    assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', 8), false);
    assert.equal(sourceMutationAffectsStoredMemory(world, 'other', 4), false, 'another chat’s records do not count');
});

test('a stored range ahead of the chat still counts, so a rollback keeps its repair', () => {
    const world = processedWorld([0, 1, 2, 3, 4, 5, 6]);
    assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', 5), true);
});

test('an unknown position or an unloaded world never skips the repair', () => {
    const world = processedWorld([0, 1]);
    for (const index of [undefined, null, 'not-a-number']) assert.equal(sourceMutationAffectsStoredMemory(world, 'chat', index), true);
    assert.equal(sourceMutationAffectsStoredMemory(null, 'chat', 5), true);
    assert.equal(sourceMutationAffectsStoredMemory(undefined, 'chat', 5), true);
    assert.equal(sourceMutationAffectsStoredMemory({}, 'chat', 5), false, 'a world with nothing stored has nothing to repair');
});

const indexSource = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
const deletionBlock = indexSource.match(/    if \(event_types.MESSAGE_DELETED\) \{[^]*?^    \}/m)?.[0];

function deletionHarness(world, deletedIndex, { processing = false } = {}) {
    assert.ok(deletionBlock, 'the MESSAGE_DELETED handler exists');
    const calls = [];
    const mutations = [];
    let listener;
    const scope = vm.createContext({
        event_types: { MESSAGE_DELETED: 'deleted' },
        PROMPT_KEY: 'continuity_memory_context',
        eventSource: { on: (_name, callback) => { listener = callback; } },
        runtime: { processing, queue: [], world },
        preparedInjection: { snapshot: true },
        promptManager: null,
        getChatKey: () => 'chat',
        getSettings: () => ({ enabled: true, injectionPosition: 'at-depth', injectionDepth: 0, injectionRole: 'user' }),
        extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 0, BEFORE_PROMPT: 2, NONE: 3 },
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        sourceMutationAffectsStoredMemory, resolveInjectionPlacement,
        cancelGenerationRetrieval: () => calls.push('cancel-retrieval'),
        invalidateRuntimeWork: () => calls.push('invalidate-runtime'),
        invalidateStoryWork: () => calls.push('invalidate-story'),
        clearPromptManagerInjection: () => calls.push('clear-prompt-manager'),
        setExtensionPrompt: () => calls.push('clear-extension-prompt'),
        continuityContextBridge: { publish: () => calls.push('publish-blank') },
        scheduleInjectionRefresh: () => calls.push('refresh'),
        scheduleMutationSync: (delay, requireRepair) => mutations.push({ delay, requireRepair }),
    });
    vm.runInContext(deletionBlock, scope);
    listener(deletedIndex);
    return { calls, mutations, scope };
}

test('regenerating the newest reply no longer waits on a mutation repair', () => {
    const world = processedWorld([0, 1, 2, 3]);
    const h = deletionHarness(world, 4); // SillyTavern deleted the last assistant message
    assert.deepEqual(h.mutations, [{ delay: 350, requireRepair: false }]);
    assert.ok(h.calls.includes('refresh'), 'the preview still refreshes for the new branch');
    assert.ok(h.calls.includes('clear-prompt-manager') && h.calls.includes('clear-extension-prompt'), 'the mandatory prompt is still removed while the branch settles');
    assert.equal(h.scope.preparedInjection, null);
});

test('deleting a message that was processed still requests the repair', () => {
    const world = processedWorld([0, 1, 2, 3]);
    for (const index of [0, 2, 3]) assert.deepEqual(deletionHarness(world, index).mutations, [{ delay: 350, requireRepair: true }]);
});

test('an unknown index or an unloaded world keeps the repair, and in-flight work is still discarded', () => {
    const world = processedWorld([0, 1, 2, 3]);
    assert.deepEqual(deletionHarness(world, undefined).mutations, [{ delay: 350, requireRepair: true }]);
    assert.deepEqual(deletionHarness(null, 4).mutations, [{ delay: 350, requireRepair: true }]);
    const h = deletionHarness(world, 4, { processing: true });
    assert.deepEqual(h.mutations, [{ delay: 350, requireRepair: false }]);
    assert.ok(h.calls.includes('invalidate-runtime') && h.calls.includes('invalidate-story'), 'work containing the deleted message is still discarded');
});
