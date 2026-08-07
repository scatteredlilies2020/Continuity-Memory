export const PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS = null;

export function memoryResponseTokens(layer) {
    if (!['l1', 'l2', 'l3'].includes(String(layer || '').toLowerCase())) {
        throw new Error(`Unknown memory layer: ${layer}`);
    }
    return PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS;
}
