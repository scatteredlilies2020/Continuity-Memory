export const STORY_CHECKPOINT_INTERVAL_MESSAGES = 32;
export const MAX_STORY_CHECKPOINTS = 12;

function indexOf(message) {
    return Number(message?.index);
}

function normalizedFingerprintRecords(records, through = Number.POSITIVE_INFINITY) {
    const unique = new Map();
    for (const item of records || []) {
        const index = Number(item?.index);
        const fingerprint = String(item?.fingerprint || '');
        if (!Number.isInteger(index) || index < 0 || index > through || !fingerprint) continue;
        unique.set(index, { index, fingerprint });
    }
    return [...unique.values()].sort((left, right) => left.index - right.index);
}

export function storySourceFingerprints(messages, fingerprint, through = Number.POSITIVE_INFINITY) {
    if (typeof fingerprint !== 'function') throw new Error('Story fingerprinting requires a fingerprint function.');
    return (messages || [])
        .filter(message => Number.isInteger(indexOf(message)) && indexOf(message) >= 0 && indexOf(message) <= through)
        .map(message => ({ index: indexOf(message), fingerprint: String(fingerprint(message) || '') }))
        .filter(item => item.fingerprint)
        .sort((left, right) => left.index - right.index);
}

function normalizedCheckpoints(checkpoints) {
    return (checkpoints || [])
        .filter(item => item && String(item.text || '').trim() && Number.isFinite(Number(item.to)))
        .map(item => ({
            text: String(item.text).trim(),
            from: Number(item.from ?? 0),
            to: Number(item.to),
            updatedAt: String(item.updatedAt || ''),
            sourceMode: item.sourceMode === 'l1' ? 'l1' : 'raw',
            sourcePolicyVersion: Math.max(0, Number(item.sourcePolicyVersion) || 0),
            rebuiltFromRawChat: Boolean(item.rebuiltFromRawChat),
        }))
        .sort((left, right) => left.to - right.to)
        .filter((item, index, all) => index === all.length - 1 || item.to !== all[index + 1].to);
}

export function withStoryCheckpoint(previous, next, eligibleMessages, fingerprint, {
    interval = STORY_CHECKPOINT_INTERVAL_MESSAGES,
    maximum = MAX_STORY_CHECKPOINTS,
} = {}) {
    const through = Number(next?.to);
    if (!next || !Number.isFinite(through)) return next;
    const sourceFingerprints = storySourceFingerprints(eligibleMessages, fingerprint, through);
    const checkpoints = normalizedCheckpoints(previous?.checkpoints).filter(item => item.to < through);
    const lastCheckpointTo = Number(checkpoints.at(-1)?.to ?? Number(next.from ?? 0) - 1);
    const coveredAtLastCheckpoint = sourceFingerprints.filter(item => item.index <= lastCheckpointTo).length;
    const spacing = Math.max(1, Math.round(Number(interval) || STORY_CHECKPOINT_INTERVAL_MESSAGES));
    if (String(next.text || '').trim() && sourceFingerprints.length - coveredAtLastCheckpoint >= spacing) {
        checkpoints.push({
            text: String(next.text).trim(),
            from: Number(next.from ?? 0),
            to: through,
            updatedAt: String(next.updatedAt || ''),
            sourceMode: next.sourceMode === 'l1' ? 'l1' : 'raw',
            sourcePolicyVersion: Math.max(0, Number(next.sourcePolicyVersion) || 0),
            rebuiltFromRawChat: Boolean(next.rebuiltFromRawChat),
        });
    }
    const limit = Math.max(1, Math.round(Number(maximum) || MAX_STORY_CHECKPOINTS));
    const bounded = checkpoints.length <= limit
        ? checkpoints
        : limit === 1 ? [checkpoints.at(-1)]
            : [checkpoints[0], ...checkpoints.slice(-(limit - 1))]
            .filter((item, index, all) => index === all.findIndex(candidate => candidate.to === item.to));
    return {
        ...next,
        sourceFingerprints,
        checkpoints: bounded,
    };
}

function earliestStoryDivergence(story, messages) {
    const through = Number(story?.to);
    const stored = normalizedFingerprintRecords(story?.sourceFingerprints, through);
    if (!stored.length) return { verifiable: false, earliest: null };
    const current = new Map((messages || [])
        .map(message => [indexOf(message), String(message?.fingerprint || '')])
        .filter(([index, fingerprint]) => Number.isInteger(index) && index >= 0 && index <= through && fingerprint));
    const saved = new Map(stored.map(item => [item.index, item.fingerprint]));
    const divergent = [];
    for (const [index, fingerprint] of saved) {
        if (current.get(index) !== fingerprint) divergent.push(index);
    }
    for (const index of current.keys()) {
        if (!saved.has(index)) divergent.push(index);
    }
    return { verifiable: true, earliest: divergent.length ? Math.min(...divergent) : null };
}

export function planStoryMutationRecovery(story, messagesWithFingerprints, {
    mutationObserved = false,
    knownChangeFrom = null,
    updatedAt = new Date().toISOString(),
} = {}) {
    if (!story || (!story.text && !story.rebuildIncomplete && !story.rebuildRestartPending)) return { changed: false };
    const messages = Array.isArray(messagesWithFingerprints) ? messagesWithFingerprints : [];
    const through = Number(story.to);
    const latest = messages.length ? Math.max(...messages.map(indexOf).filter(Number.isFinite)) : -1;
    const comparison = earliestStoryDivergence(story, messages);
    let earliest = comparison.earliest;
    const hasKnownChange = knownChangeFrom !== null && knownChangeFrom !== undefined && knownChangeFrom !== '';
    const known = hasKnownChange ? Number(knownChangeFrom) : Number.NaN;
    if (Number.isFinite(known) && known <= through) earliest = earliest === null ? known : Math.min(earliest, known);
    if (!comparison.verifiable && mutationObserved) earliest = Number.isFinite(known) ? known : Number(story.from ?? 0);
    if (!comparison.verifiable && Number.isFinite(through) && through > latest) earliest = Number(story.from ?? 0);
    if (earliest === null) return { changed: false, verifiable: comparison.verifiable };
    if (!messages.length) return { changed: true, earliest, checkpointTo: null, story: null, verifiable: comparison.verifiable };

    const storedFingerprints = normalizedFingerprintRecords(story.sourceFingerprints);
    const current = new Map(messages.map(item => [indexOf(item), String(item?.fingerprint || '')]));
    const validCheckpoints = normalizedCheckpoints(story.checkpoints).filter(checkpoint => {
        if (checkpoint.to >= earliest || checkpoint.to > latest) return false;
        const covered = storedFingerprints.filter(item => item.index <= checkpoint.to);
        return covered.length > 0 && covered.every(item => current.get(item.index) === item.fingerprint);
    });
    const checkpoint = validCheckpoints.at(-1);
    if (!checkpoint) {
        const from = Number(messages[0]?.index ?? 0);
        return {
            changed: true,
            earliest,
            checkpointTo: null,
            verifiable: comparison.verifiable,
            story: {
                text: '',
                from,
                to: from - 1,
                updatedAt,
                sourceMode: story.sourceMode === 'l1' ? 'l1' : 'raw',
                sourcePolicyVersion: Math.max(0, Number(story.sourcePolicyVersion) || 0),
                rebuiltFromRawChat: story.sourceMode !== 'l1',
                rebuildIncomplete: true,
                rebuildRestartPending: true,
                rebuildTargetTo: latest,
                sourceFingerprints: [],
                checkpoints: [],
            },
        };
    }

    const incomplete = checkpoint.to < latest;
    return {
        changed: true,
        earliest,
        checkpointTo: checkpoint.to,
        verifiable: comparison.verifiable,
        story: {
            ...checkpoint,
            updatedAt,
            sourceMode: checkpoint.sourceMode === 'l1' ? 'l1' : (story.sourceMode === 'l1' ? 'l1' : 'raw'),
            sourcePolicyVersion: Math.max(0, Number(checkpoint.sourcePolicyVersion || story.sourcePolicyVersion) || 0),
            rebuiltFromRawChat: (checkpoint.sourceMode || story.sourceMode) !== 'l1',
            rebuildIncomplete: incomplete,
            rebuildRestartPending: false,
            ...(incomplete ? { rebuildTargetTo: latest } : {}),
            sourceFingerprints: storedFingerprints.filter(item => item.index <= checkpoint.to),
            checkpoints: validCheckpoints,
        },
    };
}
