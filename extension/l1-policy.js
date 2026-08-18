export const DEFAULT_L1_GROUP_SIZE = 8;
export const L1_STABILITY_BUFFER_MESSAGES = 2;

export function resolveL1GroupSize(value) {
    return Math.min(50, Math.max(2, Math.round(Number(value) || DEFAULT_L1_GROUP_SIZE)));
}

export function validateL1GroupSize(value) {
    const numeric = Number(value);
    return {
        value: resolveL1GroupSize(value),
        valid: Number.isInteger(numeric) && numeric >= 2 && numeric <= 50,
    };
}

export function completeL1MessageCount(count, groupSize = DEFAULT_L1_GROUP_SIZE) {
    const size = resolveL1GroupSize(groupSize);
    return Math.floor(Math.max(0, Number(count) || 0) / size) * size;
}

export function completeL1Messages(messages, groupSize = DEFAULT_L1_GROUP_SIZE) {
    const source = Array.isArray(messages) ? messages : [];
    return source.slice(0, completeL1MessageCount(source.length, groupSize));
}

export function latestCompleteL1MessageIndex(messages, groupSize = DEFAULT_L1_GROUP_SIZE) {
    return Number(completeL1Messages(messages, groupSize).at(-1)?.index ?? -1);
}

export function partitionL1StabilityBuffer(messages, bufferMessages = L1_STABILITY_BUFFER_MESSAGES) {
    const source = Array.isArray(messages) ? messages : [];
    const requested = Math.max(0, Math.round(Number(bufferMessages) || 0));
    const bufferedCount = Math.min(source.length, requested);
    const boundary = source.length - bufferedCount;
    return {
        extractable: source.slice(0, boundary),
        buffered: source.slice(boundary),
    };
}

export function partitionPendingL1Messages(messages, pendingMessages, bufferMessages = L1_STABILITY_BUFFER_MESSAGES) {
    const pending = Array.isArray(pendingMessages) ? pendingMessages : [];
    const stability = partitionL1StabilityBuffer(messages, bufferMessages);
    const bufferedIndexes = new Set(stability.buffered.map(message => Number(message?.index)));
    const buffered = pending.filter(message => bufferedIndexes.has(Number(message?.index)));
    return {
        extractable: pending.filter(message => !bufferedIndexes.has(Number(message?.index))),
        buffered,
    };
}

export function isL1StabilityProtectedMessage(allMessages, eligibleMessages, messageIndex, bufferMessages = L1_STABILITY_BUFFER_MESSAGES) {
    if (messageIndex === null || messageIndex === undefined || !Number.isFinite(Number(messageIndex))) return false;
    const target = Number(messageIndex);
    const eligible = Array.isArray(eligibleMessages) ? eligibleMessages : [];
    const eligibleIndexes = new Set(eligible.map(message => Number(message?.index)));
    const buffered = partitionL1StabilityBuffer(eligible, bufferMessages).buffered;
    return buffered.some(message => Number(message?.index) === target)
        || (Array.isArray(allMessages) && allMessages.some(message => Number(message?.index) === target && !eligibleIndexes.has(target)));
}

export function l1StabilityRepairFrom(messages, extractions, chatKey, bufferMessages = L1_STABILITY_BUFFER_MESSAGES) {
    const bufferedIndexes = partitionL1StabilityBuffer(messages, bufferMessages).buffered
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

export function selectAutomaticL1Messages(messages, groupSize = DEFAULT_L1_GROUP_SIZE, bootstrap = false) {
    const size = resolveL1GroupSize(groupSize);
    const source = Array.isArray(messages) ? messages : [];
    const candidates = bootstrap ? source.slice(-size) : source;
    return completeL1Messages(candidates, size);
}
