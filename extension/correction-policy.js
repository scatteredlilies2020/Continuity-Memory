export const DEFAULT_CORRECTION_RESPONSE_TOKENS = 8000;
export const MIN_CORRECTION_RESPONSE_TOKENS = 1000;
export const MAX_CORRECTION_RESPONSE_TOKENS = 32000;

export function resolveCorrectionResponseTokens(value) {
    const parsed = Math.round(Number(value));
    const tokens = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CORRECTION_RESPONSE_TOKENS;
    return Math.min(MAX_CORRECTION_RESPONSE_TOKENS, Math.max(MIN_CORRECTION_RESPONSE_TOKENS, tokens));
}
