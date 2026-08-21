export function dynamicStoryBudget(contextSize) {
    const size = Math.max(0, Number(contextSize) || 50000);
    return Math.min(6000, Math.max(1000, Math.round(size * 0.02)));
}

export function resolveStoryBudget(configuredTokens, contextSize) {
    const configured = Math.max(0, Number(configuredTokens) || 0);
    if (configured > 0) {
        return { tokens: Math.min(12000, Math.max(128, configured)), mode: 'fixed', contextSize: Number(contextSize) || null };
    }
    return { tokens: dynamicStoryBudget(contextSize), mode: 'automatic', contextSize: Number(contextSize) || 50000 };
}
