export const DEFAULT_STORY_BATCH_MESSAGES = 8;

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

export function rollingStoryRebuildPlan(messages, previous) {
    const source = Array.isArray(messages) ? messages : [];
    const savedTo = Number(previous?.to);
    const targetTo = Number(previous?.rebuildTargetTo);
    const resumable = Boolean(previous?.rebuildIncomplete && previous?.text)
        && Number.isFinite(savedTo)
        && Number.isFinite(targetTo)
        && savedTo < targetTo;
    if (!resumable) {
        return {
            messages: source,
            story: '',
            from: Number(source[0]?.index ?? 0),
            targetTo: Number(source.at(-1)?.index ?? 0),
            resuming: false,
        };
    }
    return {
        messages: source.filter(message => Number(message.index) > savedTo && Number(message.index) <= targetTo),
        story: String(previous.text).trim(),
        from: Number(previous.from ?? source[0]?.index ?? 0),
        targetTo,
        resuming: true,
    };
}
