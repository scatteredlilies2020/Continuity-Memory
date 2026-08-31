export const PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS = null;
export const GEMINI_MEMORY_RESPONSE_TOKENS = 8192;

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
