export const PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS = null;
export const GEMINI_MEMORY_RESPONSE_TOKENS = 8192;
export const SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS = 16384;

export function normalizeExtractionOutputTokens(value) {
    const requested = Math.floor(Number(value));
    return Number.isFinite(requested) && requested > 0 ? requested : 0;
}

export function extractionResponseTokens(configured = 0, singleMessageRecovery = false) {
    // The configured amount is prompt guidance. It must never become a wire
    // max_tokens cap that truncates an otherwise complete memory response.
    return PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS;
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
