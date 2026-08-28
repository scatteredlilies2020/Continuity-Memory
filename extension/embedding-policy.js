export const MINIMUM_EMBEDDING_COVERAGE = 1;

export function embeddingCoverage(indexed, total) {
    const available = Math.max(0, Number(indexed) || 0);
    const expected = Math.max(0, Number(total) || 0);
    return expected > 0 ? Math.min(1, available / expected) : 0;
}

export function embeddingCoverageReady(indexed, total, minimum = MINIMUM_EMBEDDING_COVERAGE) {
    const threshold = Math.min(1, Math.max(0, Number(minimum) || 0));
    return Number(total) > 0 && embeddingCoverage(indexed, total) >= threshold;
}
