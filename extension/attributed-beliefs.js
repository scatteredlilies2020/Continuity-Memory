export const CHARACTER_BELIEF_CATEGORY = 'character belief';
export const FORMER_CHARACTER_BELIEF_CATEGORY = 'former character belief';

function clean(value, fallback = '') {
    return String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;
}

function normalized(value) {
    return clean(value).toLocaleLowerCase();
}

function beliefPredicate(item) {
    const subject = clean(item?.subject, 'unspecified subject');
    const proposition = clean(item?.predicate, 'claim');
    return `belief about ${subject} — ${proposition}`;
}

function beliefValue(item) {
    const value = clean(item?.value, 'unspecified belief');
    const qualifiers = [];
    const confidence = clean(item?.confidence);
    const status = clean(item?.status);
    const truthStatus = clean(item?.truthStatus);
    if (confidence && confidence !== 'likely') qualifiers.push(`holder confidence: ${confidence}`);
    if (status && status !== 'held') qualifiers.push(`holder status: ${status}`);
    if (truthStatus && truthStatus !== 'unknown') qualifiers.push(`established canon: ${truthStatus}`);
    return qualifiers.length ? `${value} [${qualifiers.join('; ')}]` : value;
}

export function isAttributedBeliefFact(item) {
    const category = normalized(item?.category);
    return category === CHARACTER_BELIEF_CATEGORY
        || category === FORMER_CHARACTER_BELIEF_CATEGORY
        || normalized(item?.predicate).startsWith('belief about ');
}

export function legacyBeliefToFact(item = {}) {
    const status = clean(item.status);
    const fact = {
        ...item,
        subject: clean(item.holder, 'Unknown holder'),
        predicate: beliefPredicate(item),
        value: beliefValue(item),
        category: status === 'rejected' ? FORMER_CHARACTER_BELIEF_CATEGORY : CHARACTER_BELIEF_CATEGORY,
        persistence: 'persistent',
    };
    delete fact.holder;
    delete fact.confidence;
    delete fact.status;
    delete fact.truthStatus;
    return fact;
}

function publicLegacyFact(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const fact = legacyBeliefToFact(item);
    delete fact.id;
    delete fact.sources;
    delete fact.createdAt;
    delete fact.updatedAt;
    delete fact.holder;
    delete fact.confidence;
    delete fact.status;
    delete fact.truthStatus;
    return fact;
}

function factSelector(item) {
    const fact = legacyBeliefToFact(item);
    return `${normalized(fact.subject)}|${normalized(fact.predicate)}`;
}

function migrateResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return 0;
    result.facts = Array.isArray(result.facts) ? result.facts : [];
    const beliefs = Array.isArray(result.beliefs) ? result.beliefs : [];
    const identities = new Set(result.facts.map(item => `${normalized(item?.subject)}|${normalized(item?.predicate)}`));
    let migrated = 0;
    for (const belief of beliefs) {
        const fact = legacyBeliefToFact(belief);
        const identity = `${normalized(fact.subject)}|${normalized(fact.predicate)}`;
        if (identities.has(identity)) continue;
        result.facts.push(fact);
        identities.add(identity);
        migrated++;
    }
    delete result.beliefs;
    for (const merge of result.recordMerges || []) {
        if (merge?.category === 'beliefs') merge.category = 'facts';
    }
    return migrated;
}

/**
 * Converts the short-lived standalone.80-.82 beliefs collection into ordinary
 * attributed facts. The conversion is idempotent and mutates the supplied
 * world so callers can use it before saving without another clone.
 */
export function migrateLegacyBeliefs(world) {
    if (!world || typeof world !== 'object' || Array.isArray(world)) return 0;
    world.facts = Array.isArray(world.facts) ? world.facts : [];
    const beliefs = Array.isArray(world.beliefs) ? world.beliefs : [];
    const identities = new Set(world.facts.map(item => `${normalized(item?.subject)}|${normalized(item?.predicate)}`));
    const ids = new Set(world.facts.map(item => clean(item?.id)).filter(Boolean));
    let migrated = 0;
    for (const belief of beliefs) {
        const fact = legacyBeliefToFact(belief);
        const identity = `${normalized(fact.subject)}|${normalized(fact.predicate)}`;
        if (identities.has(identity)) continue;
        if (fact.id && ids.has(fact.id)) fact.id = `legacy_${fact.id}`.slice(0, 200);
        world.facts.push(fact);
        identities.add(identity);
        if (fact.id) ids.add(fact.id);
        migrated++;
    }
    delete world.beliefs;

    for (const extraction of world.extractions || []) migrated += migrateResult(extraction?.result);
    for (const correction of world.corrections || []) {
        for (const operation of correction?.operations || []) {
            if (operation?.category !== 'beliefs') continue;
            const selectorSource = operation.before || operation.after || operation.replacement;
            operation.category = 'facts';
            if (operation.before) operation.before = publicLegacyFact(operation.before);
            if (operation.after) operation.after = publicLegacyFact(operation.after);
            if (operation.replacement) operation.replacement = publicLegacyFact(operation.replacement);
            operation.beforeSelector = selectorSource ? factSelector(selectorSource) : '';
        }
    }
    return migrated;
}
