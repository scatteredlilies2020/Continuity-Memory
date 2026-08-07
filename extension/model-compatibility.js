export function isGpt5Model(model = '') {
    return /(?:^|[/:\s])gpt-5(?:$|[.:-])/i.test(String(model));
}

export function isGpt56Model(model = '') {
    return /(?:^|[/:\s])gpt-5\.6(?:$|[.:-])/i.test(String(model));
}

export function outputTokenPayload(model, maxTokens) {
    if (maxTokens === null || maxTokens === undefined) return {};
    const limit = Math.max(1, Number(maxTokens) || 1);
    return isGpt5Model(model)
        ? { max_tokens: undefined, max_completion_tokens: limit }
        : { max_tokens: limit };
}

export function minimumReasoningEffort(model) {
    return isGpt56Model(model) ? 'low' : 'min';
}
