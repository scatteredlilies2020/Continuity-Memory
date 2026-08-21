export function storyGenerationTargets(allowance) {
    const cap = Math.max(128, Number(allowance) || 1000);
    return {
        targetMinimum: Math.floor(cap * 0.68),
        targetMaximum: Math.floor(cap * 0.8),
        characterBudget: Math.floor(cap * 3),
    };
}

export function storyCompressionTarget(allowance, pass = 1) {
    const cap = Math.max(128, Number(allowance) || 1000);
    const factor = Math.max(0.5, 0.78 - (Math.max(1, Number(pass) || 1) - 1) * 0.08);
    return Math.floor(cap * factor);
}
