export const TARGET_RECORD_CATEGORIES = Object.freeze(['entities', 'facts', 'states', 'relationships', 'threads', 'backgrounds']);

export function canonicalFactReference(item) {
    return {
        targetId: item?.id,
        subject: item?.subject,
        predicate: item?.predicate,
        category: item?.category,
        persistence: item?.persistence,
        value: String(item?.value || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    };
}

function normalized(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

const ADDRESS_PLACEHOLDER = /(?:\[\s*(?:canonical\s+)?(?:speaker|addressee)(?:\s+unavailable)?\s*\]|canonical\s+addressee|actual[_\s-]+canonical[_\s-]+name)/iu;
const ADDRESS_ABSENCE = /^(?:\[\s*)?(?:addressee\s+)?(?:unavailable|not established|none|n\/a|no (?:direct )?address(?: is)? established)(?:\s*\])?$/iu;

function isAddressFact(item) {
    const category = normalized(item?.category);
    const predicate = normalized(item?.predicate);
    return category === 'form of address' || predicate.startsWith('calls ');
}

export function removeInvalidAddressFacts(container) {
    if (!Array.isArray(container?.facts)) return 0;
    let removed = 0;
    container.facts = container.facts.filter(item => {
        if (!isAddressFact(item)) return true;
        const fields = [item?.subject, item?.predicate, item?.value];
        const invalid = fields.some(value => !String(value || '').trim() || ADDRESS_PLACEHOLDER.test(String(value)))
            || ADDRESS_ABSENCE.test(String(item?.value || '').trim());
        if (invalid) removed++;
        return !invalid;
    });
    return removed;
}

export function reconciliationTargetIsCompatible(category, incoming, existing) {
    if (!existing) return false;
    if (category !== 'facts') return true;
    const incomingPredicate = normalized(incoming?.predicate);
    const existingPredicate = normalized(existing?.predicate);
    const incomingCategory = normalized(incoming?.category);
    const existingCategory = normalized(existing?.category);
    const predicateChanged = incomingPredicate && existingPredicate && incomingPredicate !== existingPredicate;
    const categoryChanged = incomingCategory && existingCategory && incomingCategory !== existingCategory;
    return !(predicateChanged && categoryChanged);
}

export function sanitizeReconciliationMetadata(result, world) {
    let ignored = removeInvalidAddressFacts(result);
    if (!Array.isArray(result.identityResolutions)) {
        result.identityResolutions = [];
        ignored++;
    }
    if (!Array.isArray(result.recordMerges)) {
        result.recordMerges = [];
        ignored++;
    }

    for (const category of TARGET_RECORD_CATEGORIES) {
        const recordsById = new Map((world?.[category] || [])
            .map(item => [String(item.id || ''), item])
            .filter(([itemId]) => itemId));
        for (const item of result[category] || []) {
            if (!item || typeof item !== 'object') continue;
            const targetId = String(item.targetId || '').trim();
            const compatible = targetId
                && reconciliationTargetIsCompatible(category, item, recordsById.get(targetId));
            if (targetId && !compatible) ignored++;
            item.targetId = compatible ? targetId : '';
        }
    }

    result.recordMerges = result.recordMerges.filter(merge => {
        const category = String(merge?.category || '');
        const allowedCategory = ['facts', 'states', 'relationships', 'threads', 'backgrounds'].includes(category);
        const records = allowedCategory && Array.isArray(world?.[category]) ? world[category] : [];
        const validIds = new Set(records.map(item => String(item.id || '')).filter(Boolean));
        const canonicalId = String(merge?.canonicalId || '').trim();
        const duplicateIds = [...new Set((merge?.duplicateIds || []).map(value => String(value || '').trim()).filter(Boolean))];
        const valid = allowedCategory
            && Boolean(String(merge?.evidence || '').trim())
            && validIds.has(canonicalId)
            && duplicateIds.length > 0
            && !duplicateIds.includes(canonicalId)
            && duplicateIds.every(itemId => validIds.has(itemId));
        if (!valid) ignored++;
        else merge.duplicateIds = duplicateIds;
        return valid;
    });
    return { ignored };
}
