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
