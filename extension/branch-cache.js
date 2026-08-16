import { fingerprintMessage } from './message-digest.js?v=0.14.0-standalone.117';
import { l1StabilityRepairFrom } from './l1-policy.js';
import { mergeExtraction, removeChatContributions, restoreRetainedReplayRecords } from './memory-model.js';

function remapWorldChatKey(world, from, to) {
    const remapped = structuredClone(world);
    if (!from || from === to) return remapped;
    if (remapped.sources?.[to]) throw new Error('The branch memory already contains a different source under this chat identifier.');

    remapped.sources ||= {};
    remapped.sources[to] = remapped.sources[from];
    delete remapped.sources[from];

    const remapRefs = item => {
        if (!item || typeof item !== 'object') return;
        if (item.chatKey === from) item.chatKey = to;
        for (const source of item.sources || []) {
            if (source?.chatKey === from) source.chatKey = to;
        }
    };
    remapRefs(remapped.scene);
    for (const key of ['entities', 'facts', 'beliefs', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'backgrounds']) {
        for (const item of remapped[key] || []) remapRefs(item);
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
 * Forks a copied parent memory onto a SillyTavern branch. Stored L1 results
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

    const messages = Array.isArray(currentMessages) ? currentMessages : [];
    const stored = sourceFingerprints(world, sourceKey);
    if (!stored.size) return { ok: false, code: 'unverifiable-branch', message: 'The parent memory has no message fingerprints to verify.' };

    const repairStarts = [
        branchRepairFrom(world, messages, sourceKey),
        l1StabilityRepairFrom(messages, world.extractions || [], sourceKey),
    ].filter(value => value !== null && value !== undefined).map(Number).filter(Number.isFinite);
    let repairFrom = repairStarts.length ? Math.min(...repairStarts) : Number.POSITIVE_INFINITY;
    let retained = (world.extractions || [])
        .filter(item => item?.chatKey === sourceKey && Number(item.to) < repairFrom)
        .sort((left, right) => Number(left.from) - Number(right.from));

    // A legacy extraction without its stored result cannot be replayed. Keep
    // the still-replayable prefix and let normal L1 processing resume there.
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
    const branchedWorld = structuredClone(previousWorld);
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
    restoreRetainedReplayRecords(branchedWorld, previousWorld, targetChatKey);

    const processed = branchedWorld.sources?.[targetChatKey]?.processedMessages?.length || 0;
    return {
        ok: true,
        code: 'branch-prefix-reused',
        message: `Reused ${retained.length} verified L1 record(s) from the parent branch; only the divergent suffix remains pending.`,
        matched: processed,
        pending: Math.max(0, messages.length - processed),
        retained: retained.length,
        repairFrom: Number.isFinite(repairFrom) ? repairFrom : null,
        sourceChatKey: sourceKey,
        changed: true,
        world: branchedWorld,
    };
}
