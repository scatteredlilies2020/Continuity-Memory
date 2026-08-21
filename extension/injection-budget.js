export function dynamicInjectionBudget(contextSize) {
    const size = Math.max(0, Number(contextSize) || 50000);
    return Math.round(size * 0.20);
}

export function resolveInjectionBudget(configuredTokens, contextSize) {
    const configured = Math.max(0, Number(configuredTokens) || 0);
    if (configured > 0) {
        return { tokens: Math.min(100000, Math.max(128, configured)), mode: 'fixed', contextSize: Number(contextSize) || null };
    }
    return { tokens: dynamicInjectionBudget(contextSize), mode: 'dynamic', contextSize: Number(contextSize) || 50000 };
}
