function normalizedPrompt(value) {
    return String(value || '').replace(/\r\n?/gu, '\n').trim();
}

export function retainLatestPromptRule(prompt, canonicalRule, supersededRules = [], ruleStarts = []) {
    const canonical = normalizedPrompt(canonicalRule);
    let compacted = normalizedPrompt(prompt);
    if (!canonical) return compacted;
    const knownRules = [...new Set([canonical, ...supersededRules.map(normalizedPrompt)].filter(Boolean))]
        .sort((left, right) => right.length - left.length);
    for (const rule of knownRules) compacted = compacted.split(rule).join('\n');
    const starts = ruleStarts.map(normalizedPrompt).filter(Boolean);
    if (starts.length) {
        compacted = compacted.split('\n')
            .filter(line => !starts.some(start => line.trimStart().startsWith(start)))
            .join('\n');
    }
    compacted = compacted
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
    return `${compacted}${compacted ? '\n' : ''}${canonical}`;
}
