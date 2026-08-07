function fastHash(value) {
    const source = String(value ?? '');
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        first ^= code;
        first = Math.imul(first, 0x01000193);
        second ^= code + index;
        second = Math.imul(second, 0x85ebca6b);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function fingerprintMessage({ index, name, text }) {
    return fastHash(`${Number(index)}\u0000${String(name || '')}\u0000${String(text || '')}`);
}

export function collectFingerprintMessages(chat = []) {
    const messages = [];
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        const body = String(message?.mes || '').trim();
        if (!message || message.is_system || !body) continue;
        messages.push({
            index,
            name: message.name || (message.is_user ? 'User' : 'Character'),
            text: body,
        });
    }
    return messages;
}

export function collectMemoryEligibleMessages(chat = []) {
    const messages = collectFingerprintMessages(chat);
    if (!messages.length) return messages;
    const latest = messages.at(-1);
    return chat[latest.index]?.is_user ? messages : messages.slice(0, -1);
}

function extractionFingerprints(world, extraction, chatKey) {
    if ((extraction?.messageFingerprints || []).length) return extraction.messageFingerprints;
    return (world.sources?.[chatKey]?.processedMessages || [])
        .filter(item => Number(item.index) >= Number(extraction.from) && Number(item.index) <= Number(extraction.to))
        .map(item => ({ index: Number(item.index), fingerprint: String(item.fingerprint || '') }));
}

export function findChangedExtractions(world, currentMessages, chatKey) {
    if (!world || !chatKey) return [];
    const current = new Map((currentMessages || []).map(message => [
        Number(message.index),
        fingerprintMessage(message),
    ]));
    return (world.extractions || []).filter(extraction => {
        if (extraction?.chatKey !== chatKey) return false;
        const saved = extractionFingerprints(world, extraction, chatKey);
        return saved.some(item => {
            const index = Number(item.index);
            return current.has(index) && current.get(index) !== String(item.fingerprint || '');
        });
    });
}

/**
 * Returns stored extraction ranges whose source can no longer be verified
 * against the active chat. Unlike findChangedExtractions, this also treats a
 * deleted source message or missing provenance as invalid. Retrieval uses this
 * fail-closed view while the mutation repair job is still pending.
 */
export function findInvalidExtractionRanges(world, currentMessages, chatKey) {
    if (!world || !chatKey) return [];
    const current = new Map((currentMessages || []).map(message => [
        Number(message.index),
        fingerprintMessage(message),
    ]));
    return (world.extractions || []).filter(extraction => {
        if (extraction?.chatKey !== chatKey) return false;
        const saved = extractionFingerprints(world, extraction, chatKey);
        if (!saved.length) return true;
        return saved.some(item => {
            const index = Number(item.index);
            return !current.has(index) || current.get(index) !== String(item.fingerprint || '');
        });
    }).map(extraction => ({
        id: String(extraction.id || ''),
        chatKey,
        from: Number(extraction.from),
        to: Number(extraction.to),
    })).filter(range => Number.isFinite(range.from) && Number.isFinite(range.to));
}

function hasContinuityData(world) {
    if (world?.scene) return true;
    return ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'backgrounds']
        .some(key => Array.isArray(world?.[key]) && world[key].length > 0);
}

function sourceRecords(source) {
    const records = new Map();
    for (const item of source?.processedMessages || []) {
        const index = Number(item?.index);
        const fingerprint = String(item?.fingerprint || '');
        if (!Number.isInteger(index) || index < 0 || !fingerprint) continue;
        records.set(index, { index, fingerprint });
    }
    return [...records.values()].sort((a, b) => a.index - b.index);
}

function inspectSource(chatKey, source, currentByIndex) {
    const records = sourceRecords(source);
    let matched = 0;
    let changed = 0;
    let ahead = 0;
    for (const record of records) {
        const current = currentByIndex.get(record.index);
        if (!current) ahead++;
        else if (current.fingerprint === record.fingerprint) matched++;
        else changed++;
    }
    return {
        chatKey,
        records: records.length,
        matched,
        changed,
        ahead,
        lastProcessedIndex: records.at(-1)?.index ?? -1,
        aligned: records.length > 0 && changed === 0 && ahead === 0,
    };
}

function remapChatKey(world, from, to) {
    const aligned = structuredClone(world);
    if (!from || from === to) return aligned;
    if (aligned.sources?.[to]) throw new Error('The imported memory already contains a different source under this chat identifier.');

    aligned.sources ||= {};
    aligned.sources[to] = aligned.sources[from];
    delete aligned.sources[from];

    const remapRefs = item => {
        if (!item || typeof item !== 'object') return;
        if (item.chatKey === from) item.chatKey = to;
        if (Array.isArray(item.sources)) {
            for (const source of item.sources) {
                if (source?.chatKey === from) source.chatKey = to;
            }
        }
    };
    remapRefs(aligned.scene);
    for (const key of ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'backgrounds']) {
        for (const item of aligned[key] || []) remapRefs(item);
    }
    return aligned;
}

function chatIdentity(chatKey) {
    const marker = ':chat:';
    const position = String(chatKey || '').indexOf(marker);
    return position >= 0 ? String(chatKey).slice(position + marker.length) : '';
}

function consolidateSourceAliases(world, candidates, currentChatKey) {
    const targetIdentity = chatIdentity(currentChatKey);
    const aliases = candidates.filter(candidate => chatIdentity(candidate.chatKey) === targetIdentity);
    if (!targetIdentity || aliases.length !== candidates.length || !aliases.every(candidate => candidate.aligned)) return null;

    const ranked = [...aliases].sort((left, right) => {
        const recordDifference = right.records - left.records;
        if (recordDifference) return recordDifference;
        const indexDifference = right.lastProcessedIndex - left.lastProcessedIndex;
        if (indexDifference) return indexDifference;
        if (left.chatKey === currentChatKey && right.chatKey !== currentChatKey) return -1;
        if (right.chatKey === currentChatKey && left.chatKey !== currentChatKey) return 1;
        return String(world.sources?.[right.chatKey]?.lastProcessedAt || '')
            .localeCompare(String(world.sources?.[left.chatKey]?.lastProcessedAt || ''));
    });
    const keep = ranked[0];
    const droppedKeys = new Set(ranked.slice(1).map(candidate => candidate.chatKey));
    const consolidated = structuredClone(world);

    const filterSources = item => {
        if (!item || !Array.isArray(item.sources)) return item;
        const sources = item.sources.filter(source => !droppedKeys.has(source?.chatKey));
        return sources.length ? { ...item, sources } : null;
    };
    const removedCapsuleIds = new Set((consolidated.capsules || [])
        .filter(item => droppedKeys.has(item?.chatKey))
        .map(item => item.id));
    const removedArcIds = new Set((consolidated.arcs || [])
        .filter(item => droppedKeys.has(item?.chatKey) || (item.capsuleIds || []).some(id => removedCapsuleIds.has(id)))
        .map(item => item.id));

    consolidated.scene = filterSources(consolidated.scene);
    for (const key of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']) {
        consolidated[key] = (consolidated[key] || []).map(filterSources).filter(Boolean);
    }
    consolidated.capsules = (consolidated.capsules || [])
        .filter(item => !droppedKeys.has(item?.chatKey))
        .map(filterSources)
        .filter(Boolean);
    consolidated.extractions = (consolidated.extractions || []).filter(item => !droppedKeys.has(item?.chatKey));
    consolidated.arcs = (consolidated.arcs || [])
        .filter(item => !removedArcIds.has(item.id))
        .map(filterSources)
        .filter(Boolean);
    consolidated.eras = (consolidated.eras || [])
        .filter(item => !(item.arcIds || []).some(id => removedArcIds.has(id)))
        .map(filterSources)
        .filter(Boolean);
    for (const key of droppedKeys) delete consolidated.sources?.[key];

    return {
        keep,
        world: remapChatKey(consolidated, keep.chatKey, currentChatKey),
        aliases: ranked.map(candidate => candidate.chatKey),
    };
}

/**
 * Verifies that every processed message represented by one imported source is
 * still present at the same position in the current chat. Newer, unprocessed
 * current messages are allowed; imported messages ahead of the current chat or
 * changed at the same index are not.
 */
export function alignWorldToChat(world, currentMessages, currentChatKey) {
    if (!world || typeof world !== 'object' || Array.isArray(world)) {
        return { ok: false, code: 'invalid', message: 'The imported file does not contain a valid Continuity memory.' };
    }
    if (!currentChatKey) {
        return { ok: false, code: 'no-chat', message: 'Open the destination chat before importing memory.' };
    }

    const current = (currentMessages || []).map(message => ({ ...message, fingerprint: fingerprintMessage(message) }));
    const currentByIndex = new Map(current.map(message => [Number(message.index), message]));
    const candidates = Object.entries(world.sources || {})
        .map(([chatKey, source]) => inspectSource(chatKey, source, currentByIndex))
        .filter(candidate => candidate.records > 0)
        .sort((a, b) => {
            if (a.chatKey === currentChatKey && b.chatKey !== currentChatKey) return -1;
            if (b.chatKey === currentChatKey && a.chatKey !== currentChatKey) return 1;
            return b.matched - a.matched || b.records - a.records;
        });

    if (!hasContinuityData(world) && !candidates.length) {
        return {
            ok: true,
            code: 'empty',
            message: 'The imported memory is empty and has no chat history to align.',
            matched: 0,
            pending: current.length,
            world: structuredClone(world),
        };
    }
    if (!candidates.length) {
        return {
            ok: false,
            code: 'unverifiable',
            message: 'Import blocked: this memory contains continuity data but no message fingerprints, so its source chat cannot be verified.',
        };
    }
    if (candidates.length > 1) {
        const consolidated = consolidateSourceAliases(world, candidates, currentChatKey);
        if (consolidated) {
            const { keep } = consolidated;
            return {
                ok: true,
                code: 'aligned-source-aliases',
                message: `Verified ${keep.matched} processed message(s) and consolidated ${consolidated.aliases.length} device aliases for this chat.`,
                ...keep,
                pending: Math.max(0, current.length - keep.matched),
                sourceChatKey: keep.chatKey,
                changed: true,
                aliases: consolidated.aliases,
                world: consolidated.world,
            };
        }
        return {
            ok: false,
            code: 'multiple-source-chats',
            message: 'Import blocked: this memory contains history from more than one source chat. Continuity memories must belong to one conversation only.',
        };
    }

    const match = candidates.find(candidate => candidate.aligned);
    if (!match) {
        const best = candidates[0];
        const detail = best.ahead
            ? `${best.ahead} processed source message(s) are ahead of or missing from this chat`
            : `${best.changed} processed source message(s) differ at the same positions`;
        return {
            ok: false,
            code: best.ahead ? 'import-ahead' : 'changed-or-branched',
            message: `Import blocked: ${detail}. The memory may belong to another chat or branch.`,
            ...best,
        };
    }
    if (match.chatKey !== currentChatKey && world.sources?.[currentChatKey]) {
        return {
            ok: false,
            code: 'ambiguous-source',
            message: 'Import blocked: the memory contains conflicting source identities for this chat.',
            ...match,
        };
    }

    return {
        ok: true,
        code: 'aligned',
        message: `Verified ${match.matched} processed message(s); ${Math.max(0, current.length - match.matched)} current message(s) remain pending.`,
        ...match,
        pending: Math.max(0, current.length - match.matched),
        sourceChatKey: match.chatKey,
        changed: match.chatKey !== currentChatKey,
        world: remapChatKey(world, match.chatKey, currentChatKey),
    };
}
