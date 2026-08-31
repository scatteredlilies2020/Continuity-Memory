export const DEFAULT_DIGEST_GROUP_SIZE = 8;
export const DIGEST_STABILITY_BUFFER_MESSAGES = 2;

export function resolveDigestGroupSize(value) {
    return Math.min(50, Math.max(2, Math.round(Number(value) || DEFAULT_DIGEST_GROUP_SIZE)));
}

export function validateDigestGroupSize(value) {
    const numeric = Number(value);
    return {
        value: resolveDigestGroupSize(value),
        valid: Number.isInteger(numeric) && numeric >= 2 && numeric <= 50,
    };
}

export function completeDigestMessageCount(count, groupSize = DEFAULT_DIGEST_GROUP_SIZE) {
    const size = resolveDigestGroupSize(groupSize);
    return Math.floor(Math.max(0, Number(count) || 0) / size) * size;
}

export function completeDigestMessages(messages, groupSize = DEFAULT_DIGEST_GROUP_SIZE) {
    const source = Array.isArray(messages) ? messages : [];
    return source.slice(0, completeDigestMessageCount(source.length, groupSize));
}

export function latestCompleteDigestMessageIndex(messages, groupSize = DEFAULT_DIGEST_GROUP_SIZE) {
    return Number(completeDigestMessages(messages, groupSize).at(-1)?.index ?? -1);
}

export function partitionDigestStabilityBuffer(messages, bufferMessages = DIGEST_STABILITY_BUFFER_MESSAGES) {
    const source = Array.isArray(messages) ? messages : [];
    const requested = Math.max(0, Math.round(Number(bufferMessages) || 0));
    const bufferedCount = Math.min(source.length, requested);
    const boundary = source.length - bufferedCount;
    return {
        extractable: source.slice(0, boundary),
        buffered: source.slice(boundary),
    };
}

export function partitionPendingDigestMessages(messages, pendingMessages, bufferMessages = DIGEST_STABILITY_BUFFER_MESSAGES) {
    const pending = Array.isArray(pendingMessages) ? pendingMessages : [];
    const stability = partitionDigestStabilityBuffer(messages, bufferMessages);
    const bufferedIndexes = new Set(stability.buffered.map(message => Number(message?.index)));
    const buffered = pending.filter(message => bufferedIndexes.has(Number(message?.index)));
    return {
        extractable: pending.filter(message => !bufferedIndexes.has(Number(message?.index))),
        buffered,
    };
}

export function isDigestStabilityProtectedMessage(allMessages, eligibleMessages, messageIndex, bufferMessages = DIGEST_STABILITY_BUFFER_MESSAGES) {
    if (messageIndex === null || messageIndex === undefined || !Number.isFinite(Number(messageIndex))) return false;
    const target = Number(messageIndex);
    const eligible = Array.isArray(eligibleMessages) ? eligibleMessages : [];
    const eligibleIndexes = new Set(eligible.map(message => Number(message?.index)));
    const buffered = partitionDigestStabilityBuffer(eligible, bufferMessages).buffered;
    return buffered.some(message => Number(message?.index) === target)
        || (Array.isArray(allMessages) && allMessages.some(message => Number(message?.index) === target && !eligibleIndexes.has(target)));
}

export function digestStabilityRepairFrom(messages, extractions, chatKey, bufferMessages = DIGEST_STABILITY_BUFFER_MESSAGES) {
    const bufferedIndexes = partitionDigestStabilityBuffer(messages, bufferMessages).buffered
        .map(message => Number(message?.index))
        .filter(Number.isFinite);
    if (!bufferedIndexes.length) return null;
    const starts = (Array.isArray(extractions) ? extractions : [])
        .filter(extraction => extraction?.chatKey === chatKey)
        .filter(extraction => {
            const from = Number(extraction?.from);
            const to = Number(extraction?.to);
            const sourceIndexes = new Set((extraction?.messageFingerprints || [])
                .map(record => Number(record?.index))
                .filter(Number.isFinite));
            return bufferedIndexes.some(index => sourceIndexes.has(index)
                || (Number.isFinite(from) && Number.isFinite(to) && index >= from && index <= to));
        })
        .map(extraction => Number(extraction?.from))
        .filter(Number.isFinite);
    return starts.length ? Math.min(...starts) : null;
}

export function selectAutomaticDigestMessages(messages, groupSize = DEFAULT_DIGEST_GROUP_SIZE, bootstrap = false) {
    const size = resolveDigestGroupSize(groupSize);
    const source = Array.isArray(messages) ? messages : [];
    const candidates = bootstrap ? source.slice(-size) : source;
    return completeDigestMessages(candidates, size);
}
