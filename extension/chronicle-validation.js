// A minimum structural safeguard, not a semantic quality or length target.
// Count Unicode letters/numbers so punctuation cannot disguise a single letter.
export function hasChronicleNarrative(value) {
    return typeof value === 'string' && (value.match(/[\p{L}\p{N}]/gu) || []).length >= 2;
}

export function assertChronicleNarrative(value, field = 'Chronicle summary', code = 'CM_INCOMPLETE_CHRONICLE') {
    if (!hasChronicleNarrative(value)) {
        throw Object.assign(new Error(`${field} must contain source-supported complete prose, not a single letter, punctuation, or blank placeholder. Regenerate from the sources; do not pad the entry. Source memory was kept.`), { code });
    }
}

// Protect server saves from stale clients as well as current generators. Existing
// corrupt records may be carried unchanged while unrelated memory is edited.
export function assertChronicleChanges(input, previous = {}) {
    for (const category of ['chronicle', 'capsules']) {
        const prior = new Map((previous[category] || []).map(record => [record.id, record]));
        for (const record of input[category] || []) {
            const before = prior.get(record.id);
            if (category === 'chronicle' && !before) assertChronicleNarrative(record.text ?? record.summary);
            const fields = category === 'capsules' ? ['chronicleText'] : ['text', 'summary'];
            for (const field of fields) {
                if (!Object.hasOwn(record, field) || (before && record[field] === before[field])) continue;
                // Empty Digest summaries explicitly select the source-prose fallback.
                if (category === 'capsules' && record[field] === '') continue;
                assertChronicleNarrative(record[field], `${category}.${field}`);
            }
        }
    }
}
