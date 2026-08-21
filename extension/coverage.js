import { fingerprintMessage } from './message-digest.js?v=0.14.0-standalone.206';

export const EXTRACTION_VERSION = 57;

function ranges(indexes) {
    const result = [];
    for (const value of [...new Set(indexes)].sort((a, b) => a - b)) {
        const last = result.at(-1);
        if (last && value === last.to + 1) last.to = value;
        else result.push({ from: value, to: value });
    }
    return result;
}

export function analyzeCoverage(messages, processedMessages = []) {
    const processed = new Map(processedMessages.map(item => [Number(item.index), item]));
    const current = messages.map(message => ({ ...message, fingerprint: fingerprintMessage(message) }));
    const isCurrent = message => {
        const record = processed.get(message.index);
        return record?.fingerprint === message.fingerprint && Number(record.version) === EXTRACTION_VERSION;
    };
    const matched = current.filter(isCurrent);
    const pending = current.filter(message => !isCurrent(message));
    const outdated = pending.filter(message => {
        const record = processed.get(message.index);
        return record?.fingerprint === message.fingerprint && Number(record.version) !== EXTRACTION_VERSION;
    });
    const changed = pending.filter(message => {
        const record = processed.get(message.index);
        return record && record.fingerprint !== message.fingerprint;
    });
    const neverProcessed = pending.filter(message => !processed.has(message.index));
    return {
        total: current.length,
        latestIndex: current.at(-1)?.index ?? -1,
        processed: matched.length,
        pending: pending.length,
        changed: changed.length,
        outdated: outdated.length,
        neverProcessed: neverProcessed.length,
        pendingMessages: pending,
        pendingRanges: ranges(pending.map(message => message.index)),
    };
}

export function analyzeTailRollback(messages, processedMessages = [], extractions = [], chatKey = '') {
    const currentIndexes = new Set((messages || []).map(message => Number(message.index)).filter(Number.isFinite));
    let latestIndex = -1;
    for (const index of currentIndexes) latestIndex = Math.max(latestIndex, index);
    const removedIndexes = [...new Set((processedMessages || [])
        .map(item => Number(item?.index))
        .filter(index => Number.isFinite(index) && index > latestIndex && !currentIndexes.has(index)))]
        .sort((a, b) => a - b);
    const removedSet = new Set(removedIndexes);
    const affectedExtractions = (extractions || []).filter(item => item?.chatKey === chatKey
        && (Number(item.to) > latestIndex || (item.messageFingerprints || []).some(record => removedSet.has(Number(record.index)))));
    return {
        detected: removedIndexes.length > 0,
        latestIndex,
        removedMessages: removedIndexes.length,
        removedFrom: removedIndexes[0] ?? null,
        removedTo: removedIndexes.at(-1) ?? null,
        affectedExtractions,
    };
}

export function analyzeBranchDivergence(messages, processedMessages = [], extractions = [], chatKey = '') {
    const current = new Map((messages || []).map(message => [Number(message.index), fingerprintMessage(message)]));
    const processed = new Map((processedMessages || []).map(item => [Number(item.index), item]));
    const processedIndexes = [...processed.keys()].filter(Number.isFinite);
    const maxProcessedIndex = processedIndexes.length ? Math.max(...processedIndexes) : -1;
    const divergent = new Set();

    for (const [index, fingerprint] of current) {
        const saved = processed.get(index);
        if (saved) {
            if (String(saved.fingerprint || '') !== fingerprint || Number(saved.version) !== EXTRACTION_VERSION) divergent.add(index);
        } else if (index <= maxProcessedIndex) {
            // A previously hidden or deleted position became active inside
            // already-processed history, so the ordered suffix must be rebuilt.
            divergent.add(index);
        }
    }
    for (const index of processedIndexes) {
        if (!current.has(index)) divergent.add(index);
    }

    if (!divergent.size) return { detected: false, earliestIndex: null, repairFrom: null, affectedExtractions: [] };
    const earliestIndex = Math.min(...divergent);
    const affectedExtractions = (extractions || []).filter(item => item?.chatKey === chatKey
        && (Number(item.to) >= earliestIndex || (item.messageFingerprints || []).some(record => Number(record.index) >= earliestIndex)));
    const starts = affectedExtractions.map(item => Number(item.from)).filter(Number.isFinite);
    const repairFrom = starts.length ? Math.min(earliestIndex, ...starts) : earliestIndex;
    return {
        detected: true,
        earliestIndex,
        repairFrom,
        divergentIndexes: [...divergent].sort((a, b) => a - b),
        affectedExtractions,
    };
}
