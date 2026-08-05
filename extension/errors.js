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
