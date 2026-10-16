import { errorChainText } from './errors.js?v=0.15.0-testing.30';

export function isRetryableEmbeddingError(error) {
    if (error?.code === 'CONTINUITY_VECTOR_REQUEST_TIMEOUT') return true;
    const detail = errorChainText(error);
    if (/\b(?:400|401|403|404|413|422)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|incorrect (?:api )?key|no api key|dimensions? (?:do not |mis)match|invalid vector|invalid continuity memory vector store|invalid vector item/iu.test(detail)) return false;
    // The server wraps upstream failures in HTTP 500. Do not retry every 500:
    // invalid stores, bad responses, and configuration errors need attention.
    return /\b(?:408|425|429|502|503|504|520|521|522|523|524)\b|bad gateway|gateway timeout|service unavailable|temporarily unavailable|too many requests|rate[ _-]?limit|econnreset|econnrefused|enotfound|connection (?:closed|reset)|socket hang up|fetch failed|failed to fetch|network error|load failed|timed? ?out|timeout/iu.test(detail);
}

export function embeddingRetryDelay(attempt) {
    return Math.min(60000, 10000 * (2 ** Math.min(3, Math.max(0, Number(attempt) - 1) || 0)));
}
