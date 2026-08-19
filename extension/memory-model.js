import { EXTRACTION_VERSION } from './coverage.js';
import { isSuppressedByCorrection } from './memory-correction.js';
import { addressFactAddressee, addressFactIdentity, enrichEntityDescriptionsFromEstablishedFacts, entityIsPersonLike, entityTypesAreCompatible, isAddressFact, mergeAddressValues, normalizeKnowledgePredicateTaxonomy, normalizeRelationalKnowledgeTopics, reconcileGenericAddressDuplicates, reconciliationMergeIsCompatible, reconciliationTargetIsCompatible, reconciliationTargetWasRejected, recoverRelationshipBackedEntityDescriptions, relationshipPairIdentity, removeInvalidAddressFacts } from './reconciliation-policy.js';
import { canonicalMemorySubject, canonicalStateAttribute, stateIdentity, stateScope } from './state-lifecycle.js';
import { buildL1TemporalAnchor, buildRelativeTemporalAnchor } from './temporal-anchors.js';
import { randomUuid } from './uuid.js';
import { migrateLegacyBeliefs } from './attributed-beliefs.js';

function text(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clipped(value, max) {
    const result = text(value);
    return result.length <= max ? result : `${result.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function key(value) {
    return text(value).toLocaleLowerCase();
}

function knowledgeBoundaryContradictedBy(negativeValue, positiveValue, predicate = '') {
    const comparisonStop = new Set(['accepted', 'former', 'previous', 'prior', 'earlier', 'later', 'about', 'their', 'there', 'these', 'those', 'council']);
    const negativeClauses = text(negativeValue).split(/(?<=[.!?;])\s+/u).filter(value => KNOWLEDGE_NEGATION.test(value));
    const positiveTerms = new Set((text(positiveValue).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(value => value.length >= 4 && !comparisonStop.has(value)));
    return negativeClauses.some(clause => {
        const clauseTerms = new Set((clause.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(value => value.length >= 4 && !comparisonStop.has(value)));
        if ([...clauseTerms].filter(term => positiveTerms.has(term)).length >= 2) return true;
        if (/\bno answer (?:has|had|was)?\s*(?:yet )?(?:been )?(?:given|provided|established|disclosed)?\b/iu.test(clause)
            && hasEstablishedKnowledgeClause(positiveValue)) return true;
        const matchingConcept = [
            /\b(?:apprentice|student|padawan)\b/iu,
            /\b(?:identity|identifies|identified|true name|real name|name)\b/iu,
            /\b(?:location|destination)\b/iu,
            /\bparent\b/iu, /\bchild\b/iu, /\bspouse\b/iu,
        ].some(pattern => pattern.test(clause) && pattern.test(positiveValue));
        if (matchingConcept) return true;
        const negativeCouncilMembership = /\bcouncil\b/iu.test(clause) && /\b(?:seat|member|membership|served on|was in)\b/iu.test(clause);
        const positiveCouncilMembership = /\bcouncil\b/iu.test(positiveValue) && /\b(?:seat|member|membership|served on|was in)\b/iu.test(positiveValue);
        if (negativeCouncilMembership && positiveCouncilMembership) return true;
        // When both records use the exact same explicitly identity-scoped
        // predicate, established positive knowledge answers the old unknown-
        // identity boundary even if the value phrases the answer through the
        // person's canonical name and biography rather than the word
        // “identity” again.
        return /\b(?:identity|true name|real name)\b/iu.test(text(predicate))
            && hasEstablishedKnowledgeClause(positiveValue);
    });
}

function hasEstablishedKnowledgeClause(value) {
    return text(value).split(/(?<=[.!?;])\s+/u).some(clause => {
        if (KNOWLEDGE_NEGATION.test(clause)) return false;
        return /\b(?:knows?|aware|has learned|learned|discovers?|discovered|recognizes?|recognized|identifies?|identified|confirms?|confirmed|understands?|understood|remembers?|remembered|recalls?|recalled)\b/iu.test(clause)
            && !/\b(?:suspects?|believes?|thinks?|may|might|possibly|perhaps|unverified|without (?:proof|evidence))\b/iu.test(clause);
    });
}

function additiveKnowledgeValue(existing, incoming) {
    const next = text(incoming?.value);
    const prior = text(existing?.value);
    if (!prior || !next) return next || prior;
    const predicate = key(incoming?.predicate || existing?.predicate);
    const incomingCategory = key(incoming?.category);
    const existingCategory = key(existing?.category);
    if (!predicate.startsWith('knowledge of ')
        || incomingCategory !== 'knowledge'
        || existingCategory !== 'knowledge') return next;
    // Explicit epistemic transitions replace the prior boundary; positive
    // knowledge acquired at different times is additive and must not erase
    // older durable details merely because the extractor reused a broad
    // “knowledge of X” predicate.
    const priorHasNegativeBoundary = KNOWLEDGE_NEGATION.test(prior);
    const nextHasNegativeBoundary = KNOWLEDGE_NEGATION.test(next);
    // A single record can establish one subtopic while retaining an explicit
    // gap about another. Judge positive knowledge clause-by-clause so the
    // remaining gap does not prevent a newly established detail from retiring
    // an older, now-stale boundary.
    const priorEstablishesCurrentKnowledge = hasEstablishedKnowledgeClause(prior);
    const nextEstablishesCurrentKnowledge = hasEstablishedKnowledgeClause(next);
    if (/\b(?:no longer|mistaken|wrong|retracted|disproved)\b/iu.test(next)) return next;
    // Ordinary “did not know” prose is historical once the same canonical
    // knowledge topic also has a positive current record. This is deliberately
    // symmetric because duplicate recovery order is not chronology.
    if (nextHasNegativeBoundary && priorEstablishesCurrentKnowledge && knowledgeBoundaryContradictedBy(next, prior, predicate)) return prior;
    if (priorHasNegativeBoundary && nextEstablishesCurrentKnowledge && knowledgeBoundaryContradictedBy(prior, next, predicate)) return next;
    const sentences = value => text(value).split(/(?<=[.!?;])\s+/u).map(text).filter(Boolean);
    const combined = [];
    for (const sentence of [...sentences(prior), ...sentences(next)]) {
        const identity = key(sentence).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (!identity || combined.some(item => {
            const other = key(item).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            return other === identity || other.includes(identity) || identity.includes(other);
        })) continue;
        combined.push(sentence);
    }
    return text(combined.join(' ')).slice(0, 1600);
}

function reconcileCanonicalKnowledgeFacts(world) {
    normalizeKnowledgePredicateTaxonomy({
        entities: world.entities,
        facts: world.facts,
        relationships: world.relationships,
    }, world);
    normalizeRelationalKnowledgeTopics({
        entities: world.entities,
        facts: world.facts,
        relationships: world.relationships,
    }, world);
    const canonical = new Map();
    const retained = [];
    for (const fact of world.facts || []) {
        if (fact?.correctionId || key(fact?.category) !== 'knowledge') {
            retained.push(fact);
            continue;
        }
        const identity = `${key(canonicalMemorySubject(world, fact?.subject))}|${key(fact?.predicate)}|knowledge`;
        const prior = canonical.get(identity);
        if (!prior) {
            canonical.set(identity, fact);
            retained.push(fact);
            continue;
        }
        prior.value = additiveKnowledgeValue(prior, fact);
        prior.importance = Math.max(clampImportance(prior.importance), clampImportance(fact.importance));
        prior.updatedAt = [prior.updatedAt, fact.updatedAt].filter(Boolean).sort().at(-1) || prior.updatedAt;
        prior.sources = mergedSources(prior.sources || [], fact.sources || []);
        if (fact.temporalAnchorId) prior.temporalAnchorId = fact.temporalAnchorId;
    }
    world.facts = retained;
}

function escaped(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function id(prefix) {
    return `${prefix}_${randomUuid()}`;
}

function sourceRef(meta) {
    return {
        chatKey: meta.chatKey,
        from: meta.from,
        to: meta.to,
        capturedAt: new Date().toISOString(),
    };
}

function common(item, meta, prefix) {
    return {
        ...item,
        id: item.id || id(prefix),
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: mergedSources(Array.isArray(item.sources) ? item.sources : [], [sourceRef(meta)]),
    };
}

function shouldPreserveHistoricalRecord(item, meta) {
    if (meta.allowStateUpdates !== false) return false;
    const sources = (item.sources || []).filter(source => source?.chatKey);
    if (sources.some(source => source.chatKey !== meta.chatKey)) return true;
    const sameChatEnds = sources
        .filter(source => source.chatKey === meta.chatKey)
        .map(source => Number(source.to))
        .filter(Number.isFinite);
    const incomingEnd = Number(meta.to);
    return !sameChatEnds.length || !Number.isFinite(incomingEnd) || incomingEnd < Math.max(...sameChatEnds);
}

function mergeArray(world, collection, target, incoming, identity, meta, prefix, combine, preserveExisting = false, reconciliationResult = null) {
    for (const raw of incoming || []) {
        if (!raw || typeof raw !== 'object') continue;
        if (reconciliationTargetWasRejected(raw)) continue;
        let requestedTargetId = text(raw.targetId);
        let requestedIndex = requestedTargetId ? target.findIndex(item => item.id === requestedTargetId) : -1;
        const missingUntrustedTarget = requestedIndex < 0 && !meta.replayStoredExtraction;
        if (requestedTargetId && requestedIndex >= 0
            && !reconciliationTargetIsCompatible(collection, raw, target[requestedIndex], world, reconciliationResult)) {
            raw.targetId = '';
            continue;
        }
        if (requestedTargetId && missingUntrustedTarget) {
            requestedTargetId = '';
            requestedIndex = -1;
            raw.targetId = '';
        }
        const requestedTarget = requestedIndex >= 0 ? target[requestedIndex] : null;
        const normalized = combine ? combine(raw, requestedTarget) : raw;
        if (isSuppressedByCorrection(world, collection, normalized, meta)) continue;
        const identityKey = identity(normalized);
        if (!identityKey) continue;
        const index = requestedIndex >= 0 ? requestedIndex : target.findIndex(item => identity(item) === identityKey);
        if (index >= 0) {
            // A model can emit an object with the same name as a person (or
            // vice versa). Failing closed is safer than overwriting the durable
            // entity identity and confusing every downstream reference.
            if (collection === 'entities' && !entityTypesAreCompatible(normalized.type, target[index].type)) {
                raw.targetId = '';
                continue;
            }
            const preserve = typeof preserveExisting === 'function'
                ? preserveExisting(target[index], normalized)
                : preserveExisting;
            const merged = preserve || target[index].correctionId
                ? { ...normalized, ...target[index] }
                : { ...target[index], ...normalized };
            if (collection === 'entities') {
                merged.aliases = safeEntityAliases(
                    merged.name,
                    merged.type,
                    [...(target[index].aliases || []), ...(normalized.aliases || [])],
                );
            }
            if (collection === 'facts'
                && !target[index].correctionId
                && (isAddressFact(target[index]) || isAddressFact(normalized))) {
                merged.value = mergeAddressValues(target[index].value, normalized.value);
            }
            if (collection === 'threads' || collection === 'backgrounds') merged.participants = cleanList([...(target[index].participants || []), ...(normalized.participants || [])]);
            target[index] = common({ ...merged, id: target[index].id, createdAt: target[index].createdAt }, meta, prefix);
            raw.targetId = target[index].id;
        } else {
            const created = common({ ...normalized, ...(requestedTargetId ? { id: requestedTargetId } : {}) }, meta, prefix);
            target.push(created);
            raw.targetId = created.id;
        }
    }
}

function cleanList(value, max = 30) {
    return [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))].slice(0, max);
}

const GENERIC_PERSON_ALIAS_TOKENS = new Set([
    'a', 'an', 'the', 'personal', 'senior', 'junior', 'former', 'dead', 'deceased', 'young', 'old',
    'sith', 'jedi', 'lord', 'lady', 'master', 'apprentice', 'padawan', 'captor', 'captive', 'retainer',
    'attendant', 'keeper', 'officer', 'pilot', 'commander', 'instructor', 'steward', 'servant', 'guard',
    'trooper', 'chief', 'seneschal', 'handler', 'prisoner', 'mentor', 'student', 'teacher',
]);

function safeEntityAliases(name, type, aliases) {
    const canonicalTokens = new Set(identityNameTokens(name));
    return cleanList(aliases).filter(alias => {
        if (key(alias) === key(name)) return false;
        if (!entityIsPersonLike(type)) return true;
        const possessive = alias.search(/['’]s\b/iu);
        if (possessive >= 0 && (alias.slice(0, possessive).match(/[\p{L}\p{N}-]+/gu) || []).length <= 3) return false;
        const tokens = identityNameTokens(alias);
        if (!tokens.length) return false;
        if (tokens.some(token => canonicalTokens.has(token))) return true;
        const significant = tokens.filter(token => !GENERIC_PERSON_ALIAS_TOKENS.has(token));
        if (!significant.length) return false;
        if (tokens.length >= 3 && /^(?:the|a|an)\b/iu.test(alias)) return true;
        if (tokens.length === 1) return /^\p{Lu}/u.test(alias);
        const words = alias.match(/[\p{L}\p{N}]+/gu) || [];
        return words.every(word => GENERIC_PERSON_ALIAS_TOKENS.has(key(word)) || /^\p{Lu}/u.test(word));
    });
}

function removeCrossEntityCanonicalAliases(entities) {
    const owners = new Map();
    for (const entity of entities || []) {
        const identity = key(entity?.name);
        if (!identity) continue;
        const matches = owners.get(identity) || [];
        matches.push(entity);
        owners.set(identity, matches);
    }
    let removed = 0;
    for (const entity of entities || []) {
        const before = entity.aliases || [];
        entity.aliases = before.filter(alias => {
            const matches = owners.get(key(alias)) || [];
            const keep = !matches.some(owner => owner !== entity);
            if (!keep) removed++;
            return keep;
        });
    }
    return removed;
}

function exactTextKey(value) {
    return text(value).toLocaleLowerCase().replace(/[.!?]+$/u, '');
}

export function compactHierarchyFields(result, turningPointLimit = 8, openThreadLimit = 12) {
    const seen = new Set();
    const take = value => {
        const cleaned = text(value);
        const key = exactTextKey(cleaned);
        if (!key || seen.has(key)) return '';
        seen.add(key);
        return cleaned;
    };
    const takeList = (value, limit) => {
        const output = [];
        for (const item of Array.isArray(value) ? value : []) {
            const cleaned = take(item);
            if (cleaned) output.push(cleaned);
            if (output.length >= limit) break;
        }
        return output;
    };
    return {
        summary: take(result?.summary),
        turningPoints: takeList(result?.turningPoints, turningPointLimit),
        emotionalArc: take(result?.emotionalArc),
        closingState: take(result?.closingState),
        openThreads: takeList(result?.openThreads, openThreadLimit),
    };
}

function canonicalList(world, value, max = 30) {
    return [...new Set(cleanList(value, max).map(item => canonicalMemorySubject(world, item)).filter(Boolean))].slice(0, max);
}

function mergedSources(...groups) {
    const sources = new Map();
    for (const source of groups.flat()) {
        if (!source?.chatKey || !Number.isFinite(Number(source.from)) || !Number.isFinite(Number(source.to))) continue;
        const identity = `${source.chatKey}|${Number(source.from)}|${Number(source.to)}`;
        sources.set(identity, { ...source, from: Number(source.from), to: Number(source.to) });
    }
    return [...sources.values()].slice(-20);
}

function recordTimestamp(item) {
    return Math.max(
        Number.isFinite(Date.parse(item?.updatedAt)) ? Date.parse(item.updatedAt) : 0,
        ...(item?.sources || []).map(source => Number.isFinite(Date.parse(source?.capturedAt)) ? Date.parse(source.capturedAt) : 0),
    );
}

function mergeCanonicalDuplicates(left, right) {
    const preferred = left.correctionId
        ? left
        : right.correctionId || recordTimestamp(right) >= recordTimestamp(left)
            ? right
            : left;
    const other = preferred === left ? right : left;
    return {
        ...other,
        ...preferred,
        sources: mergedSources(left.sources || [], right.sources || []),
        createdAt: left.createdAt || right.createdAt,
        updatedAt: recordTimestamp(right) >= recordTimestamp(left) ? right.updatedAt : left.updatedAt,
    };
}

function deduplicateCanonicalRecords(items, identity) {
    const result = [];
    const indexes = new Map();
    for (const item of items || []) {
        const identityKey = identity(item);
        if (!identityKey || !indexes.has(identityKey)) {
            if (identityKey) indexes.set(identityKey, result.length);
            result.push(item);
            continue;
        }
        const index = indexes.get(identityKey);
        result[index] = mergeCanonicalDuplicates(result[index], item);
    }
    return result;
}

export function normalizeAddressFacts(world) {
    reconcileGenericAddressDuplicates(world, world);
    removeInvalidAddressFacts(world);
    const normalized = [];
    const indexes = new Map();
    for (const item of world?.facts || []) {
        const identity = addressFactIdentity(item, world);
        if (!identity) {
            normalized.push(item);
            continue;
        }
        const speaker = canonicalMemorySubject(world, item.subject);
        const addressee = canonicalMemorySubject(world, addressFactAddressee(item));
        const record = {
            ...item,
            subject: speaker,
            predicate: `calls ${addressee}`,
            value: mergeAddressValues(item.value),
            category: 'form of address',
        };
        if (!indexes.has(identity)) {
            indexes.set(identity, normalized.length);
            normalized.push(record);
            continue;
        }
        const index = indexes.get(identity);
        const existing = normalized[index];
        const preferred = existing.correctionId
            ? existing
            : record.correctionId || recordTimestamp(record) >= recordTimestamp(existing)
                ? record
                : existing;
        const other = preferred === existing ? record : existing;
        normalized[index] = {
            ...other,
            ...preferred,
            value: preferred.correctionId ? preferred.value : mergeAddressValues(existing.value, record.value),
            sources: mergedSources(existing.sources || [], record.sources || []),
            createdAt: existing.createdAt || record.createdAt,
        };
    }
    world.facts = normalized;
    return world;
}

function exactEntityNames(entity) {
    return [entity?.name, ...(entity?.aliases || [])].map(key).filter(Boolean);
}

function identityNameTokens(value) {
    return key(value)
        .replace(/[’‘]/gu, "'")
        .replace(/'s\b/gu, '')
        .match(/[\p{L}\p{N}]+/gu) || [];
}

const IDENTITY_ROLE_TOKENS = new Set([
    'master', 'mentor', 'teacher', 'captain', 'commander', 'leader', 'handler', 'apprentice', 'student',
    'padawan', 'pupil', 'parent', 'mother', 'father', 'brother', 'sister', 'sibling', 'spouse', 'husband',
    'wife', 'attendant', 'retainer', 'servant', 'guardian', 'ward',
]);

function descriptiveReferenceMatchesName(reference, name) {
    const referenceTokens = identityNameTokens(reference);
    const nameTokens = new Set(identityNameTokens(name));
    return referenceTokens.length >= 2
        && referenceTokens.some(token => IDENTITY_ROLE_TOKENS.has(token))
        && [...nameTokens].some(token => IDENTITY_ROLE_TOKENS.has(token))
        && referenceTokens.every(token => nameTokens.has(token));
}

function descriptionBeginsWithDescriptiveReference(reference, description) {
    const referenceTokens = identityNameTokens(reference);
    const lead = text(description).split(/[,:;.!?]/u, 1)[0];
    const leadTokens = identityNameTokens(lead);
    if (referenceTokens.length < 2 || !leadTokens.length) return false;
    const firstReferenceIndex = leadTokens.indexOf(referenceTokens[0]);
    return firstReferenceIndex >= 0 && firstReferenceIndex <= 1
        && descriptiveReferenceMatchesName(reference, lead);
}

function isAttributionFallbackDescription(value) {
    return /^Details about .+ remain disputed or attributed in this excerpt/iu.test(text(value));
}

const STABLE_ENTITY_IDENTITY_DESCRIPTION = /\b(?:alias|appearance|apprentice|background|commander|council|formerly?|habit|identity|investigator|Jedi|master|member|mentor|Padawan|personality|quirk|rank|role|served|Sith|student|teacher|title|trained)\b/iu;
const STRUCTURED_CHARACTER_PROFILE = /\b(?:Role\/background|Appearance|Personality\/quirks):/iu;

function mergeStableEntityDescription(priorValue, incomingValue, entityType = '') {
    const prior = text(priorValue);
    const incoming = text(incomingValue);
    if (!prior || isAttributionFallbackDescription(prior)) return incoming;
    if (!incoming || isAttributionFallbackDescription(incoming)) return prior;
    if (entityIsPersonLike(entityType) && STRUCTURED_CHARACTER_PROFILE.test(incoming)) return incoming;
    const incomingTerms = new Set(identityNameTokens(incoming));
    let merged = incoming;
    for (const clause of prior.split(/(?<=[.!?])\s+/u).map(text).filter(Boolean)) {
        if (!STABLE_ENTITY_IDENTITY_DESCRIPTION.test(clause)) continue;
        const novel = identityNameTokens(clause).filter(token => token.length >= 3 && !incomingTerms.has(token));
        if (novel.length < 2) continue;
        merged = `${merged} ${clause}`.slice(0, 800);
        for (const token of identityNameTokens(clause)) incomingTerms.add(token);
    }
    return merged;
}

function canonicalizedIdentityDescription(value, replacedNames, canonicalName) {
    let description = text(value);
    for (const name of replacedNames) {
        const candidate = text(name);
        if (!candidate || key(candidate) === key(canonicalName)) continue;
        description = description.replace(
            new RegExp(`(^|\\s)${escaped(candidate)}(?=$|[\\s,.:;!?])`, 'giu'),
            (_match, prefix) => `${prefix}${canonicalName}`,
        );
    }
    return description
        .replace(/(?:[,;]\s*)?(?:his|her|their|the\s+(?:person|figure|entity)['’]s)\s+[^.!?]{0,80}\b(?:name|identity)\b[^.!?]{0,100}\b(?:unknown|undisclosed|unidentified|unconfirmed|questioned)\b[^.!?]*(?:[.!?]|$)/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function applyIdentityResolution(world, raw, meta) {
    const reference = text(raw?.reference);
    const requestedCanonical = text(raw?.canonical);
    const evidence = text(raw?.evidence);
    if (!reference || !requestedCanonical || !evidence || key(reference) === key(requestedCanonical)) return false;

    const canonicalMatches = world.entities.filter(entity => exactEntityNames(entity).includes(key(requestedCanonical)));
    if (canonicalMatches.length !== 1) return false;
    const canonicalEntity = canonicalMatches[0];
    if (canonicalEntity.correctionId || shouldPreserveHistoricalRecord(canonicalEntity, meta)) return false;

    const referenceMatches = world.entities.filter(entity => entity !== canonicalEntity
        && (exactEntityNames(entity).includes(key(reference))
            || descriptiveReferenceMatchesName(reference, entity.name)
            || descriptiveReferenceMatchesName(entity.name, reference)));
    if (referenceMatches.length > 1) return false;
    const priorEntity = referenceMatches[0];
    if (priorEntity?.correctionId || (priorEntity && shouldPreserveHistoricalRecord(priorEntity, meta))) return false;

    // If the reference only matches an alias on another named entity, that
    // alias is the contaminated part. Detach it rather than merging the named
    // entity and rewriting all of its facts, states, and relationships.
    const referenceIsPriorName = priorEntity && key(priorEntity.name) === key(reference);
    const referenceDescribesPriorName = priorEntity && descriptiveReferenceMatchesName(reference, priorEntity.name);
    const mergePriorEntity = Boolean((referenceIsPriorName || referenceDescribesPriorName)
        && entityTypesAreCompatible(priorEntity.type, canonicalEntity.type));
    if (priorEntity && !mergePriorEntity) {
        priorEntity.aliases = cleanList(priorEntity.aliases || [])
            .filter(alias => key(alias) !== key(reference)
                && !descriptiveReferenceMatchesName(reference, alias));
    }

    const replacedNames = new Set([key(reference)]);
    if (mergePriorEntity) {
        for (const name of [priorEntity.name, ...(priorEntity.aliases || [])]) replacedNames.add(key(name));
    }
    const canonicalName = text(canonicalEntity.name);
    const priorNames = mergePriorEntity ? [reference, priorEntity.name, ...(priorEntity.aliases || [])] : [reference];
    const resolutionSource = sourceRef(meta);
    canonicalEntity.aliases = safeEntityAliases(canonicalName, canonicalEntity.type, [
        ...(canonicalEntity.aliases || []),
        reference,
        ...(mergePriorEntity ? [priorEntity.name, ...(priorEntity.aliases || [])] : []),
    ]);
    canonicalEntity.sources = mergedSources(canonicalEntity.sources || [], mergePriorEntity ? priorEntity?.sources || [] : [], [resolutionSource]);
    canonicalEntity.updatedAt = resolutionSource.capturedAt;
    if (mergePriorEntity) {
        const priorDescription = canonicalizedIdentityDescription(priorEntity.description, priorNames, canonicalName);
        if (priorDescription && (!text(canonicalEntity.description) || isAttributionFallbackDescription(canonicalEntity.description))) {
            canonicalEntity.description = priorDescription;
        }
        canonicalEntity.importance = Math.max(Number(canonicalEntity.importance || 0), Number(priorEntity.importance || 0));
        world.entities = world.entities.filter(entity => entity !== priorEntity);
    }

    const replace = value => replacedNames.has(key(value)) ? canonicalName : text(value);
    const replaceList = (value, max = 30) => cleanList(value, max).map(replace).filter(Boolean);
    const updateRecord = (item, fields) => {
        if (item.correctionId || shouldPreserveHistoricalRecord(item, meta)) return item;
        const changed = Object.entries(fields).some(([name, value]) => JSON.stringify(item?.[name]) !== JSON.stringify(value));
        if (!changed) return item;
        return { ...item, ...fields, updatedAt: resolutionSource.capturedAt, sources: mergedSources(item.sources || [], [resolutionSource]) };
    };
    const updateParticipants = (item, max = 30) => {
        if (item.correctionId || shouldPreserveHistoricalRecord(item, meta)) return item;
        const participants = replaceList(item.participants, max);
        return JSON.stringify(item.participants) === JSON.stringify(participants) ? item : { ...item, participants };
    };

    if (world.scene) world.scene = updateRecord(world.scene, { participants: replaceList(world.scene.participants) });
    world.facts = (world.facts || []).map(item => updateRecord(item, { subject: replace(item.subject) }));
    world.states = (world.states || []).map(item => updateRecord(item, { subject: replace(item.subject) }));
    world.relationships = (world.relationships || []).map(item => {
        let dynamic = canonicalizedIdentityDescription(item.dynamic, priorNames, canonicalName);
        const directlyUsesReference = [item?.from, item?.to].some(value => key(value) === key(reference));
        const role = reference.match(/^.+?[’']s\s+(.+)$/u)?.[1];
        if (directlyUsesReference && role) {
            dynamic = dynamic.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(?:the\\s+)?${escaped(role)}(?=$|[^\\p{L}\\p{N}])`, 'giu'),
                (_match, prefix) => `${prefix}${canonicalName}`);
        }
        return updateRecord(item, {
            from: replace(item.from),
            to: replace(item.to),
            dynamic,
        });
    });
    world.events = (world.events || []).map(item => updateRecord(item, { participants: replaceList(item.participants) }));
    world.threads = (world.threads || []).map(item => updateRecord(item, { participants: replaceList(item.participants) }));
    world.backgrounds = (world.backgrounds || []).map(item => updateRecord(item, { participants: replaceList(item.participants) }));
    world.capsules = (world.capsules || []).map(item => updateParticipants(item));
    world.arcs = (world.arcs || []).map(item => updateParticipants(item));
    world.eras = (world.eras || []).map(item => updateParticipants(item, 40));

    world.facts = deduplicateCanonicalRecords(world.facts, item => addressFactIdentity(item, world)
        || `${key(item.subject)}|${key(item.predicate)}|${key(item.category)}`);
    world.states = deduplicateCanonicalRecords(world.states, item => stateIdentity(world, item));
    world.relationships = deduplicateCanonicalRecords(world.relationships, item => relationshipPairIdentity(item, world));
    return true;
}

function applyDescriptionIdentityResolutions(world, meta) {
    const descriptivePeople = (world.entities || []).filter(entity => entityIsPersonLike(entity.type)
        && /['’]s\s+(?:former\s+|dead\s+|deceased\s+)?[\p{L}\p{N}-]+(?:\s+[\p{L}\p{N}-]+){0,3}$/iu.test(text(entity.name)));
    for (const referenceEntity of descriptivePeople) {
        const reference = text(referenceEntity.name);
        const referenceKey = key(reference);
        const candidates = (world.entities || []).filter(entity => entity !== referenceEntity
            && entityIsPersonLike(entity.type)
            && (key(entity.description).startsWith(referenceKey)
                || descriptionBeginsWithDescriptiveReference(reference, entity.description)
                || (entity.aliases || []).some(value => key(value) === referenceKey
                    || descriptiveReferenceMatchesName(reference, value))));
        if (candidates.length !== 1) continue;
        applyIdentityResolution(world, {
            reference,
            canonical: candidates[0].name,
            evidence: `The canonical entity description explicitly identifies ${reference}.`,
        }, meta);
    }
}

function applyRecordMerge(world, raw, meta) {
    const category = text(raw?.category);
    if (!['facts', 'states', 'relationships', 'threads', 'backgrounds'].includes(category) || !text(raw?.evidence)) return false;
    const records = world[category] || [];
    const canonicalId = text(raw.canonicalId);
    const duplicateIds = [...new Set(cleanList(raw.duplicateIds).filter(itemId => itemId !== canonicalId))];
    const canonical = records.find(item => item.id === canonicalId);
    const duplicates = duplicateIds.map(itemId => records.find(item => item.id === itemId));
    if (!canonical || !duplicates.length || duplicates.some(item => !item)) return false;
    if (duplicates.some(item => !reconciliationMergeIsCompatible(category, canonical, item, world))) return false;
    if ([canonical, ...duplicates].some(item => item.correctionId || shouldPreserveHistoricalRecord(item, meta))) return false;

    if (category === 'threads' || category === 'backgrounds') {
        canonical.participants = cleanList([...(canonical.participants || []), ...duplicates.flatMap(item => item.participants || [])]);
    }
    const resolutionSource = sourceRef(meta);
    canonical.sources = mergedSources(canonical.sources || [], ...duplicates.map(item => item.sources || []), [resolutionSource]);
    canonical.updatedAt = resolutionSource.capturedAt;
    const removedIds = new Set(duplicateIds);
    world[category] = records.filter(item => !removedIds.has(item.id));
    raw.duplicateIds = duplicateIds;
    return true;
}

const KNOWLEDGE_NEGATION = /\b(?:does not know|doesn't know|did not know|didn't know|not (?:yet )?known|has not learned|hasn't learned|was not told|wasn't told|has not been told|hasn't been told|has not (?:yet )?disclosed|hasn't disclosed|did not disclose|didn't disclose|is unaware|remains unaware|unknown whether|unclear whether|not sure whether|no knowledge of|no disclosure|no answer (?:has|had|was)?\s*(?:yet )?(?:been )?(?:given|provided|established|disclosed)?|deliberately concealed|kept hidden from)\b/iu;
const KNOWLEDGE_GAIN = /\b(?:already knew|knows?|knew|learned|was told|has been told|became aware|is aware|now aware|discovered|recognizes?|recognized|identifies?|identified|recalls?|recalled|remembers?|remembered|acknowledges?|acknowledged|cites?|cited)\b/iu;
const CURRENT_KNOWLEDGE_GAIN = /\b(?:now knows?|has now learned|is now aware|now recognizes?|now understands?|has learned|has discovered)\b/iu;

function isKnowledgePredicate(item) {
    return /^knowledge of\s+\S/iu.test(text(item?.predicate));
}

function isKnowledgeBoundaryRecord(item) {
    const category = key(item?.category);
    return category === 'knowledge boundary' || category === 'knowledge gap'
        || (category === 'knowledge' && KNOWLEDGE_NEGATION.test(text(item?.value))
            && !CURRENT_KNOWLEDGE_GAIN.test(text(item?.value)));
}

function prepareKnowledgeTransitions(world, result, meta) {
    for (const incoming of result?.facts || []) {
        if (!isKnowledgePredicate(incoming)) continue;
        const category = key(incoming.category);
        const value = text(incoming.value);
        if ((category === 'knowledge boundary' || category === 'knowledge gap')
            && ((!KNOWLEDGE_NEGATION.test(value) && KNOWLEDGE_GAIN.test(value))
                || CURRENT_KNOWLEDGE_GAIN.test(value))) {
            incoming.category = 'knowledge';
            incoming.targetId = '';
        }
        if (key(incoming.category) !== 'knowledge'
            || (KNOWLEDGE_NEGATION.test(value)
                && !CURRENT_KNOWLEDGE_GAIN.test(value)
                && !hasEstablishedKnowledgeClause(value))) continue;
        const subject = key(canonicalMemorySubject(world, incoming.subject));
        const predicate = key(incoming.predicate);
        world.facts = (world.facts || []).filter(existing => existing.correctionId
            || shouldPreserveHistoricalRecord(existing, meta)
            || !isKnowledgeBoundaryRecord(existing)
            || key(existing.subject) !== subject
            || key(existing.predicate) !== predicate
            || !knowledgeBoundaryContradictedBy(existing.value, value, predicate));
    }
}

function applyActiveScene(world, result, meta, l1Temporal) {
    if (result.scene && typeof result.scene === 'object') {
        world.scene = common({
            ...(world.scene || {}),
            location: text(result.scene.location),
            time: text(result.scene.time),
            participants: canonicalList(world, result.scene.participants),
            activity: text(result.scene.activity),
            mood: text(result.scene.mood),
            temporal: l1Temporal,
        }, meta, 'scene');
    }
}

function applyActiveStates(world, result, meta, l1Temporal) {
    // Scene state is a replaceable snapshot, not historical memory. Advancing
    // the active timeline retires the previous scene snapshot automatically.
    // Ongoing state is retained for reconciliation until an explicit update
    // or clear; retrieval still requires confirmation in the newest L1.
    world.states = world.states.filter(item => item.correctionId || item.scope === 'ongoing');
    for (const raw of result.states || []) {
        if (!raw || typeof raw !== 'object') continue;
        if (reconciliationTargetWasRejected(raw)) continue;
        let requestedTargetId = text(raw.targetId);
        let requestedIndex = requestedTargetId ? world.states.findIndex(item => item.id === requestedTargetId) : -1;
        const missingUntrustedTarget = requestedIndex < 0 && !meta.replayStoredExtraction;
        if (requestedTargetId && requestedIndex >= 0
            && !reconciliationTargetIsCompatible('states', raw, world.states[requestedIndex], world)) {
            raw.targetId = '';
            continue;
        }
        if (requestedTargetId && missingUntrustedTarget) {
            requestedTargetId = '';
            requestedIndex = -1;
            raw.targetId = '';
        }
        const requestedTarget = requestedIndex >= 0 ? world.states[requestedIndex] : null;
        const normalized = {
            subject: requestedTarget?.subject || canonicalMemorySubject(world, raw.subject),
            attribute: requestedTarget?.attribute || canonicalStateAttribute(raw.attribute),
            value: text(raw.value),
            previous: text(raw.previous),
            importance: clampImportance(raw.importance),
            scope: stateScope(raw.scope),
            operation: raw.operation === 'clear' ? 'clear' : 'set',
            temporalAnchorId: l1Temporal.anchorId,
        };
        if (!normalized.subject || !normalized.attribute || isSuppressedByCorrection(world, 'states', normalized, meta)) continue;
        const identity = stateIdentity(world, normalized);
        const index = requestedIndex >= 0 ? requestedIndex : world.states.findIndex(item => stateIdentity(world, item) === identity);
        if (normalized.operation === 'clear') {
            if (index >= 0) raw.targetId = world.states[index].id;
            world.states = world.states.filter(item => item.correctionId || stateIdentity(world, item) !== identity);
            continue;
        }
        if (!normalized.value) continue;
        if (index >= 0) {
            const existing = world.states[index];
            const merged = existing.correctionId ? { ...normalized, ...existing } : { ...existing, ...normalized };
            world.states[index] = common({ ...merged, id: existing.id, createdAt: existing.createdAt }, meta, 'state');
            raw.targetId = world.states[index].id;
        } else {
            const created = common({ ...normalized, ...(requestedTargetId ? { id: requestedTargetId } : {}) }, meta, 'state');
            world.states.push(created);
            raw.targetId = created.id;
        }
    }
}

export function promoteStoredTailSnapshot(world, chatKey, latestCompleteIndex) {
    migrateLegacyBeliefs(world);
    world.states ||= [];
    world.extractions ||= [];
    const boundary = Number(latestCompleteIndex);
    if (!chatKey || !Number.isFinite(boundary) || boundary < 0) return false;
    const extraction = world.extractions
        .filter(item => item?.chatKey === chatKey
            && Number(item?.to) === boundary
            && item?.result && typeof item.result === 'object')
        .sort((a, b) => Number(b.from) - Number(a.from))[0];
    if (!extraction || extraction.allowStateUpdates !== false) return false;
    const result = structuredClone(extraction.result);
    const meta = {
        chatKey,
        from: Number(extraction.from),
        to: Number(extraction.to),
        allowStateUpdates: true,
        replayStoredExtraction: true,
    };
    const l1Temporal = buildL1TemporalAnchor(world, result.sceneCapsule?.temporal, meta);
    applyActiveScene(world, result, meta, l1Temporal);
    applyActiveStates(world, result, meta, l1Temporal);
    extraction.allowStateUpdates = true;
    extraction.updatedAt = new Date().toISOString();
    return true;
}

export function mergeExtraction(world, result, meta) {
    migrateLegacyBeliefs(world);
    world.entities ||= [];
    world.facts ||= [];
    world.states ||= [];
    world.relationships ||= [];
    world.events ||= [];
    world.capsules ||= [];
    world.arcs ||= [];
    world.eras ||= [];
    world.extractions ||= [];
    world.threads ||= [];
    world.backgrounds ||= [];
    world.corrections ||= [];
    world.sources ||= {};
    // Extraction-time attribution checks have already removed unsafe
    // relationships. Let the accepted canonical relationship restore a role
    // description if the model left the entity as a disputed placeholder.
    recoverRelationshipBackedEntityDescriptions(result, world, null);
    enrichEntityDescriptionsFromEstablishedFacts(result, world);
    reconcileGenericAddressDuplicates(result, world);
    removeInvalidAddressFacts(result);
    normalizeAddressFacts(world);
    prepareKnowledgeTransitions(world, result, meta);
    const l1Temporal = buildL1TemporalAnchor(world, result.sceneCapsule?.temporal, meta);

    if (meta.allowStateUpdates !== false) applyActiveScene(world, result, meta, l1Temporal);

    // Historical backfill must not replace a record from another chat or
    // regress a later range, but newer ranges in the same chat must advance
    // durable continuity. Scene and active state remain tail-only snapshots.
    const preserveHistoricalRecord = item => shouldPreserveHistoricalRecord(item, meta);

    mergeArray(world, 'entities', world.entities, result.entities, item => key(item.name), meta, 'entity', (item, existing) => {
        const suppliedName = text(item.name);
        const current = existing || world.entities.find(entity => key(entity?.name) === key(suppliedName));
        // A new entity keeps its supplied name. Fuzzy canonicalization here can
        // collapse possessive objects or descriptive people into an unrelated
        // established entity before identity resolution has evidence.
        // A validated identity resolution is the narrow exception: when the
        // extractor correctly targets the existing descriptive entity, rename
        // that anchor in place so the later resolution pass can migrate every
        // fact, relationship, and thread endpoint to the canonical name.
        const validatedRename = current && (result.identityResolutions || []).some(resolution =>
            key(resolution?.canonical) === key(suppliedName)
            && exactEntityNames(current).includes(key(resolution?.reference)));
        const canonicalName = validatedRename ? suppliedName : (current?.name || suppliedName);
        const type = current?.type || text(item.type) || 'entity';
        const incomingDescription = text(item.description);
        const description = mergeStableEntityDescription(current?.description, incomingDescription, type);
        return {
            name: canonicalName,
            type,
            aliases: safeEntityAliases(canonicalName, type, [
                ...(item.aliases || []),
                ...(canonicalName !== suppliedName ? [suppliedName] : []),
            ])
                .filter(alias => !(world.entities || []).some(entity => entity !== existing
                    && key(entity.name) === key(alias))),
            description,
            importance: Math.max(clampImportance(item.importance), clampImportance(current?.importance)),
        };
    }, preserveHistoricalRecord, result);

    for (const resolution of result.identityResolutions || []) applyIdentityResolution(world, resolution, meta);
    applyDescriptionIdentityResolutions(world, meta);
    removeCrossEntityCanonicalAliases(world.entities);
    reconcileCanonicalKnowledgeFacts(world);

    mergeArray(world, 'facts', world.facts, result.facts, item => addressFactIdentity(item, world) || `${key(item.subject)}|${key(item.predicate)}|${key(item.category)}`, meta, 'fact', (item, existing) => {
        const address = isAddressFact(item);
        const incomingSubject = canonicalMemorySubject(world, item.subject);
        const current = existing || world.facts.find(candidate =>
            key(canonicalMemorySubject(world, candidate?.subject)) === key(incomingSubject)
            && key(candidate?.predicate) === key(item?.predicate)
            && key(candidate?.category) === key(item?.category));
        const subject = current?.subject || incomingSubject;
        const addressee = address
            ? canonicalMemorySubject(world, addressFactAddressee(current || item))
            : '';
        return {
            subject,
            predicate: address ? `calls ${addressee}` : current?.predicate || text(item.predicate),
            value: address ? mergeAddressValues(current?.value, item.value) : additiveKnowledgeValue(current, item),
            category: address ? 'form of address' : text(item.category),
            importance: clampImportance(item.importance),
            persistence: ['temporary', 'recurring', 'persistent'].includes(item.persistence) ? item.persistence : 'persistent',
            temporalAnchorId: l1Temporal.anchorId,
        };
    }, preserveHistoricalRecord, result);

    if (meta.allowStateUpdates !== false) applyActiveStates(world, result, meta, l1Temporal);

    for (const relationship of result.relationships || []) {
        if (!relationship || typeof relationship !== 'object' || text(relationship.targetId)) continue;
        const pair = relationshipPairIdentity(relationship, world);
        const existing = pair ? world.relationships.find(item => relationshipPairIdentity(item, world) === pair) : null;
        if (existing?.id) relationship.targetId = existing.id;
    }
    mergeArray(world, 'relationships', world.relationships, result.relationships, item => relationshipPairIdentity(item, world), meta, 'relationship', (item, existing) => ({
        from: existing?.from || canonicalMemorySubject(world, item.from),
        to: existing?.to || canonicalMemorySubject(world, item.to),
        kind: existing?.kind || text(item.kind) || 'relationship',
        status: text(item.status),
        dynamic: text(item.dynamic),
        importance: clampImportance(item.importance),
        temporalAnchorId: l1Temporal.anchorId,
    }), preserveHistoricalRecord, result);
    reconcileCanonicalKnowledgeFacts(world);

    // Events are immutable history. Deduplicate only the same event extracted from overlapping ranges.
    for (const raw of result.events || []) {
        const event = {
            title: text(raw.title),
            summary: text(raw.summary),
            participants: canonicalList(world, raw.participants),
            location: text(raw.location),
            storyTime: text(raw.storyTime),
            temporal: buildRelativeTemporalAnchor(raw.temporal, l1Temporal),
            consequences: text(raw.consequences),
            importance: clampImportance(raw.importance),
        };
        if (!event.title && !event.summary) continue;
        if (isSuppressedByCorrection(world, 'events', event, meta)) continue;
        const signature = `${key(event.title)}|${key(event.summary).slice(0, 160)}`;
        const duplicate = world.events.some(existing => {
            const sameContent = `${key(existing.title)}|${key(existing.summary).slice(0, 160)}` === signature;
            const overlappingSource = (existing.sources || []).some(source => source.chatKey === meta.chatKey
                && Number(source.from) <= Number(meta.to)
                && Number(source.to) >= Number(meta.from));
            return sameContent && overlappingSource;
        });
        if (!duplicate) world.events.push(common(event, meta, 'event'));
    }

    mergeArray(world, 'threads', world.threads, result.threads, item => key(item.title), meta, 'thread', (item, existing) => ({
        title: existing?.title || text(item.title),
        detail: text(item.detail),
        status: ['open', 'resolved', 'abandoned'].includes(item.status) ? item.status : 'open',
        participants: canonicalList(world, item.participants),
        importance: clampImportance(item.importance),
        temporalAnchorId: l1Temporal.anchorId,
    }), preserveHistoricalRecord);

    mergeArray(world, 'backgrounds', world.backgrounds, result.backgrounds, item => key(item.topic), meta, 'background', (item, existing) => ({
        topic: existing?.topic || clipped(item.topic, 120),
        summary: clipped(item.summary, 400),
        status: ['active', 'resolved', 'dormant'].includes(item.status) ? item.status : 'active',
        certainty: ['confirmed', 'reported', 'rumored', 'uncertain'].includes(item.certainty) ? item.certainty : 'uncertain',
        participants: canonicalList(world, item.participants, 12),
        importance: clampImportance(item.importance),
        temporalAnchorId: l1Temporal.anchorId,
    }), preserveHistoricalRecord);

    for (const merge of result.recordMerges || []) applyRecordMerge(world, merge, meta);

    if (result.sceneCapsule && typeof result.sceneCapsule === 'object') {
        const raw = result.sceneCapsule;
        const capsule = {
            title: clipped(raw.title, 100) || `Messages ${meta.from}–${meta.to}`,
            storyTime: clipped(raw.storyTime, 120),
            temporal: l1Temporal,
            location: clipped(raw.location, 160),
            participants: canonicalList(world, raw.participants),
            opening: clipped(raw.opening, 320),
            beats: cleanList(raw.beats, 10).map(item => clipped(item, 400)),
            emotionalArc: clipped(raw.emotionalArc, 320),
            closing: clipped(raw.closing, 320),
            coverageWarnings: cleanList(raw.coverageWarnings, 8).map(item => clipped(item, 440)),
            importance: clampImportance(raw.importance),
            chatKey: meta.chatKey,
            from: meta.from,
            to: meta.to,
        };
        if ((capsule.opening || capsule.beats.length || capsule.closing) && !isSuppressedByCorrection(world, 'capsules', capsule, meta)) {
            const index = world.capsules.findIndex(item => item.chatKey === meta.chatKey && Number(item.from) === Number(meta.from) && Number(item.to) === Number(meta.to));
            if (index >= 0) {
                if (!world.capsules[index].correctionId) {
                    const replacedId = world.capsules[index].id;
                    const removedArcIds = new Set(world.arcs.filter(arc => (arc.capsuleIds || []).includes(replacedId)).map(arc => arc.id));
                    world.arcs = world.arcs.filter(arc => !removedArcIds.has(arc.id));
                    world.eras = world.eras.filter(era => !(era.arcIds || []).some(arcId => removedArcIds.has(arcId)));
                    world.capsules[index] = common({ ...world.capsules[index], ...capsule, id: world.capsules[index].id, createdAt: world.capsules[index].createdAt }, meta, 'capsule');
                }
            } else {
                world.capsules.push(common(capsule, meta, 'capsule'));
            }
        }
    }

    const extractionRecord = {
        id: world.extractions.find(item => item.chatKey === meta.chatKey && Number(item.from) === Number(meta.from) && Number(item.to) === Number(meta.to))?.id || id('extraction'),
        chatKey: meta.chatKey,
        from: meta.from,
        to: meta.to,
        allowStateUpdates: meta.allowStateUpdates !== false,
        result: structuredClone(result),
        messageFingerprints: structuredClone(meta.messageFingerprints || []),
        updatedAt: new Date().toISOString(),
    };
    const extractionIndex = world.extractions.findIndex(item => item.chatKey === meta.chatKey && Number(item.from) === Number(meta.from) && Number(item.to) === Number(meta.to));
    if (extractionIndex >= 0) {
        extractionRecord.createdAt = world.extractions[extractionIndex].createdAt || extractionRecord.updatedAt;
        world.extractions[extractionIndex] = extractionRecord;
    } else {
        extractionRecord.createdAt = extractionRecord.updatedAt;
        world.extractions.push(extractionRecord);
    }

    const existingSource = world.sources[meta.chatKey] || {};
    const processedByIndex = new Map((existingSource.processedMessages || []).map(item => [Number(item.index), item]));
    const completedIndexes = new Set();
    for (const item of meta.messageFingerprints || []) {
        const index = Number(item.index);
        completedIndexes.add(index);
        processedByIndex.set(index, { index, fingerprint: String(item.fingerprint), version: EXTRACTION_VERSION });
    }
    world.sources[meta.chatKey] = {
        ...existingSource,
        lastProcessedIndex: Math.max(meta.to, world.sources[meta.chatKey]?.lastProcessedIndex ?? -1),
        lastProcessedAt: new Date().toISOString(),
        processedMessages: [...processedByIndex.values()].sort((a, b) => a.index - b.index).slice(-100000),
        requiredMemoryIndexes: (existingSource.requiredMemoryIndexes || [])
            .map(Number)
            .filter(index => Number.isFinite(index) && !completedIndexes.has(index)),
    };

    return world;
}

function sameRange(source, meta) {
    return source?.chatKey === meta.chatKey && Number(source.from) === Number(meta.from) && Number(source.to) === Number(meta.to);
}

export function replaceExtraction(world, result, meta) {
    migrateLegacyBeliefs(world);
    world.extractions ||= [];
    world.arcs ||= [];
    world.eras ||= [];
    const removedCapsuleIds = new Set((world.capsules || []).filter(item => sameRange(item, meta)).map(item => item.id));
    const removedArcIds = new Set(world.arcs.filter(arc => (arc.capsuleIds || []).some(id => removedCapsuleIds.has(id))).map(arc => arc.id));
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']) {
        world[category] = (world[category] || []).flatMap(item => {
            const sources = (item.sources || []).filter(source => !sameRange(source, meta));
            return sources.length ? [{ ...item, sources }] : [];
        });
    }
    world.capsules = (world.capsules || []).filter(item => !sameRange(item, meta));
    world.arcs = world.arcs.filter(arc => !(arc.capsuleIds || []).some(id => removedCapsuleIds.has(id)));
    world.eras = world.eras.filter(era => !(era.arcIds || []).some(id => removedArcIds.has(id)));
    world.extractions = world.extractions.filter(item => !sameRange(item, meta));
    if (world.scene?.sources?.some(source => sameRange(source, meta))) {
        const sources = world.scene.sources.filter(source => !sameRange(source, meta));
        world.scene = sources.length ? { ...world.scene, sources } : null;
    }
    return mergeExtraction(world, result, meta);
}

export function removeChatContributions(world, chatKey) {
    migrateLegacyBeliefs(world);
    const removedCapsuleIds = new Set((world.capsules || []).filter(item => item.chatKey === chatKey).map(item => item.id));
    const removedArcIds = new Set((world.arcs || []).filter(arc => arc.chatKey === chatKey || (arc.capsuleIds || []).some(id => removedCapsuleIds.has(id))).map(arc => arc.id));
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']) {
        world[category] = (world[category] || []).flatMap(item => {
            const sources = (item.sources || []).filter(source => source.chatKey !== chatKey);
            return sources.length ? [{ ...item, sources }] : [];
        });
    }
    world.capsules = (world.capsules || []).filter(item => item.chatKey !== chatKey);
    world.arcs = (world.arcs || []).filter(arc => arc.chatKey !== chatKey && !(arc.capsuleIds || []).some(id => removedCapsuleIds.has(id)));
    world.eras = (world.eras || []).filter(era => !(era.arcIds || []).some(id => removedArcIds.has(id)));
    world.extractions = (world.extractions || []).filter(item => item.chatKey !== chatKey);
    if (world.scene?.sources?.some(source => source.chatKey === chatKey)) {
        const sources = world.scene.sources.filter(source => source.chatKey !== chatKey);
        world.scene = sources.length ? { ...world.scene, sources } : null;
    }
    if (world.sources) delete world.sources[chatKey];
    return world;
}

function replayIdentity(collection, item, chatKey) {
    if (collection === 'entities') return key(item.name);
    if (collection === 'facts') return addressFactIdentity(item) || `${key(item.subject)}|${key(item.predicate)}|${key(item.category)}`;
    if (collection === 'states') return stateIdentity(null, item);
    if (collection === 'relationships') return relationshipPairIdentity(item);
    if (collection === 'threads') return key(item.title);
    if (collection === 'backgrounds') return key(item.topic);
    if (collection === 'capsules' || collection === 'extractions') {
        return item.chatKey === chatKey ? `${item.chatKey}|${Number(item.from)}|${Number(item.to)}` : '';
    }
    if (collection === 'events') {
        const ranges = (item.sources || [])
            .filter(source => source.chatKey === chatKey)
            .map(source => `${Number(source.from)}:${Number(source.to)}`)
            .sort()
            .join(',');
        return ranges ? `${key(item.title)}|${key(item.summary)}|${ranges}` : '';
    }
    return '';
}

export function restoreRetainedReplayRecords(world, previousWorld, chatKey) {
    migrateLegacyBeliefs(world);
    migrateLegacyBeliefs(previousWorld);
    for (const collection of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds', 'capsules', 'extractions']) {
        const previousByIdentity = new Map();
        for (const item of previousWorld?.[collection] || []) {
            const identity = replayIdentity(collection, item, chatKey);
            if (identity) previousByIdentity.set(identity, item);
        }
        for (const item of world?.[collection] || []) {
            const identity = replayIdentity(collection, item, chatKey);
            const previous = identity ? previousByIdentity.get(identity) : null;
            if (!previous?.id) continue;
            item.id = previous.id;
            if (previous.createdAt) item.createdAt = previous.createdAt;
        }
    }

    if (world.scene && previousWorld?.scene?.id) {
        world.scene.id = previousWorld.scene.id;
        if (previousWorld.scene.createdAt) world.scene.createdAt = previousWorld.scene.createdAt;
    }

    const capsuleIds = new Set((world.capsules || []).map(item => item.id));
    const retainedArcs = (previousWorld?.arcs || []).filter(arc => {
        const sourceIds = arc.capsuleIds || [];
        return sourceIds.length && sourceIds.every(id => capsuleIds.has(id));
    });
    const arcIds = new Set((world.arcs || []).map(item => item.id));
    for (const arc of retainedArcs) {
        if (arcIds.has(arc.id)) continue;
        world.arcs.push(structuredClone(arc));
        arcIds.add(arc.id);
    }

    const retainedEras = (previousWorld?.eras || []).filter(era => {
        const sourceIds = era.arcIds || [];
        return sourceIds.length && sourceIds.every(id => arcIds.has(id));
    });
    const eraIds = new Set((world.eras || []).map(item => item.id));
    for (const era of retainedEras) {
        if (eraIds.has(era.id)) continue;
        world.eras.push(structuredClone(era));
        eraIds.add(era.id);
    }
    const requiredMemoryIndexes = (previousWorld?.sources?.[chatKey]?.requiredMemoryIndexes || [])
        .map(Number)
        .filter(Number.isFinite);
    if (requiredMemoryIndexes.length) {
        world.sources ||= {};
        world.sources[chatKey] = {
            ...(world.sources[chatKey] || {}),
            requiredMemoryIndexes: [...new Set(requiredMemoryIndexes)].sort((a, b) => a - b),
        };
    }
    return world;
}

function orderedChatExtractions(world, chatKey) {
    return (world?.extractions || [])
        .filter(item => item?.chatKey === chatKey && Number.isFinite(Number(item.from)) && Number.isFinite(Number(item.to)))
        .slice()
        .sort((a, b) => Number(a.from) - Number(b.from) || Number(a.to) - Number(b.to) || String(a.id || '').localeCompare(String(b.id || '')));
}

export function getLatestL1UndoStatus(world, chatKey) {
    const extractions = orderedChatExtractions(world, chatKey);
    const target = extractions.at(-1);
    if (!target) return { available: false, replayable: false, from: null, to: null, extractionId: '', dependentL2: 0, dependentL3: 0 };

    const targetCapsuleIds = new Set((world?.capsules || [])
        .filter(item => item.chatKey === chatKey && Number(item.from) === Number(target.from) && Number(item.to) === Number(target.to))
        .map(item => item.id));
    const dependentArcIds = new Set((world?.arcs || [])
        .filter(item => (item.capsuleIds || []).some(id => targetCapsuleIds.has(id)))
        .map(item => item.id));
    const dependentL3 = (world?.eras || []).filter(item => (item.arcIds || []).some(id => dependentArcIds.has(id))).length;

    return {
        available: true,
        replayable: extractions.every(item => item.result && typeof item.result === 'object'),
        from: Number(target.from),
        to: Number(target.to),
        extractionId: String(target.id || ''),
        dependentL2: dependentArcIds.size,
        dependentL3,
    };
}

export function undoLatestL1Extraction(world, chatKey, expectedExtractionId = '') {
    const status = getLatestL1UndoStatus(world, chatKey);
    if (!status.available) throw new Error('There is no saved L1 memory to undo for this chat.');
    if (!status.replayable) throw new Error('This memory predates stored L1 replay data and cannot safely undo one range. Rebuild it from scratch first.');
    if (expectedExtractionId && status.extractionId !== expectedExtractionId) {
        throw new Error('The latest L1 changed while Undo was saving. Nothing was removed; review the latest range and try again.');
    }

    const retained = orderedChatExtractions(world, chatKey)
        .filter(item => Number(item.from) !== status.from || Number(item.to) !== status.to);
    const target = orderedChatExtractions(world, chatKey)
        .find(item => Number(item.from) === status.from && Number(item.to) === status.to);
    const previousWorld = structuredClone(world);
    const previousArcIds = new Set((world.arcs || []).map(item => item.id));
    const previousEraIds = new Set((world.eras || []).map(item => item.id));

    removeChatContributions(world, chatKey);
    for (const item of retained) {
        mergeExtraction(world, structuredClone(item.result), {
            chatKey,
            from: Number(item.from),
            to: Number(item.to),
            allowStateUpdates: item.allowStateUpdates !== false,
            replayStoredExtraction: true,
            messageFingerprints: structuredClone(item.messageFingerprints || []),
        });
    }
    restoreRetainedReplayRecords(world, previousWorld, chatKey);
    const requiredMemoryIndexes = (target?.messageFingerprints || [])
        .map(item => Number(item.index))
        .filter(Number.isFinite);
    const fallbackIndexes = Array.from({ length: Math.max(0, status.to - status.from + 1) }, (_, offset) => status.from + offset);
    const alreadyRequired = (world.sources?.[chatKey]?.requiredMemoryIndexes || []).map(Number).filter(Number.isFinite);
    world.sources ||= {};
    world.sources[chatKey] = {
        ...(world.sources[chatKey] || {}),
        requiredMemoryIndexes: [...new Set([...alreadyRequired, ...(requiredMemoryIndexes.length ? requiredMemoryIndexes : fallbackIndexes)])].sort((a, b) => a - b),
    };

    const retainedArcIds = new Set((world.arcs || []).map(item => item.id));
    const retainedEraIds = new Set((world.eras || []).map(item => item.id));
    return {
        undone: true,
        world,
        from: status.from,
        to: status.to,
        extractionId: status.extractionId,
        removedL1: 1,
        removedL2: [...previousArcIds].filter(id => !retainedArcIds.has(id)).length,
        removedL3: [...previousEraIds].filter(id => !retainedEraIds.has(id)).length,
        retainedL1: retained.length,
    };
}

export function resetWorldMemory(world, { preserveCorrections = false } = {}) {
    migrateLegacyBeliefs(world);
    const corrections = preserveCorrections ? structuredClone(world.corrections || []) : [];
    const correctionIds = new Set(corrections.map(item => item.id));
    const correctedRecords = {};
    if (preserveCorrections) {
        for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'threads', 'backgrounds']) {
            correctedRecords[category] = structuredClone((world[category] || [])
                .filter(item => correctionIds.has(item.correctionId)));
        }
    }
    world.scene = null;
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'backgrounds', 'corrections']) {
        world[category] = [];
    }
    if (preserveCorrections) {
        for (const [category, records] of Object.entries(correctedRecords)) world[category] = records;
        world.corrections = corrections;
    }
    world.sources = {};
    world.continuation = null;
    return world;
}

export function freshResetResiduals(world, { allowCorrections = false } = {}) {
    const correctionIds = allowCorrections
        ? new Set((world?.corrections || []).map(item => item?.id).filter(Boolean))
        : new Set();
    const residuals = [];
    if (world?.scene) residuals.push('scene');
    if (world?.continuation) residuals.push('continuation');
    if (Object.keys(world?.sources || {}).length) residuals.push('sources');
    if (!allowCorrections && (world?.corrections || []).length) residuals.push(`corrections:${world.corrections.length}`);
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'backgrounds']) {
        const uncorrected = (world?.[category] || []).filter(item => !correctionIds.has(item?.correctionId));
        if (uncorrected.length) residuals.push(`${category}:${uncorrected.length}`);
    }
    return residuals;
}

export function resetWorldHierarchy(world) {
    world.arcs = [];
    world.eras = [];
    return world;
}

export function addDerivedArc(world, result, capsules) {
    world.arcs ||= [];
    const capsuleIds = (capsules || []).map(item => item.id).filter(Boolean);
    if (!capsuleIds.length) throw new Error('Cannot create L2 without source L1 records.');
    const signature = capsuleIds.join('|');
    const duplicate = world.arcs.find(item => (item.capsuleIds || []).join('|') === signature);
    if (duplicate) return duplicate;
    const sources = [];
    const seenSources = new Set();
    for (const capsule of capsules) {
        for (const source of capsule.sources || []) {
            const sourceKey = `${source.chatKey}|${source.from}|${source.to}`;
            if (seenSources.has(sourceKey)) continue;
            seenSources.add(sourceKey);
            sources.push(source);
        }
    }
    const rangeStarts = capsules.map(item => Number(item.from)).filter(Number.isFinite);
    const rangeEnds = capsules.map(item => Number(item.to)).filter(Number.isFinite);
    const temporalAnchorIds = [...new Set(capsules.map(item => item.temporal?.anchorId).filter(Boolean))];
    const temporalFrames = [...new Set(capsules.map(item => item.temporal?.frame).filter(Boolean))];
    const hierarchy = compactHierarchyFields(result, 8, 12);
    const arc = {
        id: id('arc'),
        title: clipped(result.title, 140) || `L2 covering ${capsules.length} L1 records`,
        storyTime: clipped(result.storyTime, 180),
        participants: cleanList(result.participants, 30),
        ...hierarchy,
        importance: clampImportance(result.importance),
        capsuleIds,
        temporalAnchorIds,
        temporalFrames,
        chatKey: capsules[0]?.chatKey || '',
        ...(rangeStarts.length && rangeEnds.length ? { from: Math.min(...rangeStarts), to: Math.max(...rangeEnds) } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: sources.slice(-50),
    };
    world.arcs.push(arc);
    return arc;
}

export function addDerivedEra(world, result, arcs) {
    world.eras ||= [];
    const arcIds = (arcs || []).map(item => item.id).filter(Boolean);
    if (!arcIds.length) throw new Error('Cannot create L3 without source L2 records.');
    const signature = arcIds.join('|');
    const duplicate = world.eras.find(item => (item.arcIds || []).join('|') === signature);
    if (duplicate) return duplicate;
    const capsuleIds = [...new Set(arcs.flatMap(arc => arc.capsuleIds || []))];
    const sources = [];
    const seenSources = new Set();
    for (const arc of arcs) {
        for (const source of arc.sources || []) {
            const sourceKey = `${source.chatKey}|${source.from}|${source.to}`;
            if (seenSources.has(sourceKey)) continue;
            seenSources.add(sourceKey);
            sources.push(source);
        }
    }
    const rangeStarts = arcs.map(item => Number(item.from)).filter(Number.isFinite);
    const rangeEnds = arcs.map(item => Number(item.to)).filter(Number.isFinite);
    const temporalAnchorIds = [...new Set(arcs.flatMap(item => item.temporalAnchorIds || []))];
    const temporalFrames = [...new Set(arcs.flatMap(item => item.temporalFrames || []))];
    const hierarchy = compactHierarchyFields(result, 12, 16);
    const era = {
        id: id('era'),
        title: clipped(result.title, 160) || `L3 covering ${arcs.length} L2 records`,
        storyTime: clipped(result.storyTime, 220),
        participants: cleanList(result.participants, 40),
        ...hierarchy,
        importance: clampImportance(result.importance),
        arcIds,
        capsuleIds,
        temporalAnchorIds,
        temporalFrames,
        chatKey: arcs[0]?.chatKey || '',
        ...(rangeStarts.length && rangeEnds.length ? { from: Math.min(...rangeStarts), to: Math.max(...rangeEnds) } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: sources.slice(-100),
    };
    world.eras.push(era);
    return era;
}

function clampImportance(value) {
    return Math.min(5, Math.max(1, Math.round(Number(value) || 3)));
}

export function worldCounts(world) {
    if (!world) return {};
    migrateLegacyBeliefs(world);
    const counts = Object.fromEntries(['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']
        .map(name => [name, world[name]?.length || 0]));
    counts.L1 = world.capsules?.length || 0;
    counts.L2 = world.arcs?.length || 0;
    counts.L3 = world.eras?.length || 0;
    counts['L1 source ranges'] = world.extractions?.length || 0;
    counts.corrections = world.corrections?.length || 0;
    return counts;
}
