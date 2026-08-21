function storySafetyScale(allowance) {
    return Math.min(1, Math.max(0, (allowance - 1500) / 4500));
}

export function storyGenerationTargets(allowance) {
    const cap = Math.max(128, Number(allowance) || 1500);
    const scale = storySafetyScale(cap);
    const minimumRatio = 0.68 + scale * 0.08;
    const maximumRatio = 0.8 + scale * 0.08;
    return {
        targetMinimum: Math.floor(cap * minimumRatio),
        targetMaximum: Math.floor(cap * maximumRatio),
        characterBudget: Math.floor(cap * (3 + scale * 0.15)),
    };
}

export function storyCompressionTarget(allowance, pass = 1) {
    const cap = Math.max(128, Number(allowance) || 1500);
    const initialFactor = 0.78 + storySafetyScale(cap) * 0.08;
    const factor = Math.max(0.5, initialFactor - (Math.max(1, Number(pass) || 1) - 1) * 0.08);
    return Math.floor(cap * factor);
}
