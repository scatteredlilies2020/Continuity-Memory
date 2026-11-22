import { alignWorldToChat, fingerprintMessage } from './message-digest.js?v=0.15.0-testing.30';
import { digestStabilityRepairFrom } from './digest-policy.js';
import { mergeExtraction, removeChatContributions, restoreRetainedReplayRecords } from './memory-model.js?historical-recall=1&stored-replay=1';
import { refreshChronicleStory } from './chronicle.js';

function remapWorldChatKey(world, from, to) {
    const remapped = structuredClone(world);
    if (!from || from === to) return remapped;
    if (remapped.sources?.[to]) throw new Error('The branch memory already contains a different source under this chat identifier.');

    remapped.sources ||= {};
    remapped.sources[to] = remapped.sources[from];
    delete remapped.sources[from];
    if (remapped.storySoFar?.[from]) {
        remapped.storySoFar[to] = remapped.storySoFar[from];
        delete remapped.storySoFar[from];
    }

    const remapRefs = item => {
        if (!item || typeof item !== 'object') return;
        if (item.chatKey === from) item.chatKey = to;
        for (const source of item.sources || []) {
            if (source?.chatKey === from) source.chatKey = to;
        }
        for (const source of item.observationSources || []) {
            if (source?.chatKey === from) source.chatKey = to;
        }
        for (const entry of item.history || []) remapRefs(entry);
    };
    remapRefs(remapped.scene);
    for (const key of ['entities', 'facts', 'beliefs', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'chronicle', 'extractions', 'threads', 'backgrounds']) {
        for (const item of remapped[key] || []) remapRefs(item);
    }
    for (const correction of remapped.corrections || []) for (const operation of correction.operations || []) {
        if (Object.hasOwn(operation.protectedThrough || {}, from)) {
            operation.protectedThrough[to] = operation.protectedThrough[from];
            delete operation.protectedThrough[from];
        }
        remapRefs(operation.afterRecord);
        remapRefs(operation.supportingHistoryBefore);
        if (operation.category === 'capsules' && operation.beforeSelector?.startsWith(`${from}|`)) {
            operation.beforeSelector = `${to}${operation.beforeSelector.slice(from.length)}`;
        }
    }
    return remapped;
}

function sourceFingerprints(world, sourceChatKey) {
    return new Map((world?.sources?.[sourceChatKey]?.processedMessages || [])
        .map(item => [Number(item?.index), String(item?.fingerprint || '')])
        .filter(([index, fingerprint]) => Number.isInteger(index) && index >= 0 && fingerprint));
}

function extractionFingerprints(extraction, stored) {
    const explicit = (extraction?.messageFingerprints || [])
        .map(item => [Number(item?.index), String(item?.fingerprint || '')])
        .filter(([index, fingerprint]) => Number.isInteger(index) && fingerprint);
    if (explicit.length) return explicit;
    return [...stored.entries()].filter(([index]) => index >= Number(extraction?.from) && index <= Number(extraction?.to));
}

function branchRepairFrom(world, messages, sourceChatKey) {
    const current = new Map((messages || []).map(message => [Number(message.index), fingerprintMessage(message)]));
    const stored = sourceFingerprints(world, sourceChatKey);
    const storedIndexes = [...stored.keys()];
    const latestStored = storedIndexes.length ? Math.max(...storedIndexes) : -1;
    const divergent = [];

    for (const [index, fingerprint] of stored) {
        if (current.get(index) !== fingerprint) divergent.push(index);
    }
    for (const index of current.keys()) {
        if (index <= latestStored && !stored.has(index)) divergent.push(index);
    }
    if (!divergent.length) return null;

    const earliest = Math.min(...divergent);
    const affectedStarts = (world.extractions || [])
        .filter(item => item?.chatKey === sourceChatKey)
        .filter(item => Number(item.to) >= earliest
            || extractionFingerprints(item, stored).some(([index]) => index >= earliest))
        .map(item => Number(item.from))
        .filter(Number.isFinite);
    return affectedStarts.length ? Math.min(earliest, ...affectedStarts) : earliest;
}

/**
 * Forks a copied parent memory onto a SillyTavern branch. Stored Digest results
 * before the divergent/truncated suffix are replayed locally; no model call is
 * needed for that shared prefix.
 */
export function forkWorldToBranch(world, currentMessages, targetChatKey, sourceChatKey = '') {
    if (!world || !targetChatKey) return { ok: false, code: 'invalid-branch', message: 'The branch has no usable memory source.' };
    const sourceKeys = Object.keys(world.sources || {}).filter(key => world.sources?.[key]);
    const sourceKey = sourceChatKey || (sourceKeys.length === 1 ? sourceKeys[0] : '');
    if (!sourceKey || !world.sources?.[sourceKey] || sourceKey === targetChatKey) {
        return { ok: false, code: 'invalid-branch-source', message: 'The parent memory source could not be identified unambiguously.' };
    }

    return reuseWorldPrefix(world, currentMessages, targetChatKey, sourceKey);
}

/** Recover only a strictly truncated, same-identity chat; never changed history. */
export function recoverTruncatedChatPrefix(world, currentMessages, targetChatKey) {
    const rejected = { ok: false, code: 'not-verified-tail', message: 'This memory is not a verified same-chat tail rollback.' };
    const keys = Object.keys(world?.sources || {});
    if (keys.length !== 1 || !targetChatKey) return rejected;
    const sourceKey = keys[0];
    const identity = key => String(key).includes(':chat:') ? String(key).split(':chat:').slice(1).join(':chat:') : '';
    if (sourceKey !== targetChatKey && (!identity(targetChatKey) || identity(sourceKey) !== identity(targetChatKey))) return rejected;
    const messages = Array.isArray(currentMessages) ? currentMessages : [];
    if (!messages.length) return rejected;
    const alignment = alignWorldToChat(world, messages, targetChatKey);
    if (alignment.ok || alignment.code !== 'import-ahead' || alignment.changed || !alignment.matched) return rejected;

    const current = new Map(messages.map(message => [Number(message.index), fingerprintMessage(message)]));
    const stored = sourceFingerprints(world, sourceKey);
    const latest = Math.max(...current.keys());
    // Missing interior positions and newly visible/inserted messages are not
    // tail truncation, even when every remaining stored fingerprint matches.
    if ([...current].some(([index, fingerprint]) => stored.get(index) !== fingerprint)
        || [...stored.keys()].some(index => !current.has(index) && index <= latest)) return rejected;

    const result = reuseWorldPrefix(world, messages, targetChatKey, sourceKey);
    if (!result.ok || !result.retained || !alignWorldToChat(result.world, messages, targetChatKey).ok) return rejected;
    return {
        ...result,
        code: 'tail-prefix-recovered',
        message: `Recovered ${result.retained} verified Digest record(s) after this chat's tail was shortened. The affected tail is pending; the complete original memory was preserved as a separate backup.`,
    };
}

function reuseWorldPrefix(world, currentMessages, targetChatKey, sourceKey) {
    const messages = Array.isArray(currentMessages) ? currentMessages : [];
    const stored = sourceFingerprints(world, sourceKey);
    if (!stored.size) return { ok: false, code: 'unverifiable-branch', message: 'The parent memory has no message fingerprints to verify.' };

    const repairStarts = [
        branchRepairFrom(world, messages, sourceKey),
        digestStabilityRepairFrom(messages, world.extractions || [], sourceKey),
    ].filter(value => value !== null && value !== undefined).map(Number).filter(Number.isFinite);
    let repairFrom = repairStarts.length ? Math.min(...repairStarts) : Number.POSITIVE_INFINITY;
    let retained = (world.extractions || [])
        .filter(item => item?.chatKey === sourceKey && Number(item.to) < repairFrom)
        .sort((left, right) => Number(left.from) - Number(right.from));

    // A legacy extraction without its stored result cannot be replayed. Keep
    // the still-replayable prefix and let normal Digest processing resume there.
    const firstUnreplayable = retained.find(item => !item.result || typeof item.result !== 'object'
        || !extractionFingerprints(item, stored).length);
    if (firstUnreplayable) {
        repairFrom = Math.min(repairFrom, Number(firstUnreplayable.from));
        retained = retained.filter(item => Number(item.to) < repairFrom);
    }

    const current = new Map(messages.map(message => [Number(message.index), fingerprintMessage(message)]));
    const firstInvalid = retained.find(item => extractionFingerprints(item, stored)
        .some(([index, fingerprint]) => current.get(index) !== fingerprint));
    if (firstInvalid) {
        repairFrom = Math.min(repairFrom, Number(firstInvalid.from));
        retained = retained.filter(item => Number(item.to) < repairFrom);
    }

    const previousWorld = remapWorldChatKey(world, sourceKey, targetChatKey);
    // Parent-only future messages are not this branch's corrected past. Limit
    // temporal locks to its fingerprint-verified shared prefix.
    let sharedThrough = -1;
    for (const [index, fingerprint] of [...stored].sort((a, b) => a[0] - b[0])) {
        if (current.get(index) !== fingerprint) break;
        sharedThrough = index;
    }
    for (const correction of previousWorld.corrections || []) for (const operation of correction.operations || []) {
        if (Number.isInteger(operation.protectedThrough?.[targetChatKey])) {
            operation.protectedThrough[targetChatKey] = Math.min(operation.protectedThrough[targetChatKey], sharedThrough);
        }
    }
    // If every stored Digest is fingerprint-verified and the branch only adds
    // undigested messages, the remapped parent is already the exact prefix.
    // Avoid rebuilding the entire world just to change its chat identifier.
    const completePrefix = !Number.isFinite(repairFrom)
        && retained.length === (world.extractions || []).filter(item => item?.chatKey === sourceKey).length;
    const branchedWorld = completePrefix ? previousWorld : structuredClone(previousWorld);
    if (!completePrefix) {
        removeChatContributions(branchedWorld, targetChatKey);
        for (const item of retained) {
            mergeExtraction(branchedWorld, structuredClone(item.result), {
                chatKey: targetChatKey,
                from: Number(item.from),
                to: Number(item.to),
                allowStateUpdates: true,
                replayStoredExtraction: true,
                messageFingerprints: extractionFingerprints(item, stored)
                    .map(([index, fingerprint]) => ({ index, fingerprint })),
            });
        }
        restoreRetainedReplayRecords(branchedWorld, previousWorld, targetChatKey, { rekeyed: sourceKey !== targetChatKey });
    }
    refreshChronicleStory(branchedWorld, targetChatKey);

    const processed = branchedWorld.sources?.[targetChatKey]?.processedMessages?.length || 0;
    return {
        ok: true,
        code: 'branch-prefix-reused',
        message: `Reused ${retained.length} verified Digest record(s) from the parent branch; only the divergent suffix remains pending.`,
        matched: processed,
        pending: Math.max(0, messages.length - processed),
        retained: retained.length,
        repairFrom: Number.isFinite(repairFrom) ? repairFrom : null,
        sourceChatKey: sourceKey,
        changed: true,
        world: branchedWorld,
    };
}
