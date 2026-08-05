export const DEFAULT_L1_GROUP_SIZE = 8;

export function resolveL1GroupSize(value) {
    return Math.min(50, Math.max(2, Math.round(Number(value) || DEFAULT_L1_GROUP_SIZE)));
}

export function completeL1MessageCount(count, groupSize = DEFAULT_L1_GROUP_SIZE) {
    const size = resolveL1GroupSize(groupSize);
    return Math.floor(Math.max(0, Number(count) || 0) / size) * size;
}

export function completeL1Messages(messages, groupSize = DEFAULT_L1_GROUP_SIZE) {
    const source = Array.isArray(messages) ? messages : [];
    return source.slice(0, completeL1MessageCount(source.length, groupSize));
}
