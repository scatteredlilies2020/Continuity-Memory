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
const ADDRESS_BRACKET = /[\[\]]/u;
const ADDRESS_MEANINGFUL = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

export function isAddressFact(item) {
    const category = normalized(item?.category);
    const predicate = normalized(item?.predicate);
    return /^forms? of address$/u.test(category)
        || predicate.startsWith('calls ')
        || predicate.startsWith('form of address for ');
}

export function addressFactAddressee(item) {
    if (!isAddressFact(item)) return '';
    const predicate = String(item?.predicate || '').replace(/\s+/g, ' ').trim();
    const match = predicate.match(/^(?:calls|form of address for)\s+(.+?)\s*[.!?]?$/iu);
    return String(match?.[1] || '').trim();
}

function canonicalAddressName(world, value) {
    const requested = normalized(value);
    if (!requested) return '';
    const matches = (world?.entities || []).filter(entity => [entity?.name, ...(entity?.aliases || [])]
        .some(name => normalized(name) === requested));
    return normalized(matches.length === 1 ? matches[0].name : value);
}

function addressNameVariants(world, value) {
    const requested = normalized(value);
    if (!requested) return [];
    const entity = (world?.entities || []).find(item => [item?.name, ...(item?.aliases || [])]
        .some(name => normalized(name) === requested));
    return [...new Set([value, entity?.name, ...(entity?.aliases || [])]
        .map(name => String(name || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean))];
}

function escaped(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsAddressForm(text, form) {
    return normalized(text).includes(normalized(form));
}

function explicitlyAttributesSpeech(text, speakerNames, form) {
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const speechVerb = '(?:says?|said|asks?|asked|replies?|replied|calls?|called|introduces?|introduced|identifies?|identified)';
    return speakerNames.some(name => {
        const speaker = escaped(name);
        if (!speaker) return false;
        return [
            new RegExp(`(?:^|[\\n\\r])\\s*(?:[*_]{1,2})?${speaker}(?:[*_]{1,2})?\\s*:\\s*[^\\n\\r]{0,240}${formPattern}`, 'iu'),
            new RegExp(`\\b${speaker}\\b\\s+(?:\\w+\\s+){0,3}${speechVerb}\\b[^\\n\\r]{0,200}${formPattern}`, 'iu'),
            new RegExp(`${formPattern}[^\\n\\r]{0,120}\\b${speechVerb}\\s+\\b${speaker}\\b`, 'iu'),
            new RegExp(`${formPattern}[^\\n\\r]{0,120}\\b${speaker}\\b\\s+(?:\\w+\\s+){0,3}${speechVerb}\\b`, 'iu'),
            new RegExp(`\\b${speaker}\\b[^\\n\\r]{0,60}\\b(?:calls?|called|refers?|referred|introduces?|introduced|identifies?|identified)\\s+(?:herself|himself|themself|themselves)\\b[^\\n\\r]{0,160}${formPattern}`, 'iu'),
        ].some(pattern => pattern.test(text));
    });
}

function explicitlyUsesFirstPersonSelfAddress(text, form) {
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const selfVerb = '(?:say|said|call|called|refer|referred|introduce|introduced|identify|identified)';
    return [
        new RegExp(`\\bI\\b\\s+(?:\\w+\\s+){0,3}${selfVerb}\\b[^\\n\\r]{0,160}${formPattern}`, 'iu'),
        new RegExp(`${formPattern}[^\\n\\r]{0,120}\\bI\\b\\s+(?:\\w+\\s+){0,3}${selfVerb}\\b`, 'iu'),
        new RegExp(`\\b(?:call me|my name is|refer to me as|introduce myself as|identify myself as)\\b[^\\n\\r]{0,120}${formPattern}`, 'iu'),
        new RegExp(`${formPattern}[^\\n\\r]{0,120}\\b(?:me|myself|my name)\\b`, 'iu'),
    ].some(pattern => pattern.test(text));
}

export function addressFactIdentity(item, world = null) {
    const speaker = canonicalAddressName(world, item?.subject);
    const addressee = canonicalAddressName(world, addressFactAddressee(item));
    return speaker && addressee ? `${speaker}|${addressee}` : '';
}

export function isSelfAddressFact(item, world = null) {
    if (!isAddressFact(item)) return false;
    const speaker = canonicalAddressName(world, item?.subject);
    const addressee = canonicalAddressName(world, addressFactAddressee(item));
    return Boolean(speaker && speaker === addressee);
}

export function hasSelfAddressEvidence(item, messages, world = null) {
    if (!isSelfAddressFact(item, world)) return true;
    const speaker = canonicalAddressName(world, item?.subject);
    const names = addressNameVariants(world, item?.subject);
    const forms = String(item?.value || '').split(/\s*;\s*/u).map(value => value.trim()).filter(Boolean);
    if (!forms.length) return false;
    return (messages || []).some(message => {
        const text = String(message?.text ?? message?.mes ?? '');
        const presentForms = forms.filter(form => containsAddressForm(text, form));
        if (!presentForms.length) return false;
        const authoredBySpeaker = canonicalAddressName(world, message?.name) === speaker;
        return presentForms.some(form => explicitlyAttributesSpeech(text, names, form)
            || (authoredBySpeaker && explicitlyUsesFirstPersonSelfAddress(text, form)));
    });
}

export function mergeAddressValues(...values) {
    const forms = [];
    const seen = new Set();
    for (const value of values) {
        for (const raw of String(value || '').split(/\s*;\s*/u)) {
            const form = raw.replace(/\s+/g, ' ').trim().replace(/^[“”"']+|[“”"']+$/gu, '');
            const identity = normalized(form);
            if (!identity || seen.has(identity)) continue;
            seen.add(identity);
            forms.push(form);
        }
    }
    return forms.join('; ');
}

export function removeInvalidAddressFacts(container) {
    if (!Array.isArray(container?.facts)) return 0;
    let removed = 0;
    container.facts = container.facts.filter(item => {
        if (!isAddressFact(item)) return true;
        const fields = [item?.subject, item?.predicate, item?.value, addressFactAddressee(item)];
        const invalid = fields.some(value => !String(value || '').trim()
            || !ADDRESS_MEANINGFUL.test(String(value))
            || ADDRESS_PLACEHOLDER.test(String(value))
            || ADDRESS_BRACKET.test(String(value)))
            || ADDRESS_ABSENCE.test(String(item?.value || '').trim());
        if (invalid) removed++;
        return !invalid;
    });
    return removed;
}

export function removeUnsupportedSelfAddressFacts(container, messages, world = null) {
    if (!Array.isArray(container?.facts) || !Array.isArray(messages) || !messages.length) return 0;
    let removed = 0;
    container.facts = container.facts.filter(item => {
        const unsupported = isSelfAddressFact(item, world) && !hasSelfAddressEvidence(item, messages, world);
        if (unsupported) removed++;
        return !unsupported;
    });
    return removed;
}

export function removeInvalidStoredAddressFacts(world) {
    let removed = removeInvalidAddressFacts(world);
    for (const extraction of world?.extractions || []) removed += removeInvalidAddressFacts(extraction?.result);
    return removed;
}

export function reconciliationTargetIsCompatible(category, incoming, existing, world = null) {
    if (!existing) return false;
    if (category !== 'facts') return true;
    if (isAddressFact(incoming) || isAddressFact(existing)) {
        const incomingIdentity = addressFactIdentity(incoming, world);
        return Boolean(incomingIdentity && incomingIdentity === addressFactIdentity(existing, world));
    }
    const incomingPredicate = normalized(incoming?.predicate);
    const existingPredicate = normalized(existing?.predicate);
    const incomingCategory = normalized(incoming?.category);
    const existingCategory = normalized(existing?.category);
    const predicateChanged = incomingPredicate && existingPredicate && incomingPredicate !== existingPredicate;
    const categoryChanged = incomingCategory && existingCategory && incomingCategory !== existingCategory;
    return !(predicateChanged && categoryChanged);
}

export function sanitizeReconciliationMetadata(result, world, messages = null) {
    let ignored = removeInvalidAddressFacts(result);
    ignored += removeUnsupportedSelfAddressFacts(result, messages, world);
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
                && reconciliationTargetIsCompatible(category, item, recordsById.get(targetId), world);
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
