function normalizeListField(value, key, label) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return [String(value).trim()].filter(Boolean);
    }
    throw new Error(`${label} field "${key}" is not an array.`);
}

// Structured-output support is not uniform across providers. Preserve a useful
// scalar answer when a provider ignores the array portion of the schema, while
// continuing to reject ambiguous object-shaped output instead of saving it.
export function normalizeHierarchyResult(result, label = 'L2') {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(`${label} summarizer returned no JSON object.`);
    }
    const normalized = { ...result };
    for (const key of ['participants', 'turningPoints', 'openThreads']) {
        normalized[key] = normalizeListField(result[key], key, label);
    }
    if (!String(normalized.summary || '').trim()) throw new Error(`${label} summarizer returned no summary.`);
    return normalized;
}
