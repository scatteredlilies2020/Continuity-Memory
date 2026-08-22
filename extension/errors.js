export function errorChainText(error) {
    const parts = [];
    const seen = new Set();
    let current = error;
    while (current && !seen.has(current) && parts.length < 8) {
        seen.add(current);
        if (current.status) parts.push(String(current.status));
        if (current.message) parts.push(String(current.message));
        else if (typeof current === 'string') parts.push(current);
        current = current.cause;
    }
    return parts.join(' · ');
}

export function isRateLimitError(error) {
    return /\b429\b|too many requests|rate[ _-]?limit|another request in the queue|requests? in[- ]flight/i.test(errorChainText(error));
}

export function isTransientApiError(error) {
    const message = errorChainText(error);
    if (isRateLimitError(error)) return true;
    if (/\b(?:408|425|500|502|503|504|520|521|522|523|524)\b/.test(message)) return true;
    return /bad gateway|gateway timeout|aborted|connection (?:closed|reset)|econnreset|econnrefused|enotfound|fetch failed|failed to fetch|network error|socket hang up|temporarily unavailable|timed? ?out|timeout/i.test(message);
}
