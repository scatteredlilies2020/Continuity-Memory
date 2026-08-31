import { partitionDigestStabilityBuffer } from './digest-policy.js';

export const DEFAULT_STORY_BATCH_MESSAGES = 8;

export function stableStoryMessages(messages) {
    return partitionDigestStabilityBuffer(Array.isArray(messages) ? messages : []).extractable;
}

export function resolveStoryBatchMessages(value) {
    const numeric = Math.round(Number(value) || DEFAULT_STORY_BATCH_MESSAGES);
    return Math.min(50, Math.max(2, numeric));
}

export function completeStoryMessages(messages, batchSize, includePartial = false) {
    const source = Array.isArray(messages) ? messages : [];
    if (includePartial) return source;
    const size = resolveStoryBatchMessages(batchSize);
    return source.slice(0, Math.floor(source.length / size) * size);
}

export function storyChunkMessageLimit(hasPriorStory, batchSize) {
    return hasPriorStory ? resolveStoryBatchMessages(batchSize) : Infinity;
}

export function rollingStoryBuildPlan(messages, previous) {
    const source = Array.isArray(messages) ? messages : [];
    const restartTargetTo = Number(previous?.rebuildTargetTo);
    if (previous?.rebuildRestartPending && Number.isFinite(restartTargetTo)) {
        return {
            messages: source.filter(message => Number(message.index) <= restartTargetTo),
            story: '',
            from: Number(source[0]?.index ?? 0),
            targetTo: restartTargetTo,
            resuming: true,
            restarting: true,
        };
    }
    const savedTo = Number(previous?.to);
    const targetTo = Number(previous?.rebuildTargetTo);
    const resumable = Boolean(previous?.rebuildIncomplete && previous?.text)
        && Number.isFinite(savedTo)
        && Number.isFinite(targetTo)
        && savedTo < targetTo;
    if (!resumable) {
        const hasStory = Boolean(previous?.text);
        return {
            messages: hasStory && Number.isFinite(savedTo)
                ? source.filter(message => Number(message.index) > savedTo)
                : source,
            story: hasStory ? String(previous.text).trim() : '',
            from: Number(previous?.from ?? source[0]?.index ?? 0),
            targetTo: Number(source.at(-1)?.index ?? 0),
            resuming: false,
            restarting: false,
        };
    }
    return {
        messages: source.filter(message => Number(message.index) > savedTo && Number(message.index) <= targetTo),
        story: String(previous.text).trim(),
        from: Number(previous.from ?? source[0]?.index ?? 0),
        targetTo,
        resuming: true,
        restarting: false,
    };
}

export function alignStoryRebuildTarget(previous, sourceMode, availableThrough) {
    const stored = Number(previous?.rebuildTargetTo);
    if (!Number.isFinite(stored) || sourceMode !== 'digest') return stored;
    const completed = Number(availableThrough);
    // Digest summaries are atomic. A mutation can regroup the repaired tail so an
    // old raw-message target lands inside a new Digest capsule; never cut it off.
    return Number.isFinite(completed) ? Math.max(stored, completed) : stored;
}

export function rollingStoryRebuildPlan(messages) {
    const source = Array.isArray(messages) ? messages : [];
    return {
        messages: source,
        story: '',
        from: Number(source[0]?.index ?? 0),
        targetTo: Number(source.at(-1)?.index ?? 0),
        resuming: false,
        restarting: true,
    };
}

export function rollingStoryRebuildCheckpoint(plan, updatedAt = new Date().toISOString()) {
    const from = Number(plan?.from ?? 0);
    return {
        text: '',
        from,
        to: from - 1,
        updatedAt,
        rebuiltFromRawChat: true,
        rebuildIncomplete: true,
        rebuildRestartPending: true,
        rebuildTargetTo: Number(plan?.targetTo ?? from - 1),
    };
}

export function rollingStoryCoverage(story, eligibleMessages) {
    const messages = Array.isArray(eligibleMessages) ? eligibleMessages : [];
    const rawThrough = story?.to;
    const through = rawThrough === undefined || rawThrough === null || rawThrough === '' ? Number.NaN : Number(rawThrough);
    const pending = Number.isFinite(through)
        ? messages.filter(message => Number(message?.index) > through).length
        : messages.length;
    return {
        through: Number.isFinite(through) ? through : -1,
        pending,
        current: Boolean(story?.text) && !story?.rebuildIncomplete && !story?.rebuildRestartPending && pending === 0,
    };
}
