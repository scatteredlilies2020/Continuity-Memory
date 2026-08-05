export function dynamicExtractionChunk(contextSize) {
    const size = Math.max(0, Number(contextSize) || 50000);
    return Math.min(8000, Math.max(1000, Math.round(size * 0.20)));
}

export function resolveExtractionChunk(configuredTokens, contextSize) {
    const configured = Math.max(0, Number(configuredTokens) || 0);
    return configured > 0
        ? Math.min(50000, Math.max(1000, configured))
        : dynamicExtractionChunk(contextSize);
}
