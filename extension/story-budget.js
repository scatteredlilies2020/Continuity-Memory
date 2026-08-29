export function dynamicStoryBudget(contextSize) {
    const size = Math.max(0, Number(contextSize) || 50000);
    return Math.min(100000, Math.max(1500, Math.round(size * 0.20)));
}

export function resolveStoryBudget(configuredTokens, contextSize) {
    const configured = Math.max(0, Number(configuredTokens) || 0);
    if (configured > 0) {
        return { tokens: Math.min(100000, Math.max(128, configured)), mode: 'fixed', contextSize: Number(contextSize) || null };
    }
    return { tokens: dynamicStoryBudget(contextSize), mode: 'automatic', contextSize: Number(contextSize) || 50000 };
}

export function storyWithinAllowance(tokenCount, outputAllowance) {
    const count = Math.max(0, Number(tokenCount) || 0);
    const allowance = Math.max(128, Number(outputAllowance) || 1500);
    return count <= allowance;
}

export function dynamicStorySourceChunk(contextSize, outputAllowance = null, includesPriorStory = true) {
    const size = Math.max(0, Number(contextSize) || 50000);
    const output = Math.max(128, Number(outputAllowance) || dynamicStoryBudget(size));
    const prior = includesPriorStory ? output : 0;
    const promptReserve = 2048;
    return Math.max(128, Math.floor(size - output - prior - promptReserve));
}

export function dynamicStoryRefineSourceChunk(contextSize, outputAllowance = null) {
    const size = Math.max(0, Number(contextSize) || 50000);
    const output = Math.max(128, Number(outputAllowance) || dynamicStoryBudget(size));
    const promptReserve = 2048;
    return Math.max(128, Math.floor(size - (output * 3) - promptReserve));
}
