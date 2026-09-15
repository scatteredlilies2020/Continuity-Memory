import { anchoredRelativeText, anchoredStoryTime } from './temporal-anchors.js';
// The two legacy collections remain on disk for import, replay and Git-upgrade compatibility.
// Their contents are evidence at a source boundary, never an outstanding-task register.
const text = value => String(value ?? '').trim();
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];

export function supportingSnapshot(item) {
    return {
        title: text(item.title || item.topic),
        detail: text(item.detail || item.summary),
        certainty: text(item.certainty),
        ...(Number.isFinite(Number(item.importance)) ? { importance: Number(item.importance) } : {}),
        participants: [...(item.participants || [])],
        temporalAnchorId: text(item.temporalAnchorId),
        ...(item.temporal ? { temporal: structuredClone(item.temporal) } : {}),
        ...(item.temporalAnchorIds?.length ? { temporalAnchorIds: [...item.temporalAnchorIds] } : {}),
        ...(item.temporalFrames?.length ? { temporalFrames: [...item.temporalFrames] } : {}),
        sources: structuredClone(item.observationSources || item.sources || []),
        ...((item.legacyStatuses?.length || item.legacyStatus || (item.status && item.status !== 'recorded'))
            ? { legacyStatuses: [...new Set([...(item.legacyStatuses || []), item.legacyStatus, item.status !== 'recorded' ? item.status : null].filter(Boolean))] } : {}),
        ...(item.status && item.status !== 'recorded' ? { legacyStatus: item.status } : {}),
        ...(item.legacyStatus ? { legacyStatus: item.legacyStatus } : {}),
    };
}

export function supportingIdentity(item) {
    const snapshot = supportingSnapshot(item);
    // Be conservative: a different heading, attribution, time or certainty is information.
    return JSON.stringify([snapshot.title, snapshot.detail, snapshot.certainty,
        [...snapshot.participants].sort(), snapshot.temporalAnchorId, snapshot.temporal, snapshot.temporalAnchorIds, snapshot.temporalFrames]);
}

export function supportingHistory(...records) {
    const entries = new Map();
    for (const record of records.filter(Boolean)) {
        for (const raw of [...(record.history || []), supportingSnapshot(record)]) {
            const item = supportingSnapshot(raw);
            if (!item.title && !item.detail) continue;
            const key = supportingIdentity(item);
            const prior = entries.get(key);
            if (prior) {
                const sources = [...prior.sources, ...item.sources];
                prior.sources = [...new Map(sources.map(source => [JSON.stringify([source.chatKey, source.from, source.to, source.kind, source.correctionId]), source])).values()];
                const statuses = [...new Set([...(prior.legacyStatuses || []), prior.legacyStatus, ...(item.legacyStatuses || []), item.legacyStatus].filter(Boolean))];
                if (statuses.length) prior.legacyStatuses = statuses;
                if (item.importance !== undefined) prior.importance = Math.max(prior.importance || 0, item.importance);
            }
            else entries.set(key, item);
        }
    }
    return [...entries.values()];
}

function replayHistory(world, collection) {
    const byId = new Map();
    const needed = new Set((world?.[collection] || []).filter(record => !record.correctionId && !record.history && !record.observationSources).map(record => record.id));
    if (!needed.size) return byId;
    const rangeKey = item => JSON.stringify([item.chatKey, Number(item.from), Number(item.to)]);
    const capsules = new Map((world.capsules || []).map(item => [rangeKey(item), item]));
    for (const extraction of world?.extractions || []) {
        for (const item of extraction.result?.[collection] || []) {
            if (!needed.has(item.targetId)) continue;
            const entries = byId.get(item.targetId) || [];
            const capsule = capsules.get(rangeKey(extraction));
            entries.push({ ...item, temporalAnchorId: item.temporalAnchorId || capsule?.temporal?.anchorId || '', sources: [{ chatKey: extraction.chatKey, from: extraction.from, to: extraction.to }] });
            byId.set(item.targetId, entries);
        }
    }
    return byId;
}

export function retainSupportingHistory(world) {
    for (const collection of ['threads', 'backgrounds']) {
        const replay = replayHistory(world, collection);
        for (const record of world?.[collection] || []) {
            if (record.correctionId) continue;
            record.history = supportingHistory(...(record.history || record.observationSources ? [] : replay.get(record.id) || []), record);
            record.observationSources ||= structuredClone(record.sources || []);
        }
    }
}

export function supportingRecords(world, collection) {
    const replay = replayHistory(world, collection);
    return (world?.[collection] || []).flatMap(record => {
        const snapshots = supportingHistory(...(record.correctionId || record.history || record.observationSources ? [] : replay.get(record.id) || []), record);
        const currentKey = supportingIdentity(record);
        return snapshots.map((snapshot, index) => ({
            id: supportingIdentity(snapshot) === currentKey ? record.id : `${record.id}:evidence:${index}`,
            recordId: record.id,
            collection,
            ...(collection === 'threads' ? { title: snapshot.title, detail: snapshot.detail }
                : { topic: snapshot.title, summary: snapshot.detail }),
            certainty: snapshot.certainty,
            participants: snapshot.participants,
            temporalAnchorId: snapshot.temporalAnchorId,
            ...(snapshot.temporal ? { temporal: snapshot.temporal } : {}),
            ...(snapshot.temporalAnchorIds ? { temporalAnchorIds: snapshot.temporalAnchorIds } : {}),
            ...(snapshot.temporalFrames ? { temporalFrames: snapshot.temporalFrames } : {}),
            sources: snapshot.sources,
            importance: snapshot.importance ?? record.importance,
            // Audit only. Never used as a retrieval gate or a current-state assertion.
            legacyStatus: snapshot.legacyStatuses?.join(', ') || snapshot.legacyStatus,
        }));
    });
}

export function supportingEvidenceText(item, { compact = false } = {}) {
    const ranges = unique((item.sources || []).filter(source => Number.isFinite(Number(source.from))
        && Number.isFinite(Number(source.to))).map(source => `${source.chatKey || 'source'} messages ${source.from}–${source.to}`));
    const at = ranges.length ? ranges.join('; ') : 'stored source; time unspecified';
    const anchorId = item.temporalAnchorId || item.temporal?.anchorId || item.temporal?.referenceId || item.temporalAnchorIds?.join(' … ');
    const raw = `${item.title || item.topic}: ${item.detail || item.summary}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`;
    const body = anchoredRelativeText(raw, item);
    const anchor = anchorId && body === raw && !(compact && item.temporal) ? `; relative to ${anchorId}` : '';
    const timing = compact && item.temporal ? [anchoredStoryTime(item), item.temporal.certainty ? `${item.temporal.certainty} timing` : ''].filter(Boolean).join('; ') : '';
    const temporal = item.temporal ? (compact ? `; ${timing || 'time unspecified'}` : `; time evidence ${JSON.stringify(item.temporal)}`) : '';
    const certainty = item.certainty ? `; ${item.certainty}` : '';
    return `[Historical observation — ${at}${anchor}${certainty}${temporal}] ${body}`;
}

export function normalizeSupportingResult(result) {
    for (const collection of ['threads', 'backgrounds']) {
        for (const item of result?.[collection] || []) item.status = 'recorded';
    }
    return result;
}

/** Remove explicitly invalidated source contributions, including nested observations. */
export function filterSupportingSources(record, keep) {
    const history = supportingHistory(record).map(item => ({ ...item, sources: item.sources.filter(keep) }))
        .filter(item => item.sources.length);
    if (!history.length) return null;
    const current = history.find(item => supportingIdentity(item) === supportingIdentity(record)) || history.at(-1);
    const content = record.topic !== undefined ? { topic: current.title, summary: current.detail }
        : { title: current.title, detail: current.detail };
    return { ...record, ...content, participants: current.participants, certainty: current.certainty,
        temporalAnchorId: current.temporalAnchorId, temporal: current.temporal,
        temporalAnchorIds: current.temporalAnchorIds, temporalFrames: current.temporalFrames, history,
        observationSources: current.sources, sources: unique(history.flatMap(item => item.sources)) };
}
