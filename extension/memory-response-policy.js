export const PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS = null;
export const GEMINI_MEMORY_RESPONSE_TOKENS = 8192;
export const SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS = 16384;

export function normalizeExtractionOutputTokens(value) {
    const requested = Math.floor(Number(value) || 0);
    return requested > 0 ? Math.min(32768, Math.max(256, requested)) : 0;
}

export function extractionResponseTokens(configured = 0, singleMessageRecovery = false) {
    const requested = normalizeExtractionOutputTokens(configured);
    if (!singleMessageRecovery) return requested || PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS;
    return Math.min(32768, Math.max(SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS, requested * 2));
}

export function memoryResponseTokens(layer) {
    if (!['digest', 'chronicle'].includes(String(layer || '').toLowerCase())) {
        throw new Error(`Unknown memory layer: ${layer}`);
    }
    return PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS;
}

export function storyResponseTokens() {
    return PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS;
}

export function resolveMemoryResponseTokens(responseLength, adapter = '') {
    if (responseLength !== null && responseLength !== undefined) return responseLength;
    return String(adapter).startsWith('gemini')
        ? GEMINI_MEMORY_RESPONSE_TOKENS
        : PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS;
}
