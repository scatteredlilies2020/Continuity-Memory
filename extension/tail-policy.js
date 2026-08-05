export function dynamicTailTokens(contextSize) {
    const size = Math.max(4000, Number(contextSize) || 50000);
    return Math.min(25000, Math.max(8000, Math.round(size * 0.25)));
}

export function dynamicTailTurns(contextSize) {
    const size = Math.max(4000, Number(contextSize) || 50000);
    return size <= 32000 ? 8 : size <= 64000 ? 12 : size <= 128000 ? 20 : 30;
}

export function tailPolicy(settings, contextSize, fixedPromptTokens = null) {
    const size = Math.max(4000, Number(contextSize) || 50000);
    const limitMode = settings.rawTailMode === 'turns' ? 'turns' : 'tokens';
    const configuredValue = Math.max(0, Number(settings.rawTailValue) || 0);
    const safetyTokens = Math.max(3000, Math.round(size * 0.1));
    const available = Number.isFinite(fixedPromptTokens)
        ? Math.max(1000, size - fixedPromptTokens - safetyTokens)
        : Math.max(1000, size - safetyTokens);
    const requestedTokens = limitMode === 'tokens'
        ? (configuredValue > 0 ? configuredValue : dynamicTailTokens(size))
        : available;
    const requestedTurns = limitMode === 'turns'
        ? (configuredValue > 0 ? Math.max(2, Math.round(configuredValue)) : dynamicTailTurns(size))
        : Number.MAX_SAFE_INTEGER;
    return {
        budget: Math.min(requestedTokens, available),
        maxMessages: limitMode === 'turns' ? requestedTurns * 2 : Number.MAX_SAFE_INTEGER,
        minimumMessages: 4,
        configuredTurns: limitMode === 'turns' ? requestedTurns : null,
        limitMode,
        limitValue: configuredValue,
        fixedPromptTokens: Number.isFinite(fixedPromptTokens) ? fixedPromptTokens : null,
        safetyTokens,
        measured: Number.isFinite(fixedPromptTokens),
    };
}
