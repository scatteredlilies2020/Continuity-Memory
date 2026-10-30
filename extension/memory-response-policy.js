import { outputTokenPayload } from './model-compatibility.js';

export const PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS = null;
export const GEMINI_MEMORY_RESPONSE_TOKENS = 8192;
export const SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS = 16384;

export function normalizeExtractionOutputTokens(value) {
    const requested = Math.floor(Number(value));
    return Number.isFinite(requested) && requested > 0 ? requested : 0;
}

export function extractionResponseTokens(configured = 0, singleMessageRecovery = false, plannedCapacity = null) {
    // The configured amount is prompt guidance. It must never become a wire
    // max_tokens cap that truncates an otherwise complete memory response.
    const capacity = normalizeExtractionOutputTokens(plannedCapacity);
    return singleMessageRecovery
        ? Math.max(capacity, Math.min(65536, Math.max(SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS, capacity * 2)))
        : capacity || PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS;
}

export function extractionRecoveryRequest(request) {
    if (!request) return request;
    const current = Math.max(...['max_tokens', 'max_completion_tokens', 'maxOutputTokens']
        .map(key => normalizeExtractionOutputTokens(request[key])));
    // Recovery gets one larger request. Never lower an existing larger limit,
    // or turn a user-configured soft target into the normal request's cap.
    const tokens = Math.max(current, Math.min(65536, Math.max(SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS, current * 2)));
    const output = request.max_completion_tokens != null
        ? { max_tokens: undefined, max_completion_tokens: tokens }
        : outputTokenPayload(request.model, tokens);
    return { ...request, ...output, ...(request.maxOutputTokens != null ? { maxOutputTokens: tokens } : {}) };
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
