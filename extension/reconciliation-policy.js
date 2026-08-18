import { canonicalMemorySubject, canonicalStateAttribute, isActiveState, stateIdentity } from './state-lifecycle.js';

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
const ADDRESS_PRONOUN = /^(?:i|me|my|mine|myself|you|your|yours|yourself|yourselves|he|him|his|himself|she|her|hers|herself|it|its|itself|we|us|our|ours|ourselves|they|them|their|theirs|themself|themselves)$/iu;
const ADDRESS_PRONOUN_SIGNIFICANCE = /\b(?:address(?:es|ed|ing)?|calls?|form of address|refers? to|instead of (?:a |the )?name|refuses? (?:to use )?(?:a |the )?name|disrespect(?:ful(?:ly)?)?|contempt(?:uous(?:ly)?)?|dismissive(?:ly)?|insult(?:ing(?:ly)?)?|derisive(?:ly)?|rude(?:ly)?|pointedly|deliberately)\b/iu;
const ADDRESS_CLAUSE_START = /^(?:(?:i|you|he|she|it|we|they)[’'](?:m|re|s|ve|d|ll)\b|(?:i|you|he|she|it|we|they)\s+(?:am|are|is|was|were|have|has|had|do|does|did|can|could|will|would|shall|should|may|might|must)(?:n['’]t)?\b)/iu;
const ADDRESS_HONORIFIC_SUFFIX = /(?:[-\s]?(?:san|sama|kun|chan|sensei|senpai|sempai|dono|shi|hakase|heika|denka))$/iu;

export function isAddressFact(item) {
    const category = normalized(item?.category);
    const predicate = normalized(item?.predicate);
    return /^forms? of address$/u.test(category)
        || predicate.startsWith('calls ')
        || predicate.startsWith('form of address for ')
        || /^(?:uses?|used) (?:a )?(?:(?:respectful|formal|informal|honorific|familiar|derisive|disrespectful) )?(?:address|address form|form of address|nickname) (?:toward|towards|for|with) /u.test(predicate);
}

function isGenericAddressFact(item) {
    const category = normalized(item?.category);
    const predicate = normalized(item?.predicate);
    return /^(?:social address|forms? of address)$/u.test(category)
        && /^(?:uses?|used) (?:the )?(?:address|address form|form of address|nickname)$/u.test(predicate);
}

export function addressFactAddressee(item) {
    if (!isAddressFact(item)) return '';
    const predicate = String(item?.predicate || '').replace(/\s+/g, ' ').trim();
    const match = predicate.match(/^(?:calls|form of address for)\s+(.+?)\s*[.!?]?$/iu)
        || predicate.match(/^(?:uses?|used) (?:a )?(?:(?:respectful|formal|informal|honorific|familiar|derisive|disrespectful) )?(?:address|address form|form of address|nickname) (?:toward|towards|for|with)\s+(.+?)\s*[.!?]?$/iu);
    return String(match?.[1] || '').trim();
}

function normalizeDirectionalAddressFacts(container, world = container) {
    if (!Array.isArray(container?.facts)) return 0;
    let changed = 0;
    for (const item of container.facts) {
        if (!isAddressFact(item) || isGenericAddressFact(item)) continue;
        const speaker = canonicalAddressDisplayName(world, item.subject);
        const addressee = canonicalAddressDisplayName(world, addressFactAddressee(item));
        if (!speaker || !addressee) continue;
        const value = mergeAddressValues(String(item.value || '')
            .replace(/^(?:(?:current|preferred|usual)\s+)?(?:address\s+)?forms?\s*:\s*/iu, '')
            .replace(/[“”"'‘’.,]+\s*$/gu, ''));
        const predicate = `calls ${addressee}`;
        if (item.subject !== speaker || item.predicate !== predicate || item.category !== 'form of address' || item.value !== value) changed++;
        item.subject = speaker;
        item.predicate = predicate;
        item.category = 'form of address';
        item.value = value;
    }
    return changed;
}

function canonicalAddressName(world, value) {
    const requested = normalized(value);
    if (!requested) return '';
    const entities = world?.entities || [];
    const matches = entities.filter(entity => [entity?.name, ...(entity?.aliases || [])]
        .some(name => normalized(name) === requested));
    if (matches.length === 1) return normalized(matches[0].name);
    if (!matches.length && !requested.includes(' ')) {
        const shortMatches = entities.filter(entity => String(entity?.name || '').split(/\s+/u)
            .some(part => normalized(part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')) === requested));
        if (shortMatches.length === 1) return normalized(shortMatches[0].name);
    }
    return normalized(value);
}

function canonicalAddressDisplayName(world, value) {
    const canonical = canonicalAddressName(world, value);
    const matches = (world?.entities || []).filter(entity => normalized(entity?.name) === canonical);
    return String(matches.length === 1 ? matches[0].name : value || '').replace(/\s+/g, ' ').trim();
}

function addressNameVariants(world, value) {
    const requested = normalized(value);
    if (!requested) return [];
    const entity = (world?.entities || []).find(item => [item?.name, ...(item?.aliases || [])]
        .some(name => normalized(name) === requested));
    const parts = String(entity?.name || '').split(/\s+/u)
        .map(part => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter(part => part && canonicalAddressName(world, part) === normalized(entity?.name));
    return [...new Set([value, entity?.name, ...(entity?.aliases || []), ...parts]
        .map(name => String(name || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean))];
}

function addressFormNamesSpeaker(item, form, world) {
    const value = normalized(form);
    if (!value) return false;
    const unadorned = value.replace(ADDRESS_HONORIFIC_SUFFIX, '').trim();
    const variants = addressNameVariants(world, item?.subject);
    if (!variants.length && item?.subject) variants.push(String(item.subject));
    return variants.some(variant => {
        const name = normalized(variant);
        if (!name) return false;
        const parts = name.split(/\s+/u).filter(Boolean);
        return value === name || parts.includes(value) || (unadorned && (unadorned === name || parts.includes(unadorned)));
    });
}

function escaped(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsAddressForm(text, form) {
    return normalized(text).includes(normalized(form));
}

function narrativeStrings(result) {
    const strings = [];
    const visit = value => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    for (const key of ['scene', 'sceneCapsule', 'states', 'relationships', 'events', 'threads', 'backgrounds']) visit(result?.[key]);
    return strings;
}

function recoveryEntities(result, world) {
    const entities = new Map();
    for (const item of [...(world?.entities || []), ...(result?.entities || [])]) {
        const name = String(item?.name || '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        const identity = normalized(name);
        const existing = entities.get(identity);
        entities.set(identity, {
            name: existing?.name || name,
            aliases: [...new Set([...(existing?.aliases || []), ...(item?.aliases || [])]
                .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))],
        });
    }
    const records = [...entities.values()];
    const shortCounts = new Map();
    for (const item of records) {
        const short = normalized(item.name.split(/\s+/u)[0]);
        if (short) shortCounts.set(short, (shortCounts.get(short) || 0) + 1);
    }
    return records.map(item => {
        const short = item.name.split(/\s+/u)[0];
        const variants = [item.name, ...item.aliases];
        if (short && shortCounts.get(normalized(short)) === 1) variants.push(short);
        return { ...item, variants: [...new Set(variants)] };
    });
}

export function recoverExplicitAddressFacts(result, world, messages) {
    if (!Array.isArray(result?.facts) || !Array.isArray(messages) || !messages.length) return 0;
    const entities = recoveryEntities(result, world);
    const evidenceWorld = { ...(world || {}), entities };
    const strings = narrativeStrings(result);
    let recovered = 0;
    for (const speaker of entities) {
        for (const addressee of entities) {
            if (normalized(speaker.name) === normalized(addressee.name)) continue;
            for (const speakerName of speaker.variants) {
                for (const addresseeName of addressee.variants) {
                    const pattern = new RegExp(`\\b${escaped(speakerName)}\\b[^\\n\\r]{0,80}\\b(?:calls?|called|nicknames?|nicknamed|dubs?|dubbed|addresses?|addressed|dismisses?|dismissed)\\s+\\b${escaped(addresseeName)}\\b\\s+(?:as\\s+)?[“\"']([^”\"'\\n\\r]{1,80})[”\"']`, 'iu');
                    for (const text of strings) {
                        const form = String(text.match(pattern)?.[1] || '').replace(/\s+/g, ' ').trim();
                        if (!form || !ADDRESS_MEANINGFUL.test(form) || ADDRESS_BRACKET.test(form)) continue;
                        const corroborated = strings.filter(value => containsAddressForm(value, form)).length >= 2;
                        const sourced = messages.some(message => containsAddressForm(message?.text ?? message?.mes, form));
                        if (!corroborated || !sourced) continue;
                        const candidate = { subject: speaker.name, predicate: `calls ${addressee.name}`, category: 'form of address' };
                        const identity = addressFactIdentity(candidate, evidenceWorld);
                        const existing = result.facts.find(item => addressFactIdentity(item, evidenceWorld) === identity);
                        if (existing) {
                            existing.value = mergeAddressValues(existing.value, form);
                        } else {
                            const stored = (world?.facts || []).find(item => addressFactIdentity(item, evidenceWorld) === identity);
                            result.facts.push({
                                targetId: stored?.id || '',
                                subject: speaker.name,
                                predicate: `calls ${addressee.name}`,
                                value: form,
                                category: 'form of address',
                                importance: 2,
                                persistence: 'recurring',
                            });
                            recovered++;
                        }
                    }
                }
            }
        }
    }
    return recovered;
}

export function recoverExplicitEntityAliases(result, messages) {
    if (!Array.isArray(result?.entities) || !Array.isArray(messages) || !messages.length) return 0;
    const strings = narrativeStrings(result);
    let recovered = 0;
    for (const entity of result.entities) {
        const name = String(entity?.name || '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        const knownAliases = new Set((entity.aliases || []).map(normalized).filter(Boolean));
        const variants = [name, name.split(/\s+/u)[0]].filter(Boolean);
        for (const variant of variants) {
            const pattern = new RegExp(`\\b${escaped(variant)}\\b[^\\n\\r]{0,80}\\b(?:is|was|became|becomes)\\s+(?:also\\s+)?(?:known as|called|nicknamed)\\s+[“\"']([^”\"'\\n\\r]{1,80})[”\"']`, 'iu');
            for (const text of strings) {
                const alias = String(text.match(pattern)?.[1] || '')
                    .replace(/\s+/g, ' ').trim().replace(/[.!?]+$/u, '');
                if (!alias || normalized(alias) === normalized(name)
                    || knownAliases.has(normalized(alias))
                    || !ADDRESS_MEANINGFUL.test(alias) || ADDRESS_BRACKET.test(alias)) continue;
                const corroborated = strings.filter(value => containsAddressForm(value, alias)).length >= 2;
                const sourced = messages.some(message => containsAddressForm(message?.text ?? message?.mes, alias));
                if (!corroborated || !sourced) continue;
                entity.aliases = [...new Set([...(entity.aliases || []), alias]
                    .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
                knownAliases.add(normalized(alias));
                recovered++;
            }
        }
    }
    return recovered;
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function identityReferenceParts(value) {
    return cleanText(value).split(/\s*(?:\/|\||;)\s*/u).map(cleanText).filter(Boolean);
}

function identityReferenceTokens(value) {
    return normalized(value)
        .replace(/[’‘]/gu, "'")
        .replace(/'s\b/gu, '')
        .match(/[\p{L}\p{N}]+/gu) || [];
}

const IDENTITY_ROLE_TOKENS = new Set([
    'master', 'mentor', 'teacher', 'captain', 'commander', 'leader', 'handler', 'apprentice', 'student',
    'padawan', 'pupil', 'parent', 'mother', 'father', 'brother', 'sister', 'sibling', 'spouse', 'husband',
    'wife', 'attendant', 'retainer', 'servant', 'guardian', 'ward',
]);

function hasIdentityRoleToken(tokens) {
    return tokens.some(token => IDENTITY_ROLE_TOKENS.has(token));
}

function descriptiveIdentityReferenceMatch(left, right) {
    const leftTokens = identityReferenceTokens(left);
    const rightTokens = identityReferenceTokens(right);
    if (Math.min(leftTokens.length, rightTokens.length) < 2) return false;
    if (!hasIdentityRoleToken(leftTokens) || !hasIdentityRoleToken(rightTokens)) return false;
    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    return leftTokens.every(token => rightSet.has(token)) || rightTokens.every(token => leftSet.has(token));
}

function normalizeIdentityResolutionReferences(result) {
    if (!Array.isArray(result?.identityResolutions)) return 0;
    const expanded = [];
    const seen = new Set();
    let normalizedCount = 0;
    for (const resolution of result.identityResolutions) {
        const canonical = cleanText(resolution?.canonical);
        const evidence = cleanText(resolution?.evidence);
        const parts = identityReferenceParts(resolution?.reference);
        if (!canonical || !evidence || !parts.length) continue;
        if (parts.length > 1) normalizedCount += parts.length - 1;
        for (const reference of parts) {
            if (normalized(reference) === normalized(canonical)) continue;
            const identity = `${normalized(reference)}|${normalized(canonical)}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            expanded.push({ reference, canonical, evidence });
        }
    }
    result.identityResolutions = expanded;
    return normalizedCount;
}

function textMentionsIdentityVariant(value, variants) {
    const source = cleanText(value);
    return variants.map(cleanText).filter(Boolean).some(name =>
        new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(source));
}

export function discardUnsupportedIdentityResolutions(result, world, messages = null) {
    if (!Array.isArray(result?.identityResolutions)) return 0;
    const entities = [...(world?.entities || []), ...(result?.entities || [])];
    const structuredNames = [
        ...entities.flatMap(entity => [entity?.name, ...(entity?.aliases || [])]),
        ...[...(world?.relationships || []), ...(result?.relationships || [])].flatMap(item => [item?.from, item?.to]),
    ].map(normalized).filter(Boolean);
    const supported = resolution => {
        const reference = cleanText(resolution?.reference);
        const canonical = cleanText(resolution?.canonical);
        const evidence = cleanText(resolution?.evidence);
        const canonicalMatches = entities.filter(entity => [entity?.name, ...(entity?.aliases || [])]
            .some(value => normalized(value) === normalized(canonical)));
        const canonicalNames = new Set(canonicalMatches.map(entity => normalized(entity?.name)).filter(Boolean));
        const canonicalEstablished = canonicalNames.size === 1 || structuredNames.includes(normalized(canonical));
        if (!reference || !canonical || !evidence || !canonicalEstablished || canonicalNames.size > 1) return false;
        const canonicalEntity = canonicalMatches[0] || { name: canonical, aliases: [] };
        const canonicalVariants = [canonicalEntity?.name, ...(canonicalEntity?.aliases || []), canonical];
        const descriptor = descriptivePersonIdentityContext(reference, world);
        if (descriptor) {
            const ownerEntity = entities.find(entity => [entity?.name, ...(entity?.aliases || [])]
                .some(value => normalized(value) === normalized(descriptor.owner)));
            const sourceSupported = sourceSupportsNamedIdentity(
                messages, descriptor.owner, descriptor.role, canonicalEntity.name,
                canonicalEntity.aliases, ownerEntity?.aliases,
            );
            return sourceSupported || exactDescriptiveIdentityRelationshipAnchor(
                world, reference, canonicalEntity.name, descriptor.owner,
            );
        }
        const directEvidence = textMentionsIdentityVariant(evidence, [reference])
            && textMentionsIdentityVariant(evidence, canonicalVariants);
        const directSource = (messages || []).some(message => {
            const source = cleanText(message?.text ?? message?.mes);
            return !COVERAGE_NON_ASSERTION.test(source)
                && !/\b(?:might|maybe|possibly|perhaps|whether)\b/iu.test(source)
                && textMentionsIdentityVariant(source, [reference])
                && textMentionsIdentityVariant(source, canonicalVariants);
        });
        if (directEvidence || directSource) return true;
        return false;
    };
    const supportByEvidenceGroup = new Map();
    for (const resolution of result.identityResolutions) {
        const group = `${normalized(resolution?.canonical)}|${normalized(resolution?.evidence)}`;
        supportByEvidenceGroup.set(group, Boolean(supportByEvidenceGroup.get(group) || supported(resolution)));
    }
    const before = result.identityResolutions.length;
    result.identityResolutions = result.identityResolutions.filter(resolution => supportByEvidenceGroup.get(
        `${normalized(resolution?.canonical)}|${normalized(resolution?.evidence)}`,
    ));
    const discarded = before - result.identityResolutions.length;
    return discarded;
}

function resolvedReconciliationSubject(result, world, value) {
    const subject = canonicalMemorySubject(world, value);
    const requested = cleanText(value);
    for (const resolution of result?.identityResolutions || []) {
        const canonical = cleanText(resolution?.canonical);
        if (!canonical) continue;
        if (normalized(requested) === normalized(canonical)) return canonical;
        if (identityReferenceParts(resolution?.reference).some(reference =>
            normalized(requested) === normalized(reference)
            || descriptiveIdentityReferenceMatch(requested, reference)
            || descriptiveIdentityReferenceMatch(subject, reference))) return canonical;
    }
    return subject;
}

function canonicalizeResolvedIdentityReferences(result, world) {
    const replace = value => resolvedReconciliationSubject(result, world, value);
    let changed = 0;
    const replaceField = (item, field) => {
        const previous = cleanText(item?.[field]);
        if (!previous) return;
        const canonical = cleanText(replace(previous));
        if (!canonical || normalized(canonical) === normalized(previous)) return;
        item[field] = canonical;
        changed++;
    };
    const replaceList = (item, field) => {
        if (!Array.isArray(item?.[field])) return;
        const previous = item[field].map(cleanText).filter(Boolean);
        const canonical = [...new Set(previous.map(replace).map(cleanText).filter(Boolean))];
        changed += previous.filter((value, index) => normalized(value) !== normalized(canonical[index])).length;
        item[field] = canonical;
    };
    for (const item of result?.facts || []) replaceField(item, 'subject');
    for (const item of result?.states || []) replaceField(item, 'subject');
    for (const item of result?.relationships || []) {
        replaceField(item, 'from');
        replaceField(item, 'to');
    }
    for (const item of result?.events || []) replaceList(item, 'participants');
    for (const item of result?.threads || []) replaceList(item, 'participants');
    for (const item of result?.backgrounds || []) replaceList(item, 'participants');
    if (result?.scene && typeof result.scene === 'object') replaceList(result.scene, 'participants');
    if (result?.sceneCapsule && typeof result.sceneCapsule === 'object') replaceList(result.sceneCapsule, 'participants');
    return changed;
}

function resolvedRelationshipPairIdentity(result, item, world = null) {
    const endpoints = [item?.from, item?.to]
        .map(value => normalized(resolvedReconciliationSubject(result, world, value)))
        .filter(Boolean)
        .sort();
    return endpoints.length === 2 ? endpoints.join('|') : '';
}

function continuityEntityIndex(result, world) {
    const entities = [];
    const byName = new Map();
    for (const item of [...(world?.entities || []), ...(result?.entities || [])]) {
        const name = cleanText(item?.name);
        if (!name) continue;
        const identity = normalized(name);
        const existing = byName.get(identity);
        if (existing) existing.aliases = [...new Set([...existing.aliases, ...(item.aliases || []).map(cleanText).filter(Boolean)])];
        else {
            const entity = { name, type: cleanText(item?.type), aliases: (item.aliases || []).map(cleanText).filter(Boolean) };
            byName.set(identity, entity);
            entities.push(entity);
        }
    }
    const variants = new Map();
    const titledFirstToken = /^(?:admiral|archivist|captain|chief|commander|darth|doctor|dr|emperor|empress|general|instructor|king|lady|lord|master|officer|pilot|prince|princess|professor|queen|seneschal|sergeant|sir|steward)$/iu;
    for (const entity of entities) {
        const candidates = [entity.name, ...entity.aliases];
        const parts = entity.name.split(/\s+/u).filter(Boolean);
        if (parts.length > 1 && !/[’']s\b/iu.test(entity.name)) {
            if (!titledFirstToken.test(parts[0])) candidates.push(parts[0]);
            candidates.push(parts.at(-1));
        }
        for (const candidate of candidates) {
            const variant = normalized(candidate);
            if (!variant) continue;
            const matches = variants.get(variant) || [];
            if (!matches.includes(entity)) matches.push(entity);
            variants.set(variant, matches);
        }
    }
    return { entities, variants };
}

function canonicalMention(index, value) {
    const source = normalized(value);
    if (!source) return null;
    const matches = [...index.variants.entries()]
        .filter(([variant, entities]) => entities.length === 1 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(variant)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(source))
        .sort((left, right) => right[0].length - left[0].length);
    return matches[0]?.[1]?.[0] || null;
}

function nearestCanonicalMention(index, value) {
    const source = normalized(value);
    if (!source) return null;
    const matches = [];
    for (const [variant, entities] of index.variants.entries()) {
        if (entities.length !== 1) continue;
        const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(variant)}(?=$|[^\\p{L}\\p{N}])`, 'giu');
        let found;
        while ((found = pattern.exec(source))) matches.push({ entity: entities[0], index: found.index, length: variant.length });
    }
    return matches.sort((left, right) => right.index - left.index || right.length - left.length)[0]?.entity || null;
}

function hasNonPossessiveEntityMention(entity, value) {
    const source = normalized(value);
    const name = cleanText(entity?.name);
    const parts = name.split(/\s+/u).filter(Boolean);
    const candidates = [name, ...(entity?.aliases || [])];
    if (parts.length > 1 && !/[’']s\b/iu.test(name)) {
        if (!/^(?:admiral|archivist|captain|chief|commander|darth|doctor|dr|emperor|empress|general|instructor|king|lady|lord|master|officer|pilot|prince|princess|professor|queen|seneschal|sergeant|sir|steward)$/iu.test(parts[0])) candidates.push(parts[0]);
        candidates.push(parts.at(-1));
    }
    return candidates.map(normalized).filter(Boolean).some(candidate =>
        new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(candidate)}(?!['’]s\\b)(?:$|[^\\p{L}\\p{N}])`, 'iu').test(source));
}

function hasKnowledgeRecord(result, world, holder, topic) {
    const subject = normalized(holder);
    const predicate = normalized(`knowledge of ${topic}`);
    return [...(result?.facts || []), ...(world?.facts || [])].some(item =>
        normalized(item?.subject) === subject && normalized(item?.predicate) === predicate);
}

export function recoverExplicitConcealmentBoundaries(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    let recovered = 0;
    for (const fact of [...result.facts]) {
        const predicate = cleanText(fact?.predicate);
        let topicText = '';
        let holderText = '';
        const directed = predicate.match(/\b(?:conceal|hide)\s+(.+?)\s+from\s+(.+)$/iu);
        const concealedFrom = predicate.match(/\b(?:concealment|secrecy|hidden)\s+from\s+(.+)$/iu);
        if (directed) {
            topicText = directed[1];
            holderText = directed[2];
        } else if (concealedFrom) {
            topicText = cleanText(fact.subject);
            holderText = concealedFrom[1];
        } else continue;
        const topic = canonicalMention(index, topicText)?.name || cleanText(topicText);
        const holder = canonicalMention(index, holderText)?.name || cleanText(holderText);
        if (!topic || !holder || normalized(topic) === normalized(holder) || hasKnowledgeRecord(result, world, holder, topic)) continue;
        result.facts.push({
            targetId: '',
            subject: holder,
            predicate: `knowledge of ${topic}`,
            value: `${topic} is deliberately concealed from ${holder}; no disclosure to ${holder} is established.`,
            category: 'knowledge boundary',
            importance: Math.max(3, Math.min(5, Number(fact.importance || 3))),
            persistence: 'persistent',
        });
        recovered++;
    }
    return recovered;
}

export function recoverExplicitPriorKnowledge(result, world, messages = null) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    const strings = [
        ...(result?.sceneCapsule?.beats || []),
        ...(result?.events || []).flatMap(item => [item?.summary, item?.consequences]),
        ...(messages || []).flatMap(message => String(message?.text ?? message?.mes ?? '')
            .split(/[\r\n]+|(?<=[.!?;])\s+/u)),
    ].map(cleanText).filter(Boolean);
    const knowledgeVerb = /\b(?:already\s+)?(?:knows?|knew|recognizes?|recognized|identifies?|identified|cites?|cited|recalls?|recalled|remembers?|remembered|acknowledges?|acknowledged)\b/iu;
    let recovered = 0;
    for (const source of strings) {
        const clauses = source.split(/\s+(?:while|whereas|but)\s+|(?<=[.!?;])\s+/iu).map(cleanText).filter(Boolean);
        for (const clause of clauses) {
            const verb = clause.match(knowledgeVerb);
            if (!verb || verb.index == null) continue;
            if (/\b(?:asks?|asked|wonders?|wondered|questions?|questioned)\s+(?:whether|if)\b/iu.test(clause.slice(0, verb.index))) continue;
            const actorWindow = clause.slice(Math.max(0, verb.index - 90), verb.index);
            const actor = nearestCanonicalMention(index, actorWindow);
            if (!actor || !/^(?:person|character|npc|human|individual)$/iu.test(actor.type || 'person')) continue;
            if (!hasNonPossessiveEntityMention(actor, actorWindow)) continue;
            const remainder = clause.slice(verb.index + verb[0].length);
            const topic = canonicalMention(index, remainder);
            if (!topic || !hasNonPossessiveEntityMention(topic, remainder)
                || normalized(topic.name) === normalized(actor.name)
                || hasKnowledgeRecord(result, world, actor.name, topic.name)) continue;
            const evidence = clause
                .replace(new RegExp(`^${escaped(actor.name.split(/\s+/u).at(-1))}\\b`, 'iu'), actor.name)
                .replace(/[,:;]+$/u, '');
            result.facts.push({
                targetId: '',
                subject: actor.name,
                predicate: `knowledge of ${topic.name}`,
                value: evidence,
                category: 'knowledge',
                importance: 4,
                persistence: 'persistent',
            });
            recovered++;

            // Factive narration such as “Alice knows Bob held a Council
            // seat” establishes both Alice's knowledge and the narrow role
            // proposition. Promote only explicit role/designation complements,
            // never beliefs, reports, accusations, or arbitrary biography.
            const roleAssertion = /\b(?:is|was|serves?|served|works?|worked|holds?|held)\b[^.!?;]{0,100}\b(?:master|mentor|teacher|captain|commander|leader|apprentice|student|padawan|member|council|seat|rank|title|office|position)\b/iu;
            const factive = /^(?:already\s+)?(?:knows?|knew|recognizes?|recognized|identifies?|identified)$/iu.test(cleanText(verb[0]));
            if (factive && roleAssertion.test(remainder)
                && !/\b(?:claims?|claimed|reports?|reported|alleges?|alleged|rumou?r|suspects?|suspected|believes?|believed)\b/iu.test(remainder)) {
                const roleValue = cleanText(remainder).replace(/[,:;]+$/u, '');
                const duplicateRole = [...(world?.facts || []), ...result.facts].some(item =>
                    normalized(item?.subject) === normalized(topic.name)
                    && normalized(item?.predicate) === 'established role or designation'
                    && coverageOverlap(item?.value, roleValue) >= 3);
                if (!duplicateRole) {
                    result.facts.push({
                        targetId: '', subject: topic.name, predicate: 'established role or designation',
                        value: roleValue, category: 'identity', importance: 5, persistence: 'persistent',
                    });
                    recovered++;
                }
            }
        }
    }
    return recovered;
}

function uniquePersonMention(index, world, value) {
    const direct = canonicalMention(index, value);
    if (personEntity(direct)) return direct;
    const wanted = normalized(value);
    if (!wanted) return null;
    const matches = index.entities.filter(personEntity).filter(entity =>
        [entity.name, ...(entity.aliases || [])].some(name => {
            const canonical = normalized(canonicalMemorySubject(world, name));
            const parts = normalized(name).split(/\s+/u).filter(Boolean);
            return canonical === wanted || parts.includes(wanted);
        }));
    return matches.length === 1 ? matches[0] : null;
}

// OOC identity constraints are authoritative world-state instructions, but
// they are epistemic constraints rather than part of an objective biography.
// Convert “No one knows I am X” into one holder-specific boundary per other
// present character so retrieval cannot grant knowledge merely because it can
// see X's canonical entity or aliases.
export function recoverExplicitOocIdentityBoundaries(result, world, messages) {
    if (!Array.isArray(result?.facts) || !Array.isArray(result?.threads)
        || !Array.isArray(messages) || !messages.length) return 0;
    const index = continuityEntityIndex(result, world);
    let recovered = 0;
    for (const message of messages) {
        const source = cleanText(message?.text ?? message?.mes);
        const ooc = source.match(/\bOOC\s*:\s*([\s\S]+)$/iu)?.[1] || '';
        if (!ooc) continue;
        const hidden = ooc.match(/\b(?:no\s+one|nobody)(?:\s+(?:here|present|in\s+the\s+scene))?\s+(?:knows?|recognizes?)\s+(?:that\s+)?(?:i\s+am|i['’]m|he\s+is|she\s+is|they\s+are)\s+([\p{L}\p{N}'’ -]{2,80}?)(?=[.!?;]|$)/iu);
        if (!hidden) continue;
        const speaker = uniquePersonMention(index, world, message?.name || message?.speaker);
        const canonical = uniquePersonMention(index, world, cleanText(hidden[1])) || speaker;
        if (!personEntity(canonical)) continue;
        const participants = [...new Set((result?.sceneCapsule?.participants || result?.scene?.participants || [])
            .map(value => uniquePersonMention(index, world, value))
            .filter(personEntity)
            .map(entity => entity.name))]
            .filter(name => normalized(name) !== normalized(canonical.name));
        for (const holder of participants) {
            const predicate = `knowledge of ${canonical.name}’s identity`;
            const already = [...(world?.facts || []), ...result.facts].some(fact =>
                normalized(fact?.subject) === normalized(holder)
                && normalized(fact?.predicate) === normalized(predicate));
            if (!already) {
                result.facts.push({
                    targetId: '', subject: holder, predicate,
                    value: `${holder} does not know that the current figure’s true identity is ${canonical.name}; the canonical memory label does not grant that knowledge.`,
                    category: 'knowledge boundary', importance: 5, persistence: 'persistent',
                });
                recovered++;
            }
            const threadExists = [...(world?.threads || []), ...result.threads].some(thread =>
                normalized(thread?.status) === 'open'
                && (thread?.participants || []).some(value => normalized(value) === normalized(holder))
                && (thread?.participants || []).some(value => normalized(value) === normalized(canonical.name))
                && /\b(?:identity|recogniz|true name|real name)\b/iu.test(`${thread?.title || ''} ${thread?.detail || ''}`));
            if (!threadExists) {
                result.threads.push({
                    targetId: '', title: `${holder} has not recognized ${canonical.name}’s identity`.slice(0, 160),
                    detail: `${holder} does not know that the current figure’s true identity is ${canonical.name}; this remains concealed despite the canonical memory label.`,
                    status: 'open', participants: [holder, canonical.name], importance: 5,
                });
                recovered++;
            }
        }

        // Keep the objective identity assertion, but remove the epistemic
        // rider that would otherwise become stale when a public alias or title
        // is learned later.
        for (const fact of result.facts) {
            if (normalized(fact?.subject) !== normalized(canonical.name)
                || !/\b(?:identity|name|alias|designation)\b/iu.test(`${fact?.predicate || ''} ${fact?.category || ''}`)) continue;
            const value = cleanText(fact.value);
            const split = value.match(/^(.{20,}?)(?:[,;]\s*)?\bbut\b[\s\S]*\b(?:no\s+one|nobody)\b[\s\S]*\b(?:knows?|recognizes?)\b[\s\S]*$/iu);
            if (split) fact.value = cleanText(split[1]).replace(/[,;:\s]+$/u, '');
        }

        for (const thread of result.threads) {
            if (normalized(thread?.status) !== 'resolved'
                || !(thread?.participants || []).some(value => normalized(value) === normalized(canonical.name))
                || !/\b(?:names?|identifies?)\s+(?:himself|herself|themself|themselves)\b/iu.test(cleanText(thread?.detail))) continue;
            thread.detail = `Resolved as to the historical former-apprentice name: ${canonical.name}. This resolution records the name only; separate character-knowledge boundaries govern recognition of the current figure.`;
        }
    }
    return recovered;
}

function normalizeObjectiveIdentityEpistemicRiders(result, world) {
    const boundaries = [...(world?.facts || []), ...(result?.facts || [])]
        .filter(fact => /knowledge boundary|knowledge gap/iu.test(cleanText(fact?.category)));
    let normalizedFacts = 0;
    for (const fact of result?.facts || []) {
        if (!/\b(?:identity|name|alias|designation)\b/iu.test(`${fact?.predicate || ''} ${fact?.category || ''}`)) continue;
        const subject = cleanText(fact?.subject);
        if (!subject || !boundaries.some(boundary =>
            new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(subject)}(?:$|[^\\p{L}\\p{N}])`, 'iu')
                .test(`${boundary?.predicate || ''} ${boundary?.value || ''}`))) continue;
        const value = cleanText(fact.value);
        const split = value.match(/^(.{20,}?)(?:[,;]\s*)?\bbut\b[\s\S]*\b(?:no\s+one|nobody)\b[\s\S]*\b(?:knows?|recognizes?)\b[\s\S]*$/iu);
        if (!split) continue;
        fact.value = cleanText(split[1]).replace(/[,;:\s]+$/u, '');
        normalizedFacts++;
    }
    return normalizedFacts;
}

const PERSON_IDENTITY_ROLE = '(?:master|mentor|teacher|captain|commander|leader|handler|apprentice|student|padawan|pupil|parent|mother|father|brother|sister)';
const PERSON_IDENTITY_SPECIALIZATION = '(?:[\\p{L}\\p{N}-]+\\s+){0,3}';
const DESCRIPTIVE_PERSON_IDENTITY = new RegExp(`^(.+?)[’']s\\s+((?:(?:former|dead|deceased|missing|unknown)\\s+)?${PERSON_IDENTITY_SPECIALIZATION}${PERSON_IDENTITY_ROLE})$`, 'iu');
const GENERIC_PERSON_IDENTITY = new RegExp(`^(?:(?:the|an?)\\s+)?((?:(?:unknown|unnamed|unidentified|mysterious|missing)\\s+)?(?:(?:former|previous|prior|lost|missing|dead|deceased)\\s+)?${PERSON_IDENTITY_SPECIALIZATION}(${PERSON_IDENTITY_ROLE}))(?:\\s+of\\s+(.+))?$`, 'iu');

function descriptivePersonIdentityContext(reference, world) {
    const possessive = cleanText(reference).match(DESCRIPTIVE_PERSON_IDENTITY);
    if (possessive) return { owner: cleanText(possessive[1]), role: cleanText(possessive[2]) };
    const generic = cleanText(reference).match(GENERIC_PERSON_IDENTITY);
    if (!generic) return null;
    const qualified = /\b(?:unknown|unnamed|unidentified|mysterious|missing|former|previous|prior|lost|dead|deceased)\b/iu.test(generic[1]);
    if (!qualified) return null;
    const relationshipOwners = (world?.relationships || []).flatMap(item => {
        if (normalized(item?.from) === normalized(reference)) return [cleanText(item?.to)];
        if (normalized(item?.to) === normalized(reference)) return [cleanText(item?.from)];
        return [];
    }).filter(Boolean);
    const owners = [...new Set([cleanText(generic[3]), ...relationshipOwners].filter(Boolean))];
    if (owners.length !== 1) return null;
    return { owner: owners[0], role: cleanText(generic[1]) };
}

function exactDescriptiveIdentityRelationshipAnchor(world, reference, canonical, owner) {
    const touches = (item, left, right) => {
        const endpoints = [normalized(item?.from), normalized(item?.to)];
        return endpoints.includes(normalized(left)) && endpoints.includes(normalized(right));
    };
    const referenceRelationships = (world?.relationships || []).filter(item => touches(item, owner, reference));
    const canonicalRelationships = (world?.relationships || []).filter(item => touches(item, owner, canonical));
    return referenceRelationships.some(referenceRelationship => canonicalRelationships.some(canonicalRelationship =>
        normalized(referenceRelationship?.kind) === normalized(canonicalRelationship?.kind)
        && normalized(referenceRelationship?.status) === normalized(canonicalRelationship?.status)));
}

function sourceSupportsNamedIdentity(messages, owner, role, canonical, aliases = [], ownerAliases = []) {
    const candidates = [...new Set([canonical, ...aliases].map(cleanText).filter(Boolean))];
    const owners = [...new Set([owner, ...ownerAliases].map(cleanText).filter(Boolean))];
    const roleWord = escaped(String(role || '').split(/\s+/u).at(-1));
    const ownerPossessive = owners.map(name => `${escaped(name)}[’']s`).join('|');
    const relationshipDeterminer = ownerPossessive
        ? `(?:the|my|her|his|their|${ownerPossessive})`
        : '(?:the|my|her|his|their)';
    return (messages || []).some((message, index, all) => {
        const text = cleanText(message?.text ?? message?.mes);
        const speaker = cleanText(message?.name || message?.speaker);
        const previous = cleanText(all[index - 1]?.text ?? all[index - 1]?.mes);
        const window = `${previous} ${text}`;
        const hasRoleApposition = candidates.some(name => {
            const candidate = escaped(name);
            return new RegExp(`(?:^|[.!?;:]\\s*)[“\"']?(?:[\\p{L}\\p{N}-]+\\s+){0,3}${roleWord}\\s+${candidate}(?:$|[.!?,:;”\"'])|(?:^|[.!?;:]\\s*)[“\"']?${candidate}\\s*,?\\s+(?:the\\s+|my\\s+|her\\s+|his\\s+|their\\s+)?(?:former\\s+)?(?:[\\p{L}\\p{N}-]+\\s+){0,3}${roleWord}(?:$|[.!?,:;”\"'])`, 'iu').test(text);
        });
        if (!text || (COVERAGE_NON_ASSERTION.test(window) && !hasRoleApposition)) return false;
        const ownerPresent = !owners.length || owners.some(name => normalized(speaker) === normalized(name)
            || new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(window));
        if (!ownerPresent) return false;
        return candidates.some(name => {
            const candidate = escaped(name);
            const speculative = new RegExp(`(?:might|maybe|possibly|perhaps|suspects?|wonders?|whether)[^.!?]{0,100}${candidate}|${candidate}[^.!?]{0,100}(?:might|maybe|possibly|perhaps|suspects?|wonders?|whether)`, 'iu');
            if (speculative.test(window)) return false;
            const explicit = new RegExp(`(?:answers?|answered|reveals?|revealed|identifies?|identified|names?|named|known as)[^.!?]{0,140}${candidate}|(?:${roleWord})[^.!?]{0,100}(?:(?:is|was)\\s+(?:named|called)|is|was|named|called)\\s+(?:as\\s+)?${candidate}|${candidate}[^.!?]{0,100}(?:is|was)\\s+(?:${relationshipDeterminer}\\s+)?(?:former\\s+)?(?:[\\p{L}\\p{N}-]+\\s+){0,3}${roleWord}`, 'iu');
            // Identity answers are often appositions rather than complete
            // sentences: “Caelen Veyr. Jedi Master Caelen Veyr.” Treat an
            // explicit role immediately beside the canonical name as the
            // same evidence as “Caelen Veyr was my Jedi Master.”
            const roleApposition = new RegExp(`(?:^|[.!?;:]\\s*)[“\"']?(?:[\\p{L}\\p{N}-]+\\s+){0,3}${roleWord}\\s+${candidate}(?:$|[.!?,:;”\"'])|(?:^|[.!?;:]\\s*)[“\"']?${candidate}\\s*,?\\s+(?:the\\s+|my\\s+|her\\s+|his\\s+|their\\s+)?(?:former\\s+)?(?:[\\p{L}\\p{N}-]+\\s+){0,3}${roleWord}(?:$|[.!?,:;”\"'])`, 'iu');
            const requested = new RegExp(`\\b(?:name|identify|identity|who)\\b[^.!?]{0,100}\\b${roleWord}\\b|\\b${roleWord}\\b[^.!?]{0,100}\\b(?:name|identify|identity|who)\\b`, 'iu');
            const answered = requested.test(previous)
                && new RegExp(`^[“\"']?${candidate}(?:[.!?,:”\"']|\\s|$)`, 'iu').test(text);
            return explicit.test(text) || roleApposition.test(text) || answered;
        });
    });
}

export function recoverExplicitNamedIdentityResolutions(result, world, messages) {
    if (!Array.isArray(result?.identityResolutions) || !Array.isArray(result?.sceneCapsule?.beats)
        || !Array.isArray(messages) || !messages.length) return 0;
    const existing = [...(world?.entities || [])];
    const incoming = [...(result?.entities || [])];
    const references = new Map();
    for (const entity of existing) {
        if (!entityIsPersonLike(entity?.type)) continue;
        const reference = cleanText(entity?.name);
        if (reference) references.set(normalized(reference), reference);
    }
    for (const relationship of world?.relationships || []) {
        for (const value of [relationship?.from, relationship?.to]) {
            const reference = cleanText(value);
            if (reference) references.set(normalized(reference), reference);
        }
    }
    let recovered = 0;
    for (const reference of references.values()) {
        const descriptor = descriptivePersonIdentityContext(reference, world);
        if (!descriptor) continue;
        const owner = descriptor.owner;
        const role = descriptor.role;
        const roleWord = String(role || '').split(/\s+/u).at(-1);
        const beatContext = result.sceneCapsule.beats.map(cleanText).join(' ');
        const ownerEntity = [...existing, ...incoming].find(entity => [entity?.name, ...(entity?.aliases || [])]
            .some(name => normalized(name) === normalized(owner)));
        const ownerNames = [...new Set([owner, ...(ownerEntity?.aliases || [])].map(cleanText).filter(Boolean))];
        const referenceRelationships = (world?.relationships || []).filter(item =>
            [item?.from, item?.to].some(value => normalized(value) === normalized(reference))
            && [item?.from, item?.to].some(value => normalized(value) === normalized(owner)));
        const anchoredNames = [...new Set((world?.relationships || []).flatMap(item => {
            if (![item?.from, item?.to].some(value => normalized(value) === normalized(owner))) return [];
            const other = normalized(item?.from) === normalized(owner) ? cleanText(item?.to) : cleanText(item?.from);
            if (!other || normalized(other) === normalized(reference)) return [];
            const roleCompatible = referenceRelationships.some(stored =>
                normalized(stored?.kind) === normalized(item?.kind)
                && normalized(stored?.status) === normalized(item?.status));
            const entity = [...existing, ...incoming].find(candidate => entityIsPersonLike(candidate?.type)
                && [candidate?.name, ...(candidate?.aliases || [])].some(value => normalized(value) === normalized(other)));
            return roleCompatible && entity ? [cleanText(entity.name)] : [];
        }))];
        if (referenceRelationships.length && anchoredNames.length === 1) {
            const canonical = anchoredNames[0];
            const duplicate = result.identityResolutions.some(item => normalized(item?.reference) === normalized(reference));
            if (!duplicate) {
                result.identityResolutions.push({
                    reference, canonical,
                    evidence: `Stable relationship continuity identifies ${reference} as ${canonical}.`,
                });
                recovered++;
            }
            continue;
        }
        const ownerMentioned = ownerNames.some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(beatContext));
        const roleMentioned = new RegExp(`\\b${escaped(roleWord)}\\b`, 'iu').test(`${beatContext} ${reference}`);
        if (!ownerMentioned || !roleMentioned) continue;
        const directlyNamed = incoming.filter(entity => entityIsPersonLike(entity?.type)
            && normalized(entity?.name) !== normalized(owner)
            && normalized(entity?.name) !== normalized(reference)
            && sourceSupportsNamedIdentity(messages, owner, role, entity.name, entity.aliases, ownerEntity?.aliases));
        const hasExplicitIdentityBeat = result.sceneCapsule.beats.some(rawBeat => {
            const beat = cleanText(rawBeat);
            return beat && !COVERAGE_NON_ASSERTION.test(beat)
                && !/\b(?:might|maybe|possibly|perhaps|suspects?|wonders?|whether)\b/iu.test(beat)
                && /\b(?:identity|identifies?|identified|true name|real name|names?|named|called|known as)\b/iu.test(beat)
                && directlyNamed.some(entity => textMentionsIdentityVariant(beat, [entity.name, ...(entity.aliases || [])]));
        });
        if (directlyNamed.length === 1 && !hasExplicitIdentityBeat) {
            const canonical = cleanText(directlyNamed[0].name);
            const duplicate = result.identityResolutions.some(item => normalized(item?.reference) === normalized(reference)
                || (normalized(item?.reference) === normalized(canonical) && normalized(item?.canonical) === normalized(reference)));
            if (!duplicate) {
                result.identityResolutions.push({
                    reference, canonical,
                    evidence: `${owner} explicitly names ${canonical} as ${owner}'s ${role}.`,
                });
                recovered++;
            }
            continue;
        }
        for (const rawBeat of result.sceneCapsule.beats) {
            const beat = cleanText(rawBeat);
            if (!beat || COVERAGE_NON_ASSERTION.test(beat)
                || /\b(?:might|maybe|possibly|perhaps|suspects?|wonders?|whether)\b/iu.test(beat)
                || !/\b(?:identity|identifies?|identified|true name|real name|names?|named|called|known as)\b/iu.test(beat)) continue;
            const beatOwnerMentioned = ownerNames.some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(beat));
            const beatRoleMentioned = new RegExp(`\\b${escaped(roleWord)}\\b`, 'iu').test(beat);
            if (!beatOwnerMentioned && !beatRoleMentioned) continue;
            const candidates = incoming.filter(entity => entityIsPersonLike(entity?.type)
                && normalized(entity?.name) !== normalized(owner)
                && normalized(entity?.name) !== normalized(reference)
                && [entity?.name, ...(entity?.aliases || [])].some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(beat)));
            if (candidates.length !== 1) continue;
            const canonical = cleanText(candidates[0].name);
            if (!sourceSupportsNamedIdentity(messages, owner, role, canonical, candidates[0].aliases, ownerEntity?.aliases)) continue;
            const duplicate = result.identityResolutions.some(item => normalized(item?.reference) === normalized(reference)
                || (normalized(item?.reference) === normalized(canonical) && normalized(item?.canonical) === normalized(reference)));
            if (duplicate) continue;
            result.identityResolutions.push({ reference, canonical, evidence: beat });
            recovered++;
            break;
        }
    }
    return recovered;
}

const COVERAGE_STOP_WORDS = new Set('a an and are as at be been being but by for from had has have he her hers him his i in into is it its of on or our she that the their them they this to was were will with you your'.split(' '));
const COVERAGE_NON_ASSERTION = /\b(?:asks?|asked|questions?|questioned|wonders?|wondered)\s+(?:whether|if)\b/iu;
const COVERAGE_COMMITMENT = /\b(?:agrees?|agreed|decides?|decided|intends?|intended|plans?|planned|promises?|promised|vows?|vowed)\b\s+(?:to|that|for)\b/iu;
const DIRECT_FUTURE_COMMITMENT = /\b(?:i|we)(?:\s+[\p{L}\p{N}'’-]+){0,4}?\s*(?:['’]ll|\b(?:will|shall|am going to|are going to)\b)\s+([^.!?\n]{2,220})/iu;
const DIRECT_FUTURE_ANCHOR = /\b(?:tomorrow|later|next\s+(?:day|morning|afternoon|evening|night|week|month|year)|eventually|after(?:ward|wards)?|after\s+|before\s+|once\s+|when\s+|upon\s+|in\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:minute|hour|day|week|month|year)s?)\b/iu;
const COVERAGE_RELATIONSHIP = /\b(?:becomes?|became|remain(?:s|ed)?|are|were)\s+(?:close\s+)?(friends?|allies|enemies|rivals|partners|lovers|spouses?|mentor(?:s)?|students?|masters?|apprentices?)\b/iu;
const COVERAGE_DESIGNATION = /\b(?:(?:was|is|were|are|has been|had been)\s+(?:officially\s+)?(?:named|called|appointed)|(?:serves?|served|works?|worked)\s+as|(?:holds?|held)\s+(?:the\s+)?(?:rank|title|office|position))\b/iu;
const COVERAGE_REMAINING_STATE = /\b(?:remains?|remained)\b/iu;
const COVERAGE_LIMITATION = /\b(?:cannot|can't|unable|vulnerab(?:le|ility)|weak(?:ness)?|susceptible|struggles?|struggled|difficulty|limitation|late (?:response|reaction)|slow (?:response|reaction)|fails?|failed)\b/iu;
const COVERAGE_CAPABILITY = /\b(?:can|able|capable|proficient|skilled|trained|demonstrates?|demonstrated|blocks?|blocked|resists?|resisted|performs?|performed|knows? how)\b/iu;
const COVERAGE_CUE_FAMILIES = [
    ['agree', /\b(?:agree|agrees|agreed|agreeing)\b/iu],
    ['appoint', /\b(?:appoint|appoints|appointed|appointing)\b/iu],
    ['assign', /\b(?:assign|assigns|assigned|assigning)\b/iu],
    ['become', /\b(?:become|becomes|became|becoming)\b/iu],
    ['call', /\b(?:call|calls|called|calling)\b/iu],
    ['decide', /\b(?:decide|decides|decided|deciding)\b/iu],
    ['discover', /\b(?:discover|discovers|discovered|discovering)\b/iu],
    ['injure', /\b(?:injure|injures|injured|injuring)\b/iu],
    ['intend', /\b(?:intend|intends|intended|intending)\b/iu],
    ['learn', /\b(?:learns|learned|learnt)\b/iu],
    ['lose', /\b(?:lose|loses|lost|losing)\b/iu],
    ['name', /\b(?:name|names|named|naming)\b/iu],
    ['plan', /\b(?:plan|plans|planned|planning)\b/iu],
    ['promise', /\b(?:promise|promises|promised|promising)\b/iu],
    ['receive', /\b(?:receive|receives|received|receiving)\b/iu],
    ['remain', /\b(?:remain|remains|remained|remaining)\b/iu],
    ['reveal', /\b(?:reveal|reveals|revealed|revealing)\b/iu],
    ['serve', /\b(?:serve|serves|served|serving)\b/iu],
    ['suffer', /\b(?:suffer|suffers|suffered|suffering)\b/iu],
    ['vow', /\b(?:vow|vows|vowed|vowing)\b/iu],
    ['wound', /\b(?:wound|wounds|wounded|wounding)\b/iu],
    ['work', /\b(?:work|works|worked|working)\b/iu],
    ['hold', /\b(?:hold|holds|held|holding)\b/iu],
    ['answer', /\b(?:answer|answers|answered|answering)\b/iu],
    ['block', /\b(?:block|blocks|blocked|blocking)\b/iu],
    ['demonstrate', /\b(?:demonstrate|demonstrates|demonstrated|demonstrating)\b/iu],
    ['fail', /\b(?:fail|fails|failed|failing)\b/iu],
    ['struggle', /\b(?:struggle|struggles|struggled|struggling)\b/iu],
];

function coverageTerms(value) {
    return new Set((String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [])
        .map(term => term.replace(/[’']s$/u, ''))
        .filter(term => term.length > 1 && !COVERAGE_STOP_WORDS.has(term)));
}

function coverageOverlap(left, right) {
    const rightTerms = coverageTerms(right);
    let matches = 0;
    for (const term of coverageTerms(left)) if (rightTerms.has(term)) matches++;
    return matches;
}

function coverageCueFamily(value) {
    return COVERAGE_CUE_FAMILIES.find(([, pattern]) => pattern.test(String(value || ''))) || null;
}

function coverageParticipantNames(result, world, messages, beat) {
    const candidates = new Map();
    for (const entity of [...(world?.entities || []), ...(result?.entities || [])]) {
        const name = cleanText(entity?.name);
        if (!name) continue;
        const forms = [name, ...(entity?.aliases || [])].map(cleanText).filter(Boolean);
        const indexes = forms.map(form => {
            const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(form)}(?:$|[^\\p{L}\\p{N}])`, 'iu').exec(beat);
            return match?.index ?? -1;
        }).filter(index => index >= 0);
        if (indexes.length) candidates.set(normalized(name), { name, index: Math.min(...indexes) });
    }
    for (const message of messages || []) {
        const name = cleanText(message?.name || message?.speaker);
        if (!name || candidates.has(normalized(name))) continue;
        const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').exec(beat);
        if (match) candidates.set(normalized(name), { name, index: match.index });
    }
    return [...candidates.values()].sort((left, right) => left.index - right.index).map(item => item.name);
}

function coverageActionWord(value, cuePattern) {
    const source = String(value || '');
    const match = cuePattern.exec(source);
    if (!match) return '';
    return (source.slice(match.index + match[0].length).toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [])
        .find(word => !COVERAGE_STOP_WORDS.has(word)) || '';
}

function sourceSupportsCoverageBeat(beat, messages, participants, cuePattern) {
    const beatTerms = coverageTerms(beat);
    const beatAction = coverageActionWord(beat, cuePattern);
    return (messages || []).some(message => {
        const messageText = cleanText(message?.text ?? message?.mes);
        const speaker = cleanText(message?.name || message?.speaker);
        const source = `${speaker}: ${messageText}`;
        if (!messageText || !cuePattern.test(source)) return false;
        const threshold = Math.max(3, Math.min(5, Math.ceil(beatTerms.size * 0.45)));
        if (coverageOverlap(beat, source) < threshold) return false;
        if (participants.length && !participants.some(name => normalized(name) === normalized(speaker)
            || new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(messageText))) return false;
        const sourceAction = coverageActionWord(source, cuePattern);
        return !beatAction || !sourceAction || normalized(beatAction) === normalized(sourceAction);
    });
}

function sourceSupportsDescriptiveCoverageBeat(beat, messages, participants, kindPattern) {
    const beatTerms = coverageTerms(beat);
    const threshold = Math.max(4, Math.min(6, Math.ceil(beatTerms.size * 0.4)));
    return (messages || []).some(message => {
        const messageText = cleanText(message?.text ?? message?.mes);
        const speaker = cleanText(message?.name || message?.speaker);
        const source = `${speaker}: ${messageText}`;
        if (!messageText || COVERAGE_NON_ASSERTION.test(source) || !kindPattern.test(source)) return false;
        if (coverageOverlap(beat, source) < threshold) return false;
        return !participants.length || participants.some(name => normalized(name) === normalized(speaker)
            || new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(messageText));
    });
}

function descriptiveCoveragePredicate(beat, participant, limitation) {
    const participantTerms = coverageTerms(participant);
    const generic = new Set([
        ...COVERAGE_STOP_WORDS,
        'able', 'attack', 'attacks', 'block', 'blocks', 'blocked', 'can', 'capable', 'demonstrate', 'demonstrates',
        'demonstrated', 'difficulty', 'fail', 'fails', 'failed', 'limitation', 'performed', 'performs', 'recurring',
        'response', 'reveal', 'reveals', 'revealed', 'series', 'skilled', 'struggle', 'struggles', 'struggled',
        'trained', 'vulnerable', 'vulnerability', 'weak', 'weakness',
    ]);
    const terms = [...coverageTerms(beat)].filter(term => !participantTerms.has(term) && !generic.has(term)).slice(0, 5);
    const base = limitation ? 'observed limitation' : 'demonstrated capability';
    return terms.length ? `${base} — ${terms.join(' ')}` : base;
}

function structuredCoverageRecords(result) {
    return ['facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']
        .flatMap(key => Array.isArray(result?.[key]) ? result[key] : [])
        .map(item => JSON.stringify(item));
}

function futureCommitmentFromMessage(message) {
    const source = cleanText(message?.text ?? message?.mes);
    const speaker = cleanText(message?.name || message?.speaker);
    if (!source || !speaker || COVERAGE_NON_ASSERTION.test(source)) return null;
    const match = DIRECT_FUTURE_COMMITMENT.exec(source);
    if (!match || !DIRECT_FUTURE_ANCHOR.test(match[0])) return null;
    if (/\b(?:might|maybe|possibly|perhaps|would|could)\b/iu.test(match[0])) return null;
    let action = cleanText(match[1]).replace(/,\s+(?:he|she|they|it|i|we)\b.*$/iu, '').trim();
    if (!action || /^(?:not\s+)?(?:know|think|wonder|ask)\b/iu.test(action)) return null;
    action = action.replace(/^be going\b/iu, 'go');
    const title = `${speaker} will ${action}`.slice(0, 160);
    return { title, detail: `${speaker} explicitly commits: ${match[0].trim()}`.slice(0, 800) };
}

export function recoverExplicitFutureCommitments(result, world, messages) {
    if (!Array.isArray(result?.threads) || !Array.isArray(messages)) return 0;
    let recovered = 0;
    for (const message of messages) {
        const commitment = futureCommitmentFromMessage(message);
        if (!commitment) continue;
        const candidates = [...(world?.threads || []), ...(result.threads || [])].filter(item => item?.status === 'open');
        const terms = coverageTerms(`${commitment.title} ${commitment.detail}`);
        const threshold = terms.size >= 6 ? 3 : 2;
        if (candidates.some(item => coverageOverlap(`${commitment.title} ${commitment.detail}`, `${item.title || ''} ${item.detail || ''}`) >= threshold)) continue;
        const speaker = cleanText(message?.name || message?.speaker);
        const participants = [...new Set([
            speaker,
            ...coverageParticipantNames(result, world, messages, `${speaker} ${commitment.title} ${commitment.detail}`),
        ].filter(Boolean))];
        result.threads.push({
            targetId: '', title: commitment.title, detail: commitment.detail,
            status: 'open', participants, importance: 4,
        });
        recovered++;
    }
    return recovered;
}

const EXPLICIT_RELATIONSHIP_FACT_ROLE = /\b(?:apprenticeship|apprentice|student|padawan|pupil|prot[eé]g[eé]|mentor|mentee|teacher|instructor|parent|mother|father|child|son|daughter|sibling|brother|sister|spouse|husband|wife|married|friend|ally|rival|enemy|attendant|retainer|servant|employer|employee|commander|subordinate|teammate|partner|captor|captive|prisoner|guardian|ward)\b/iu;
const NON_CANONICAL_RELATIONSHIP_FACT = /\b(?:belief|claim|allegation|rumou?r|speculation|suspicion|intention|possibility|possible|possibly|perhaps|maybe|might|may be|whether|uncertain|unconfirmed|disputed|according to)\b/iu;

function personEntity(entity) {
    return Boolean(entity && cleanText(entity?.name) && entityIsPersonLike(entity?.type));
}

function explicitlyMentionedPeople(index, value) {
    const source = cleanText(value);
    if (!source) return [];
    return index.entities.filter(personEntity).filter(entity => {
        const variants = [entity.name, ...(entity.aliases || [])].map(cleanText).filter(Boolean);
        return variants.some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(source));
    });
}

function relationshipEvidenceMentionsPerson(person, value) {
    const source = cleanText(value);
    return [person?.name, ...(person?.aliases || [])].map(cleanText).filter(Boolean)
        .some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(source));
}

function relationshipFactIsCorroborated(result, messages, people) {
    const supported = value => {
        const source = cleanText(value);
        return EXPLICIT_RELATIONSHIP_FACT_ROLE.test(source)
            && !NON_CANONICAL_RELATIONSHIP_FACT.test(source)
            && people.every(person => relationshipEvidenceMentionsPerson(person, source));
    };
    if (Array.isArray(messages) && messages.length) {
        const rendered = message => message
            ? `${cleanText(message?.name || message?.speaker)}: ${cleanText(message?.text ?? message?.mes)}`
            : '';
        if (messages.some(message => supported(rendered(message)))) return true;
        const bySpeaker = new Map();
        for (const message of messages) {
            const speaker = normalized(message?.name || message?.speaker);
            if (!speaker) continue;
            bySpeaker.set(speaker, [...(bySpeaker.get(speaker) || []), rendered(message)]);
        }
        if ([...bySpeaker.values()].some(items => supported(items.join(' ')))) return true;
        if (messages.some((message, index, all) => supported([
            rendered(all[index - 1]), rendered(message), rendered(all[index + 1]),
        ].filter(Boolean).join(' ')))) return true;
        return narrativeStrings(result).some(supported);
    }
    return narrativeStrings(result).some(supported);
}

function relationshipKindFromFact(value) {
    const source = cleanText(value);
    if (/\b(?:padawan)\b/iu.test(source)) return 'Jedi master and Padawan';
    if (/\b(?:apprenticeship|apprentice)\b/iu.test(source)) return 'master and apprentice';
    if (/\b(?:student|pupil|teacher|instructor)\b/iu.test(source)) return 'teacher and student';
    if (/\b(?:mentor|mentee|prot[eé]g[eé])\b/iu.test(source)) return 'mentor and protégé';
    if (/\b(?:parent|mother|father|child|son|daughter)\b/iu.test(source)) return 'parent and child';
    if (/\b(?:sibling|brother|sister)\b/iu.test(source)) return 'siblings';
    if (/\b(?:spouse|husband|wife|married)\b/iu.test(source)) return 'spouses';
    if (/\b(?:friend)\b/iu.test(source)) return 'friends';
    if (/\b(?:ally)\b/iu.test(source)) return 'allies';
    if (/\b(?:rival)\b/iu.test(source)) return 'rivals';
    if (/\b(?:enemy)\b/iu.test(source)) return 'enemies';
    if (/\b(?:captor|captive|prisoner)\b/iu.test(source)) return 'captor and captive';
    if (/\b(?:attendant|retainer|servant)\b/iu.test(source)) return 'principal and retainer';
    if (/\b(?:employer|employee)\b/iu.test(source)) return 'employer and employee';
    if (/\b(?:commander|subordinate)\b/iu.test(source)) return 'commander and subordinate';
    if (/\b(?:teammate)\b/iu.test(source)) return 'teammates';
    if (/\b(?:guardian|ward)\b/iu.test(source)) return 'guardian and ward';
    return 'established personal relationship';
}

function relationshipDescriptionFromFact(fact, people) {
    const value = relationshipAssertionCore(fact);
    const namesPresent = people.every(person => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(person.name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(value));
    return namesPresent ? value : `${people[0].name} and ${people[1].name}: ${value}`;
}

function repairRelationshipPairDescriptionContamination(result, world) {
    if (!Array.isArray(result?.relationships) || !Array.isArray(world?.relationships)) return 0;
    const index = continuityEntityIndex(result, world);
    const storedById = new Map(world.relationships.map(item => [normalized(item?.id), item]).filter(([id]) => id));
    let repaired = 0;
    for (const relationship of result.relationships) {
        const stored = storedById.get(normalized(relationship?.targetId));
        const dynamic = cleanText(relationship?.dynamic);
        if (!stored || !EXPLICIT_RELATIONSHIP_FACT_ROLE.test(dynamic)) continue;
        const asserted = explicitlyMentionedPeople(index, relationshipAssertionCore({ value: dynamic }));
        const endpoints = [relationship?.from, relationship?.to].map(value => canonicalMention(index, value)).filter(Boolean);
        if (asserted.length !== 2 || endpoints.length !== 2
            || endpoints.every(endpoint => asserted.some(person => normalized(person.name) === normalized(endpoint.name)))) continue;
        relationship.dynamic = cleanText(stored.dynamic);
        repaired++;
    }
    return repaired;
}

function relationshipAssertionCore(fact) {
    const value = cleanText(fact?.value);
    const first = value.split(/\s+(?:but|however|although|while)\s+/iu)[0];
    return (EXPLICIT_RELATIONSHIP_FACT_ROLE.test(first) ? first : value).replace(/[,;:\s]+$/u, '');
}

export function recoverExplicitFactRelationships(result, world, messages = null) {
    if (!Array.isArray(result?.facts) || !Array.isArray(result?.relationships)) return 0;
    const index = continuityEntityIndex(result, world);
    let recovered = 0;
    for (const fact of result.facts) {
        const predicate = cleanText(fact?.predicate);
        const category = cleanText(fact?.category);
        const value = cleanText(fact?.value);
        const core = relationshipAssertionCore(fact);
        const evidence = `${predicate}. ${value}`;
        if (!value || /^(?:knowledge boundary|knowledge gap)$/iu.test(category)
            || !EXPLICIT_RELATIONSHIP_FACT_ROLE.test(evidence)
            || NON_CANONICAL_RELATIONSHIP_FACT.test(`${predicate} ${category}`)
            || NON_CANONICAL_RELATIONSHIP_FACT.test(value)
            || normalized(fact?.persistence) === 'temporary') continue;
        const subject = canonicalMention(index, fact?.subject);
        const mentioned = explicitlyMentionedPeople(index, core);
        const people = [...new Map([subject, ...mentioned].filter(personEntity).map(person => [normalized(person.name), person])).values()];
        if (people.length !== 2 || !relationshipFactIsCorroborated(result, messages, people)) continue;
        const candidate = { from: people[0].name, to: people[1].name };
        const pairIdentity = resolvedRelationshipPairIdentity(result, candidate, { ...(world || {}), entities: index.entities });
        if (!pairIdentity || result.relationships.some(item => resolvedRelationshipPairIdentity(result, item, world) === pairIdentity)) continue;
        const stored = (world?.relationships || []).find(item => resolvedRelationshipPairIdentity(result, item, world) === pairIdentity);
        if (stored && /^knowledge$/iu.test(category)) continue;
        const migratedByIdentity = stored && (result?.identityResolutions || []).some(resolution =>
            [stored?.from, stored?.to].some(endpoint => normalized(endpoint) === normalized(resolution?.reference))
            && [candidate.from, candidate.to].some(endpoint => normalized(endpoint) === normalized(resolution?.canonical)));
        if (migratedByIdentity) continue;
        const description = relationshipDescriptionFromFact(fact, people);
        const priorDescription = cleanText(stored?.dynamic);
        const dynamic = priorDescription && coverageOverlap(priorDescription, description) < 3
            ? `${priorDescription} ${description}`.slice(0, 1200)
            : description;
        result.relationships.push({
            targetId: cleanText(stored?.id),
            from: cleanText(stored?.from) || people[0].name,
            to: cleanText(stored?.to) || people[1].name,
            kind: cleanText(stored?.kind) || relationshipKindFromFact(evidence),
            status: cleanText(stored?.status) || (/\b(?:former|previous|prior|ex-|ended|deceased|dead|late)\b/iu.test(evidence) ? 'ended' : 'active'),
            dynamic,
            importance: Math.max(3, Math.min(5, Number(fact?.importance || stored?.importance || 3))),
        });
        recovered++;
    }
    return recovered;
}

const HISTORICAL_MENTOR_RELATIONSHIP = /\b(?:master|mentor|teacher|instructor)\b[^.!?;]{0,80}\b(?:apprentice|padawan|student|pupil|prot[eé]g[eé])\b|\b(?:apprentice|padawan|student|pupil|prot[eé]g[eé])\b[^.!?;]{0,80}\b(?:master|mentor|teacher|instructor)\b/iu;
const HISTORICAL_RELATIONSHIP_SIGNAL = /\b(?:former|previous|prior|once|formerly|trained|mentored|taught|before)\b/iu;

function relationshipHistoryFact(result, world, relationship) {
    const index = continuityEntityIndex(result, world);
    const endpoints = [relationship?.from, relationship?.to].map(value => canonicalMention(index, value));
    if (!endpoints.every(personEntity)) return null;
    const facts = [...(world?.facts || []), ...(result?.facts || [])];
    const fact = facts.find(item => {
        const evidence = `${cleanText(item?.subject)} ${cleanText(item?.predicate)} ${relationshipAssertionCore(item)}`;
        const mentioned = explicitlyMentionedPeople(index, evidence);
        return /\b(?:apprentice|padawan|student|pupil|prot[eé]g[eé]|mentee)\b/iu.test(evidence)
            && HISTORICAL_RELATIONSHIP_SIGNAL.test(evidence)
            && !NON_CANONICAL_RELATIONSHIP_FACT.test(`${cleanText(item?.predicate)} ${cleanText(item?.category)}`)
            && mentioned.length === 2
            && endpoints.every(entity => mentioned.some(person => normalized(person.name) === normalized(entity.name)));
    });
    return fact ? { fact, endpoints } : null;
}

export function reconcileHistoricalRelationshipLifecycles(result, world) {
    if (!Array.isArray(result?.relationships)) return 0;
    let reconciled = 0;
    for (const relationship of result.relationships) {
        if (!HISTORICAL_MENTOR_RELATIONSHIP.test(cleanText(relationship?.kind))) continue;
        const history = relationshipHistoryFact(result, world, relationship);
        if (!history) continue;
        if (/\b(?:ended|former|deceased|dead|resolved|complete)\b/iu.test(cleanText(relationship?.status))) continue;
        const evidence = `${cleanText(history.fact?.predicate)} ${cleanText(history.fact?.value)}`;
        const deadEndpoint = history.endpoints.some(entity => entityIsEstablishedDead(entity, result, world));
        if (!deadEndpoint && !HISTORICAL_RELATIONSHIP_SIGNAL.test(evidence)) continue;
        const kind = cleanText(relationship.kind);
        if (!/^former\b/iu.test(kind)) relationship.kind = `former ${kind}`;
        relationship.status = 'ended';
        relationship.dynamic = relationshipDescriptionFromFact(history.fact, history.endpoints);
        reconciled++;
    }
    return reconciled;
}

export function recoverExplicitIdentityBoundaryThreads(result, world) {
    if (!Array.isArray(result?.facts) || !Array.isArray(result?.threads)) return 0;
    const index = continuityEntityIndex(result, world);
    let recovered = 0;
    for (const fact of result.facts) {
        const value = cleanText(fact?.value);
        const match = value.match(/\b(?:but|however|although|while)\b\s*([^.;]{1,120}?)\s+does not know that\s+([^.;]{1,160})/iu)
            || value.match(/^([^.;]{1,120}?)\s+does not know that\s+([^.;]{1,160})/iu);
        if (!match) continue;
        const holder = explicitlyMentionedPeople(index, cleanText(match[1])).at(-1);
        const identity = explicitlyMentionedPeople(index, cleanText(match[2]))[0];
        if (!holder || !identity || normalized(holder.name) === normalized(identity.name)
            || !/\b(?:identity|true identity|real identity|true name|real name|is the|is a|is an)\b/iu.test(match[2])) continue;
        const participants = [holder.name, identity.name];
        const identityName = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(identity.name)}(?:$|[^\\p{L}\\p{N}])`, 'iu');
        const exists = [...(world?.threads || []), ...result.threads].some(thread => normalized(thread?.status) === 'open'
            && participants.every(name => (thread?.participants || []).some(value => normalized(value) === normalized(name)))
            && identityName.test(cleanText(thread?.title))
            && /\b(?:identity|recogniz|know|unknown|conceal|hidden)\b/iu.test(`${thread?.title || ''} ${thread?.detail || ''}`));
        if (exists) continue;
        result.threads.push({
            targetId: '',
            title: `${holder.name} has not recognized ${identity.name}’s identity`.slice(0, 160),
            detail: value.slice(0, 800),
            status: 'open',
            participants,
            importance: Math.max(4, Number(fact?.importance) || 0),
        });
        recovered++;
    }
    return recovered;
}

const UNIQUE_OBJECT_WORD = /\b(?:lightsabers?|sabers?|swords?|blades?|weapons?|guns?|rifles?|pistols?|crystals?|kybers?|hilts?|artifacts?|relics?|devices?|vehicles?|ships?|shuttles?|keys?|documents?|letters?|cases?)\b/iu;
const OBJECT_PENDING_STATE = /\b(?:in transit|in hyperspace|en route|pending|awaiting|preparing|on (?:the )?way|arrival (?:is )?estimated|remains? (?:at|in|under|aboard)|not yet)\b/iu;
const OBJECT_TRANSFER_COMPLETED_STATE = /\b(?:delivers?|delivered|presents?|presented|shows?|shown|gives?|gave|given|receives?|received|now in\b[^.!?;]{0,80}\bpossession)\b/iu;
const GENERIC_OBJECT_ANCHOR = new Set(['artifact', 'blade', 'case', 'crystal', 'device', 'document', 'gun', 'hilt', 'item', 'key', 'kyber', 'letter', 'lightsaber', 'object', 'pistol', 'relic', 'rifle', 'saber', 'ship', 'shuttle', 'sword', 'vehicle', 'weapon']);

function bestReferencedUniqueObject(fact, result, world) {
    const evidenceTerms = coverageTerms(`${fact?.subject || ''} ${fact?.predicate || ''} ${fact?.value || ''}`);
    const entities = [...new Map([...(world?.entities || []), ...(result?.entities || [])]
        .map(entity => [normalized(entity?.name), entity]).filter(([name]) => name)).values()];
    const candidates = entities
        .filter(entity => entityTypeFamily(entity?.type) === 'object' && UNIQUE_OBJECT_WORD.test(cleanText(entity?.name)))
        .map(entity => {
            const terms = coverageTerms([entity?.name, ...(entity?.aliases || [])].join(' '));
            return { entity, terms, score: termSetOverlap(terms, evidenceTerms) };
        })
        .sort((left, right) => right.score - left.score);
    if (!candidates[0] || candidates[0].score < 3 || candidates[0].score === candidates[1]?.score) return null;
    return candidates[0];
}

export function discardContradictedObjectStateFacts(result, world, messages) {
    if (!Array.isArray(result?.facts) || !Array.isArray(messages) || !messages.length) return 0;
    const segments = messages.flatMap(message => String(message?.text ?? message?.mes ?? '')
        .split(/[\r\n]+|[.!?]+\s+/u).map(cleanText).filter(Boolean));
    let removed = 0;
    result.facts = result.facts.filter(fact => {
        const factText = `${cleanText(fact?.subject)} ${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`;
        if (!OBJECT_TRANSFER_COMPLETED_STATE.test(factText) || !UNIQUE_OBJECT_WORD.test(factText)) return true;
        const referenced = bestReferencedUniqueObject(fact, result, world);
        if (!referenced) return true;
        const distinctive = [...new Set([...referenced.terms]
            .flatMap(term => [term, ...term.split(/[-–—]/u)]))]
            .filter(term => term && !GENERIC_OBJECT_ANCHOR.has(term));
        if (!distinctive.length) return true;
        const related = segments.filter(segment => UNIQUE_OBJECT_WORD.test(segment)
            && distinctive.some(term => coverageTerms(segment).has(term)));
        const pending = related.some(segment => OBJECT_PENDING_STATE.test(segment));
        const completed = related.some(segment => OBJECT_TRANSFER_COMPLETED_STATE.test(segment));
        if (!pending || completed) return true;
        removed++;
        return false;
    });
    return removed;
}

function uncoveredDurableBeats(result, messages) {
    if (!Array.isArray(result?.sceneCapsule?.beats) || !Array.isArray(messages) || !messages.length) return [];
    const source = messages.map(message => `${cleanText(message?.name || message?.speaker)}: ${cleanText(message?.text ?? message?.mes)}`).join('\n');
    const records = structuredCoverageRecords(result);
    const missing = [];
    for (const raw of result.sceneCapsule.beats) {
        const beat = cleanText(raw);
        const terms = coverageTerms(beat);
        if (!beat || COVERAGE_NON_ASSERTION.test(beat) || !coverageCueFamily(beat) || terms.size < 3) continue;
        const threshold = terms.size >= 5 ? 3 : 2;
        const sourced = coverageOverlap(beat, source) >= threshold;
        const covered = records.some(record => coverageOverlap(beat, record) >= threshold);
        if (sourced && !covered) missing.push(beat);
        if (missing.length >= 8) break;
    }
    return missing;
}

export function recoverSourceGroundedCoverageRecords(result, world, messages) {
    const missing = uncoveredDurableBeats(result, messages);
    let recovered = 0;
    for (const beat of missing) {
        const terms = coverageTerms(beat);
        const threshold = terms.size >= 5 ? 3 : 2;
        if (structuredCoverageRecords(result).some(record => coverageOverlap(beat, record) >= threshold)) continue;
        const cue = coverageCueFamily(beat);
        if (!cue) continue;
        const [, cuePattern] = cue;
        const participants = coverageParticipantNames(result, world, messages, beat);
        const limitation = COVERAGE_LIMITATION.test(beat);
        const capability = !limitation && COVERAGE_CAPABILITY.test(beat);
        const sourceSupported = limitation || capability
            ? sourceSupportsDescriptiveCoverageBeat(beat, messages, participants, limitation ? COVERAGE_LIMITATION : COVERAGE_CAPABILITY)
            : sourceSupportsCoverageBeat(beat, messages, participants, cuePattern);
        if (!participants.length || !sourceSupported) continue;
        const relationship = beat.match(COVERAGE_RELATIONSHIP);
        if (relationship && participants.length >= 2) {
            result.relationships.push({
                targetId: '', from: participants[0], to: participants[1], kind: relationship[1],
                status: 'active', dynamic: beat, importance: 4,
            });
        } else if (COVERAGE_COMMITMENT.test(beat)) {
            result.threads.push({
                targetId: '', title: beat.slice(0, 160), detail: beat, status: 'open', participants, importance: 4,
            });
        } else if (COVERAGE_DESIGNATION.test(beat)) {
            result.facts.push({
                targetId: '', subject: participants[0], predicate: 'established role or designation', value: beat,
                category: 'identity', importance: 4, persistence: 'persistent',
            });
        } else if (limitation || capability) {
            result.facts.push({
                targetId: '', subject: participants[0],
                predicate: descriptiveCoveragePredicate(beat, participants[0], limitation), value: beat,
                category: limitation ? 'limitations' : 'capabilities', importance: 4, persistence: 'persistent',
            });
        } else if (COVERAGE_REMAINING_STATE.test(beat)) {
            result.states.push({
                targetId: '', subject: participants[0], attribute: 'continuity condition', value: beat,
                previous: '', importance: 4, scope: 'ongoing', operation: 'set',
            });
        } else {
            result.events.push({
                title: beat.slice(0, 160), summary: beat, participants,
                location: cleanText(result?.sceneCapsule?.location || result?.scene?.location),
                storyTime: cleanText(result?.sceneCapsule?.storyTime || result?.scene?.time),
                consequences: '', importance: 4,
                temporal: result?.sceneCapsule?.temporal || { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'explicit' },
            });
        }
        recovered++;
    }
    return recovered;
}

const THREAD_GAP = /\b(?:not yet|has not|have not|had not|does not|do not|did not|is not|are not|was not|were not|continues? to|seek(?:s|ing)? to (?:determine|learn|discover|identify|find|decide|understand)|tr(?:y|ies|ied|ying) to (?:determine|learn|discover|identify|find|decide|understand)|unknown|unanswered|unresolved|undecided|pending|unconfirmed|incomplete|not (?:complete|completed|done|confirmed|established|disclosed|answered|accepted|met|delivered)|no (?:answer|decision|confirmation|evidence|proof)|neither\b[^.!?;]{0,160}\b(?:complete|completed|done|obtained|recovered)|lacks? (?:confirmation|evidence|proof|an answer)|awaits?|must (?:learn|discover|identify|find|decide|preserve|maintain|continue|keep)|still (?:required|needed|missing|pending|unresolved|unconfirmed)|remains? (?:unknown|unanswered|unresolved|undecided|missing|pending|unconfirmed|incomplete|open|hidden|concealed|undisclosed))\b/iu;
const THREAD_COMMITMENT_PENDING = /\b(?:must|will|shall|['’]ll|going to|plans? to|intends? to|promises? to|vows? to|prepar(?:e|es|ed|ing) to|en route|in transit|heading to|on (?:the )?way to|arrival (?:is )?expected|tomorrow|later|next (?:day|morning|afternoon|evening|night|week|month|year))\b/iu;
const THREAD_IN_PROGRESS = /\b(?:begins?|began|start(?:s|ed|ing)?|ongoing|in progress|underway|continues?|continuing)\b/iu;
const THREAD_RESOLUTION = /\b(?:answers?|answered|reveals?|revealed|discloses?|disclosed|identifies?|identified|learns?|learned|discovers?|discovered|finds?|found|recovers?|recovered|secures?|secured|logs?|logged|establishes?|established|returns?|returned|departs?|departed|leaves?|left|sets? out|set out|arrives?|arrived|reaches?|reached|enters?|entered|ends?|ended|meets?|met|contacts?|contacted|reports?|reported|delivers?|delivered|presents?|presented|completes?|completed|finishes?|finished|decides?|decided|chooses?|chose|accepts?|accepted|rejects?|rejected|defeats?|defeated|destroys?|destroyed|repairs?|repaired|opens?|opened|closes?|closed|fulfills?|fulfilled|obtains?|obtained|acquires?|acquired|now knows?)\b/iu;
const THREAD_VAGUE_RESIDUAL = /\b(?:extent|consequences|broader (?:history|implications|meaning|exploration)|further (?:exploration|evaluation)|what (?:this|that) means)\b[^.!?;]{0,160}\b(?:open|unexplored|unclear|unknown|unresolved|incomplete|partly explored)\b/iu;
const THREAD_ACTION_RESOLUTION_RULES = [
    [/\b(?:conceal|concealment|keep\b[^.!?;]{0,80}\bhidden)\b/iu, /\b(?:discovers?|discovered|reveals?|revealed|exposes?|exposed|learns?|learned|no longer concealed|concealment (?:ends?|ended|fails?|failed|is broken|was broken))\b/iu],
    [/\b(?:determin(?:e|es|ed|ing)|unanswered question)\b/iu, /\b(?:determines|determined|confirms|confirmed|answers|answered|establishes|established|proves|proved)\b/iu],
    [/\b(?:survive|survival|endure)\b/iu, /\b(?:survives|survived|endures|endured|(?:it is|it['’]s|session is|session['’]s) over|(?:ends?|ended)\b[^.!?;]{0,60}\b(?:exchange|fight|combat|attack|assessment|session)|(?:exchange|fight|combat|attack|assessment|session) (?:ends?|ended|is over|was over))\b/iu],
    [/\b(?:assessment|assess|evaluat(?:e|es|ed|ion)|measure|test)\b/iu, /\b(?:(?:completes?|completed|concludes?|concluded|finishes?|finished|ends?|ended)\b[^.!?;]{0,100}\b(?:assessment|evaluation|measurement|test)|(?:assesses|assessed|evaluates|evaluated|measures|measured|tests|tested)\b|(?:it is|it['’]s|session is|session['’]s) over\b)/iu],
    [/\b(?:accept|agree|approval|approve|consent)\b/iu, /\b(?:accepts?|accepted|agrees?|agreed|approves?|approved|consents?|consented|rejects?|rejected|refuses?|refused|declines?|declined|decides?|decided)\b/iu],
    [/\b(?:receive|receipt)\b/iu, /\b(?:receives|received|takes? possession|took possession|accepts delivery|accepted delivery|is handed|was handed)\b/iu],
    [/\b(?:recover|recovery|retrieve|retrieval|obtain|acquire)\b/iu, /\b(?:recovers|recovered|retrieves|retrieved|obtains|obtained|acquires|acquired|finds|found|locates|located)\b/iu],
    [/\b(?:depart|departure|travel|journey|arrive|arrival|reach|enter)\b/iu, /\b(?:departs?|departed|leaves?|left|travels?|traveled|journeys?|journeyed|arrives?|arrived|reaches?|reached|enters?|entered|is inside|are inside|was inside|were inside|sets? out|set out)\b/iu],
    [/\b(?:deliver|present)\b/iu, /\b(?:delivers?|delivered|presents?|presented|gives?|gave|hands?|handed)\b/iu],
    [/\b(?:report|account|explain)\b/iu, /\b(?:reported|reports\b[^.!?;]{0,80}\bto|gave\b[^.!?;]{0,80}\breport|gives\b[^.!?;]{0,80}\breport|delivered\b[^.!?;]{0,80}\breport|explains?|explained|discloses?|disclosed)\b/iu],
    [/\b(?:meet|meeting|audience)\b/iu, /\b(?:meets?|met|audience (?:begins?|began|occurs?|occurred|concludes?|concluded))\b/iu],
    [/\b(?:request|contact|channel)\b/iu, /\b(?:answers?|answered|responds?|responded|contacts?|contacted|live contact|establishes?|established|opens?\b[^.!?;]{0,80}\bchannel|channel\b[^.!?;]{0,80}\bopens?)\b/iu],
    [/\b(?:respond|response|choose|choice|decid(?:e|es|ed|ing)|decision)\b/iu, /\b(?:responds?|responded|answers?|answered|chooses?|chose|decides?|decided|accepts?|accepted|rejects?|rejected|retains?|retained|refuses?|refused)\b/iu],
    [/\b(?:leave|remain|stay)\b/iu, /\b(?:leaves|left|remains|remained|stays|stayed|chooses|chose|refuses to leave|refused to leave)\b/iu],
    [/\b(?:reveal|disclose|identify|identity|true name|who (?:is|was|are|were))\b/iu, /\b(?:reveals?|revealed|discloses?|disclosed|identifies?|identified|answers?|answered|names?|named|learns?|learned|discovers?|discovered)\b/iu],
    [/\b(?:fulfill|complete|completion)\b/iu, /\b(?:fulfills?|fulfilled|completes?|completed|finishes?|finished|delivers?|delivered|meets?|met|arrives?|arrived)\b/iu],
];

function threadEvidenceClauses(value) {
    const text = cleanText(value);
    if (!text) return [];
    return text.split(/(?:[.!?;]+|,\s+(?=(?:but|however|although|while|yet|and\s+(?:still|remains?|is\s+(?:still|being)|are\s+(?:still|being)))\b))/iu)
        .map(cleanText)
        .filter(Boolean);
}

function completedThreadEvidence(thread, value) {
    return threadEvidenceClauses(value).find(clause => THREAD_RESOLUTION.test(clause)
        && !threadEvidenceIsIncomplete(thread, clause)
        && threadResolutionActionMatches(thread, clause));
}

function threadEvidenceIsIncomplete(thread, evidence) {
    return THREAD_GAP.test(evidence)
        || THREAD_COMMITMENT_PENDING.test(evidence)
        || (THREAD_IN_PROGRESS.test(evidence) && !/\b(?:meet|meeting|audience)\b/iu.test(cleanText(thread?.title)));
}

function threadResolutionActionMatches(thread, evidence) {
    const title = cleanText(thread?.title);
    for (const [titlePattern, evidencePattern] of THREAD_ACTION_RESOLUTION_RULES) {
        if (titlePattern.test(title)) return evidencePattern.test(cleanText(evidence));
    }
    return true;
}

function threadHasSpecificResolutionAction(thread) {
    const title = cleanText(thread?.title);
    return THREAD_ACTION_RESOLUTION_RULES.some(([titlePattern]) => titlePattern.test(title));
}

function threadResolutionActorMatches(thread, evidence) {
    if (/\b(?:survive|survival|endure)\b/iu.test(cleanText(thread?.title))) return true;
    if (!/\b(?:assessment|assess|evaluat(?:e|es|ed|ion)|measure|test)\b/iu.test(cleanText(thread?.title))) return true;
    const actor = cleanText((thread?.participants || [])[0]);
    if (!actor) return true;
    const variants = [actor, actor.split(/\s+/u)[0]].filter(value => value.length >= 4);
    return variants.some(value => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(value)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(cleanText(evidence)));
}
const THREAD_MATCH_STOP_WORDS = new Set([
    ...COVERAGE_STOP_WORDS,
    'asks', 'asked', 'awaits', 'awaiting', 'current', 'detail', 'has', 'have', 'had', 'known', 'matter', 'must',
    'not', 'open', 'pending', 'question', 'remains', 'remain', 'still', 'thread', 'unknown', 'unanswered', 'unresolved', 'yet',
]);

function threadTerms(value) {
    const canonical = term => {
        if (/^(?:depart|departs|departed|departure|leaves|leave|left)$/u.test(term)) return 'depart';
        if (/^(?:meet|meets|meeting|met)$/u.test(term)) return 'meet';
        if (/^(?:arrive|arrives|arrived|reach|reaches|reached|enter|enters|entered|inside)$/u.test(term)) return 'arrive';
        if (/^(?:report|reports|reported)$/u.test(term)) return 'report';
        if (/^(?:deliver|delivers|delivered)$/u.test(term)) return 'deliver';
        if (/^(?:return|returns|returned)$/u.test(term)) return 'return';
        if (/^(?:recover|recovers|recovered|recovery|retrieve|retrieves|retrieved|retrieval)$/u.test(term)) return 'recover';
        if (/^(?:pain|supplies|medical|medkit|bacta|compress|compresses|analgesic|analgesics)$/u.test(term)) return 'medical';
        if (/^(?:channel|contact|contacts|contacted|request|requests|requested)$/u.test(term)) return 'contact';
        return term;
    };
    const expanded = [...coverageTerms(value)].flatMap(term => [term, ...term.split(/[-–—]/u)]);
    return new Set(expanded.filter(term => term && !THREAD_MATCH_STOP_WORDS.has(term)).map(canonical));
}

function threadTopicTerms(value, result, world) {
    const names = new Set(recoveryEntities(result, world)
        .flatMap(entity => entity.variants)
        .flatMap(name => [...coverageTerms(name)]));
    return new Set([...threadTerms(value)].filter(term => !names.has(term)));
}

function termSetOverlap(left, right) {
    let count = 0;
    for (const term of left) if (right.has(term)) count++;
    return count;
}

function threadParticipantMatch(thread, beat, world, result) {
    const names = recoveryEntities(result, world);
    const participants = (thread?.participants || []).map(value => normalized(value)).filter(Boolean);
    if (!participants.length) return true;
    return names.some(entity => {
        const canonical = normalized(entity.name);
        if (!participants.includes(canonical) && !entity.variants.some(value => participants.includes(normalized(value)))) return false;
        return entity.variants.some(value => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(value)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(beat));
    });
}

function threadAliasResolutionMatch(thread, beat, world, result) {
    const title = cleanText(thread?.title);
    if ((result?.identityResolutions || []).some(item =>
        (textMentionsIdentityVariant(title, [item?.reference])
            || termSetOverlap(threadTerms(item?.reference), threadTerms(title)) >= 2)
        && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(item?.canonical)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(beat))) return true;
    return recoveryEntities(result, world).some(entity => {
        const canonical = normalized(entity.name);
        const descriptor = entity.variants.find(value => normalized(value) !== canonical
            && (textMentionsIdentityVariant(title, [value])
                || termSetOverlap(threadTerms(value), threadTerms(title)) >= 2));
        if (!descriptor) return false;
        return entity.variants.some(value => normalized(value) !== normalized(descriptor)
            && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(value)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(beat));
    });
}

function sourceSupportsThreadResolution(beat, messages, thread, world, result) {
    if (!THREAD_RESOLUTION.test(beat) || COVERAGE_NON_ASSERTION.test(beat)) return false;
    const beatTerms = threadTerms(beat);
    const participants = coverageParticipantNames(result, world, messages, beat);
    return (messages || []).some(message => {
        const messageText = cleanText(message?.text ?? message?.mes);
        const speaker = cleanText(message?.name || message?.speaker);
        const source = `${speaker}: ${messageText}`;
        if (!messageText || COVERAGE_NON_ASSERTION.test(source) || !THREAD_RESOLUTION.test(source)) return false;
        if (termSetOverlap(beatTerms, threadTerms(source)) < Math.max(4, Math.min(6, Math.ceil(beatTerms.size * 0.35)))) return false;
        if (participants.length && !participants.some(name => normalized(name) === normalized(speaker)
            || new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(messageText))) return false;
        return threadParticipantMatch(thread, source, world, result);
    });
}

function sourceSupportsCommitmentResolution(beat, messages, thread, world, result) {
    const threadTopic = threadTerms(`${thread?.title || ''} ${thread?.detail || ''}`);
    const beatTopic = threadTerms(beat);
    return (messages || []).some(message => {
        const source = `${cleanText(message?.name || message?.speaker)}: ${cleanText(message?.text ?? message?.mes)}`;
        if (!THREAD_RESOLUTION.test(source) || COVERAGE_NON_ASSERTION.test(source)) return false;
        if (!threadParticipantMatch(thread, source, world, result)) return false;
        return termSetOverlap(threadTopic, threadTerms(source)) >= 2
            && termSetOverlap(beatTopic, threadTerms(source)) >= 3;
    });
}

function sourceSupportsThreadAction(messages, thread, world, result) {
    return (messages || []).some(message => {
        const source = `${cleanText(message?.name || message?.speaker)}: ${cleanText(message?.text ?? message?.mes)}`;
        return !COVERAGE_NON_ASSERTION.test(source)
            && threadResolutionActionMatches(thread, source)
            && threadResolutionActorMatches(thread, source)
            && threadParticipantMatch(thread, source, world, result);
    });
}

function incomingThreadFor(result, thread) {
    return (result?.threads || []).find(item => normalized(item?.targetId) === normalized(thread?.id)
        || normalized(item?.title) === normalized(thread?.title));
}

export function resolveCompletedIncomingThreads(result) {
    if (!Array.isArray(result?.threads)) return 0;
    let resolved = 0;
    for (const thread of result.threads) {
        const detail = cleanText(thread?.detail);
        const completed = completedThreadEvidence(thread, detail);
        if (IDENTITY_THREAD.test(`${thread?.title || ''} ${detail}`) && THREAD_GAP.test(detail)) continue;
        const vagueResidual = THREAD_VAGUE_RESIDUAL.test(detail);
        const startedAtomicAction = vagueResidual
            && /\b(?:reaches?|reached|begins?|began|starts?|started)\b/iu.test(detail)
            && termSetOverlap(threadTerms(thread?.title), threadTerms(detail)) >= 2;
        if (normalized(thread?.status) !== 'open'
            || (!completed && !startedAtomicAction)
            || (!completed && THREAD_GAP.test(detail) && !vagueResidual)
            || (!startedAtomicAction && !completed)) continue;
        thread.status = 'resolved';
        thread.detail = `Resolved by extracted continuity: ${completed || detail}`;
        resolved++;
    }
    return resolved;
}

function storedOpenThreadFor(result, world, incoming) {
    return (world?.threads || []).find(item => item?.status === 'open'
        && (normalized(item?.id) === normalized(incoming?.targetId)
            || normalized(item?.title) === normalized(incoming?.title)));
}

export function reopenUnsupportedResolvedThreads(result, world, messages, modelResolvedThreads = null) {
    if (!Array.isArray(result?.threads) || !Array.isArray(messages) || !messages.length) return 0;
    let reopened = 0;
    for (const incoming of result.threads) {
        if (normalized(incoming?.status) !== 'resolved') continue;
        if (modelResolvedThreads instanceof Set && !modelResolvedThreads.has(incoming)) continue;
        const stored = storedOpenThreadFor(result, world, incoming);
        const resolvedDetail = cleanText(incoming?.detail).replace(/^Resolved(?:(?: by| through)[^:]*)?:\s*/iu, '');
        const narrowedResolution = /^Resolved as to\b/iu.test(resolvedDetail);
        const historicalGapResolved = /\bunanswered\b[^.!?;]{0,160}\b(?:led to|resulted in|ended (?:when|with))\b/iu.test(resolvedDetail)
            && THREAD_RESOLUTION.test(resolvedDetail);
        const explicitUnfinished = ((threadEvidenceIsIncomplete(stored || incoming, resolvedDetail) && !historicalGapResolved))
            && !THREAD_VAGUE_RESIDUAL.test(resolvedDetail)
            && !narrowedResolution;
        const baseline = stored || incoming;
        const candidates = [
            resolvedDetail,
            ...(result?.sceneCapsule?.beats || []),
            ...(result?.events || []).flatMap(item => [item?.summary, item?.consequences]),
            ...(result?.backgrounds || []).map(item => item?.summary),
        ].flatMap(threadEvidenceClauses);
        const topic = threadTopicTerms(`${baseline?.title || ''} ${baseline?.detail || ''}`, result, world);
        const specificAction = threadHasSpecificResolutionAction(baseline);
        const supported = narrowedResolution || (!explicitUnfinished && cleanText(incoming?.detail).length <= 1800 && candidates.some((evidence, index) =>
            THREAD_RESOLUTION.test(evidence)
            && threadResolutionActionMatches(baseline, evidence)
            && threadResolutionActorMatches(baseline, evidence)
            && termSetOverlap(topic, threadTopicTerms(evidence, result, world)) >= (specificAction ? 1 : 2)
            && (!threadEvidenceIsIncomplete(baseline, evidence) || (index === 0 && historicalGapResolved))
            && (sourceSupportsThreadResolution(evidence, messages, baseline, world, result)
                || (index === 0 && specificAction))));
        if (supported) continue;
        Object.assign(incoming, {
            targetId: stored?.id || incoming.targetId || '',
            title: stored?.title || incoming.title,
            detail: stored?.detail || resolvedDetail,
            status: 'open',
            participants: stored?.participants || incoming.participants || [],
            importance: stored?.importance || incoming.importance || 3,
        });
        reopened++;
    }
    return reopened;
}

export function preserveResolvedThreadHistory(result, world) {
    if (!Array.isArray(result?.threads) || !Array.isArray(world?.threads)) return 0;
    const resolvedById = new Map(world.threads.filter(item => item?.status === 'resolved' && cleanText(item?.id))
        .map(item => [normalized(item.id), item]));
    const resolvedByTitle = new Map(world.threads.filter(item => item?.status === 'resolved' && cleanText(item?.title))
        .map(item => [normalized(item.title), item]));
    let preserved = 0;
    for (const incoming of result.threads) {
        const stored = resolvedById.get(normalized(incoming?.targetId)) || resolvedByTitle.get(normalized(incoming?.title));
        if (!stored) continue;
        if (normalized(incoming?.status) === 'open' && THREAD_GAP.test(cleanText(incoming?.detail))
            && !completedThreadEvidence(stored, cleanText(stored?.detail).replace(/^Resolved(?:(?: by| through)[^:]*)?:\s*/iu, ''))) continue;
        Object.assign(incoming, {
            targetId: stored.id,
            title: stored.title,
            detail: stored.detail,
            status: 'resolved',
            participants: stored.participants || [],
            importance: stored.importance || incoming.importance || 3,
        });
        preserved++;
    }
    return preserved;
}

function hasUnmatchedTitleConjunction(thread, beat) {
    const beatTerms = threadTerms(beat);
    const title = String(thread?.title || '').toLocaleLowerCase();
    const pairs = title.matchAll(/([\p{L}\p{N}][\p{L}\p{N}'’-]*)\s+and\s+([\p{L}\p{N}][\p{L}\p{N}'’-]*)/gu);
    for (const pair of pairs) {
        const left = pair[1].replace(/[’']s$/u, '');
        const right = pair[2].replace(/[’']s$/u, '');
        if (THREAD_MATCH_STOP_WORDS.has(left) || THREAD_MATCH_STOP_WORDS.has(right)) continue;
        const matches = term => [...threadTerms(term)].some(value => beatTerms.has(value));
        if (matches(left) !== matches(right)) return true;
    }
    return false;
}

function successorThreadForPartialResolution(result, thread, world) {
    const participants = new Set((thread?.participants || []).map(value => normalized(canonicalMemorySubject(world, value))).filter(Boolean));
    const topic = threadTopicTerms(`${thread?.title || ''} ${thread?.detail || ''}`, result, world);
    return (result?.threads || []).find(candidate => candidate?.status === 'open'
        && normalized(candidate?.targetId) !== normalized(thread?.id)
        && normalized(candidate?.title) !== normalized(thread?.title)
        && (candidate?.participants || []).some(value => participants.has(normalized(canonicalMemorySubject(world, value))))
        && termSetOverlap(topic, threadTopicTerms(`${candidate?.title || ''} ${candidate?.detail || ''}`, result, world)) >= 2);
}

export function reconcileExplicitlyResolvedThreads(result, world, messages) {
    if (!Array.isArray(result?.threads) || !Array.isArray(result?.sceneCapsule?.beats)
        || !Array.isArray(messages) || !messages.length) return { resolved: 0, warnings: [] };
    let resolved = 0;
    const warnings = [];
    const resolutionEvidence = [
        ...(result.sceneCapsule.beats || []),
        ...(result.events || []).flatMap(item => [item?.summary, item?.consequences]),
        ...(result.backgrounds || []).map(item => item?.summary),
    ].flatMap(threadEvidenceClauses);
    for (const thread of (world?.threads || []).filter(item => item?.status === 'open'
        && (THREAD_GAP.test(`${item.title || ''} ${item.detail || ''}`)
            || THREAD_COMMITMENT_PENDING.test(`${item.title || ''} ${item.detail || ''}`)))) {
        const incoming = incomingThreadFor(result, thread);
        if (incoming && incoming.status !== 'open') continue;
        if (incoming && THREAD_GAP.test(cleanText(incoming.detail))) continue;
        const topic = threadTopicTerms(`${thread.title || ''} ${thread.detail || ''}`, result, world);
        const title = threadTopicTerms(thread.title, result, world);
        let partial = null;
        for (const rawBeat of resolutionEvidence) {
            const beat = cleanText(rawBeat);
            if (!beat || !THREAD_RESOLUTION.test(beat) || !threadResolutionActionMatches(thread, beat)
                || !threadResolutionActorMatches(thread, beat)
                || threadEvidenceIsIncomplete(thread, beat)
                || !threadParticipantMatch(thread, beat, world, result)) continue;
            const beatTerms = threadTerms(beat);
            const overlap = termSetOverlap(topic, beatTerms);
            const titleOverlap = termSetOverlap(title, beatTerms);
            const commitmentResolution = THREAD_COMMITMENT_PENDING.test(`${thread.title || ''} ${thread.detail || ''}`);
            if (overlap < (commitmentResolution ? 1 : 2) || titleOverlap < 1) continue;
            const specificAction = threadHasSpecificResolutionAction(thread);
            const sourceSupported = sourceSupportsThreadResolution(beat, messages, thread, world, result)
                || (commitmentResolution && sourceSupportsCommitmentResolution(beat, messages, thread, world, result))
                || (specificAction && sourceSupportsThreadAction(messages, thread, world, result));
            if (!sourceSupported) continue;
            const aliasResolution = threadAliasResolutionMatch(thread, beat, world, result);
            const required = specificAction
                ? (commitmentResolution || /\b(?:recover|recovery|retrieve|retrieval|request|contact|channel)\b/iu.test(cleanText(thread?.title)) ? 1 : 2)
                : aliasResolution || commitmentResolution ? 2
                : Math.max(3, Math.min(6, Math.ceil(Math.min(topic.size, 12) * 0.3)));
            if (hasUnmatchedTitleConjunction(thread, beat)) {
                partial ||= beat;
                continue;
            }
            if (overlap >= required && (titleOverlap >= 2 || ((aliasResolution || specificAction) && titleOverlap >= 1))) {
                const resolution = incoming || {};
                Object.assign(resolution, {
                    targetId: thread.id, title: thread.title, detail: `Resolved by explicit continuity: ${beat}`,
                    status: 'resolved', participants: thread.participants || [], importance: thread.importance || 3,
                });
                if (!incoming) result.threads.push(resolution);
                resolved++;
                partial = null;
                break;
            }
            partial ||= beat;
        }
        if (partial && !incoming) {
            const successor = successorThreadForPartialResolution(result, thread, world);
            if (successor) {
                result.threads.push({
                    targetId: thread.id, title: thread.title,
                    detail: `Resolved through an atomic continuity transition: ${partial}`,
                    status: 'resolved', participants: thread.participants || [], importance: thread.importance || 3,
                });
                resolved++;
            } else if (warnings.length < 4) warnings.push(`Potential partial resolution remains open for “${cleanText(thread.title)}”: ${partial}`);
        }
    }
    return { resolved, warnings };
}

const IDENTITY_THREAD = /\b(?:identity|true name|real name|who (?:is|was|are|were))\b/iu;
const IDENTITY_RESIDUAL_GENERIC = new Set([
    ...THREAD_MATCH_STOP_WORDS,
    'identity', 'name', 'named', 'real', 'true', 'canonical', 'known', 'revealed', 'identified',
]);

function identityResolutionMatchesThread(thread, resolution) {
    const reference = cleanText(resolution?.reference);
    const canonical = cleanText(resolution?.canonical);
    const title = cleanText(thread?.title);
    const text = `${title} ${thread?.detail || ''}`;
    if (!reference || !canonical || !IDENTITY_THREAD.test(text)) return false;
    if (/\bdoes not know that\b/iu.test(cleanText(thread?.detail))) {
        const holder = (thread?.participants || [])[0];
        const evidence = cleanText(resolution?.evidence);
        const holderPattern = holder && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(holder)}(?:$|[^\\p{L}\\p{N}])`, 'iu');
        if (!holderPattern || !holderPattern.test(evidence)
            || !/\b(?:learns?|learned|discovers?|discovered|recognizes?|recognized|now knows?)\b/iu.test(evidence)) return false;
    }
    if (textMentionsIdentityVariant(title, [reference])) return true;
    const descriptor = descriptivePersonIdentityContext(reference, { relationships: [] });
    if (descriptor
        && textMentionsIdentityVariant(title, [descriptor.owner])
        && new RegExp(`\\b${escaped(cleanText(descriptor.role).split(/\\s+/u).at(-1))}\\b`, 'iu').test(title)) return true;
    const referenceTerms = threadTerms(reference);
    return termSetOverlap(referenceTerms, threadTerms(title)) >= 2;
}

function identityThreadResidualDetail(incoming, resolution, world, result) {
    const detail = cleanText(incoming?.detail);
    if (!detail || !THREAD_GAP.test(detail)) return '';
    const entityTerms = new Set(recoveryEntities(result, world).flatMap(entity => entity.variants)
        .flatMap(value => [...coverageTerms(value)]));
    for (const value of [resolution?.reference, resolution?.canonical]) {
        for (const term of coverageTerms(value)) entityTerms.add(term);
    }
    const topical = [...coverageTerms(detail)].filter(term => !IDENTITY_RESIDUAL_GENERIC.has(term) && !entityTerms.has(term));
    return topical.length >= 2 ? detail : '';
}

export function reconcileResolvedIdentityThreads(result, world) {
    if (!Array.isArray(result?.threads) || !Array.isArray(result?.identityResolutions)) return 0;
    let resolved = 0;
    for (const resolution of result.identityResolutions) {
        for (const thread of (world?.threads || []).filter(item => item?.status === 'open'
            && identityResolutionMatchesThread(item, resolution))) {
            const incoming = incomingThreadFor(result, thread);
            if (incoming?.status && incoming.status !== 'open') continue;
            const residualDetail = incoming ? identityThreadResidualDetail(incoming, resolution, world, result) : '';
            const resolvedRecord = incoming || {};
            Object.assign(resolvedRecord, {
                targetId: thread.id,
                title: thread.title,
                detail: `Resolved by explicit continuity: ${cleanText(resolution.evidence) || `${resolution.reference} is ${resolution.canonical}`}`,
                status: 'resolved',
                participants: thread.participants || [],
                importance: thread.importance || 3,
            });
            if (!incoming) result.threads.push(resolvedRecord);
            if (residualDetail) result.threads.push({
                targetId: '',
                title: `Unresolved circumstances surrounding ${cleanText(resolution.canonical)}`.slice(0, 160),
                detail: residualDetail,
                status: 'open',
                participants: [...new Set([...(thread.participants || []), cleanText(resolution.canonical)].filter(Boolean))],
                importance: thread.importance || 3,
            });
            resolved++;
        }
    }
    return resolved;
}

function textMentionsCanonicalName(value, name) {
    const source = cleanText(value);
    const target = cleanText(name);
    return Boolean(source && target
        && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(target)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(source));
}

export function normalizeRelationshipDescriptions(result) {
    if (!Array.isArray(result?.relationships)) return 0;
    let normalizedDescriptions = 0;
    for (const item of result.relationships) {
        const from = cleanText(item?.from);
        const to = cleanText(item?.to);
        if (!from || !to) continue;
        const dynamic = cleanText(item?.dynamic);
        if (dynamic && textMentionsCanonicalName(dynamic, from) && textMentionsCanonicalName(dynamic, to)) continue;
        const prefix = `Relationship between ${from} and ${to}:`;
        const fallback = [cleanText(item?.kind), cleanText(item?.status)].filter(Boolean).join('; ');
        item.dynamic = `${prefix} ${dynamic || fallback || 'established connection.'}`.trim().slice(0, 1200);
        normalizedDescriptions++;
    }
    return normalizedDescriptions;
}

export function findRelationshipEndpointConflicts(result, world) {
    const conflicts = [];
    const evidenceWorld = { ...(world || {}), entities: [...(world?.entities || []), ...(result?.entities || [])] };
    const entityIndex = continuityEntityIndex(result, world);
    for (const [index, relationship] of (result?.relationships || []).entries()) {
        const label = `${cleanText(relationship?.from)} ↔ ${cleanText(relationship?.to)}`;
        const from = normalized(resolvedReconciliationSubject(result, evidenceWorld,
            canonicalMention(entityIndex, relationship?.from)?.name || relationship?.from));
        const to = normalized(resolvedReconciliationSubject(result, evidenceWorld,
            canonicalMention(entityIndex, relationship?.to)?.name || relationship?.to));
        if (from && from === to) {
            conflicts.push({
                category: 'relationships', index, label,
                warning: `Relationship endpoint conflict: “${label}” resolves both endpoints to the same participant; preserve the two distinct participants instead of creating a self-relationship.`,
            });
        }
    }
    return conflicts.slice(0, 4);
}

export function reconcileStatePreviousValues(result, world) {
    if (!Array.isArray(result?.states) || !Array.isArray(world?.states)) return 0;
    const evidenceWorld = { ...(world || {}), entities: [...(world?.entities || []), ...(result?.entities || [])] };
    const byId = new Map(world.states.map(item => [cleanText(item?.id), item]).filter(([id]) => id));
    const byIdentity = new Map(world.states.map(item => [stateIdentity(evidenceWorld, item), item]).filter(([identity]) => identity));
    let reconciled = 0;
    for (const item of result.states) {
        const stored = byId.get(cleanText(item?.targetId)) || byIdentity.get(stateIdentity(evidenceWorld, item));
        if (!stored) continue;
        const changed = normalized(item?.value) !== normalized(stored?.value) || normalized(item?.operation) === 'clear';
        if (!changed || normalized(item?.previous) === normalized(stored?.value)) continue;
        item.previous = cleanText(stored?.value);
        reconciled++;
    }
    return reconciled;
}

// A stable state ID owns one subject/attribute pair. Models sometimes preserve
// that ID and the exact previous value while accidentally substituting a
// different nearby character name. In that narrow case the transition chain is
// stronger evidence than the rewritten subject, so retain the owner and the new
// detail instead of either corrupting the state or discarding the update.
export function repairStableStateOwners(result, world) {
    if (!Array.isArray(result?.states) || !Array.isArray(world?.states)) return 0;
    const byId = new Map(world.states.map(item => [cleanText(item?.id), item]).filter(([id]) => id));
    let repaired = 0;
    for (const item of result.states) {
        const stored = byId.get(cleanText(item?.targetId));
        if (!stored
            || normalized(item?.subject) === normalized(stored?.subject)
            || canonicalStateAttribute(item?.attribute) !== canonicalStateAttribute(stored?.attribute)
            || !normalized(item?.previous)
            || !normalized(stored?.value)
            || normalized(item?.previous) !== normalized(stored?.value)) continue;
        item.subject = cleanText(stored.subject);
        repaired++;
    }
    return repaired;
}

function latestStructuredPositions(messages) {
    for (const message of [...(messages || [])].reverse()) {
        const source = String(message?.text ?? message?.mes ?? '');
        const matches = [...source.matchAll(/(?:^|[\r\n])\s*(?:positions?|present characters?|participants?)\s*=\s*([^\r\n]+)/giu)];
        const value = cleanText(matches.at(-1)?.[1]);
        if (value) return value;
    }
    return '';
}

function entityIsEstablishedDead(entity, result, world) {
    const name = cleanText(entity?.name);
    if (!name) return false;
    if (/\b(?:dead|deceased)\b/iu.test(`${cleanText(entity?.type)} ${cleanText(entity?.description)}`)) return true;
    return [...(world?.states || []), ...(result?.states || [])].some(item =>
        normalized(item?.subject) === normalized(name)
        && /\b(?:condition|status|life|alive|health)\b/iu.test(cleanText(item?.attribute))
        && /\b(?:dead|deceased|killed)\b/iu.test(cleanText(item?.value)));
}

function textMentionsEntity(value, entity) {
    return [entity?.name, ...(entity?.aliases || [])].some(name => textMentionsCanonicalName(value, name));
}

// Scene participants are an active-scene snapshot, not every person referenced
// by dialogue, memories, possessions, or backstory. Prefer an explicit current
// Positions/Participants field when present, supplement it with names in the
// scene activity, and keep a deceased off-screen reference out of the cast.
export function reconcileSceneParticipants(result, world, messages = null) {
    if (!result?.scene || typeof result.scene !== 'object') return 0;
    const original = [...new Set((result.scene.participants || []).map(cleanText).filter(Boolean))];
    const positions = latestStructuredPositions(messages);
    const activity = cleanText(result.scene.activity);
    const evidence = cleanText(`${positions} ${activity}`);
    const entities = [];
    const seen = new Set();
    for (const entity of [...(world?.entities || []), ...(result?.entities || [])]) {
        const name = cleanText(entity?.name);
        if (!name || seen.has(normalized(name))) continue;
        seen.add(normalized(name));
        entities.push(entity);
    }
    for (const message of messages || []) {
        const name = cleanText(message?.name);
        const representedByLivingEntity = entities.some(entity => !entityIsEstablishedDead(entity, result, world)
            && [entity.name, ...(entity.aliases || [])].some(alias => normalized(alias) === normalized(name)));
        if (!name || seen.has(normalized(name)) || representedByLivingEntity || !textMentionsCanonicalName(evidence, name)) continue;
        seen.add(normalized(name));
        entities.push({ name, type: 'person', aliases: [] });
    }

    let participants = positions
        ? original.filter(name => {
            const entity = entities.find(candidate => normalized(candidate.name) === normalized(name));
            return entity ? textMentionsEntity(evidence, entity) : textMentionsCanonicalName(evidence, name);
        })
        : [...original];
    for (const entity of entities) {
        if (textMentionsEntity(evidence, entity)) participants.push(cleanText(entity.name));
    }
    participants = [...new Set(participants.map(cleanText).filter(Boolean))]
        .filter(name => {
            const entity = entities.find(candidate => normalized(candidate.name) === normalized(name));
            return !entity || !entityIsEstablishedDead(entity, result, world)
                || textMentionsCanonicalName(evidence, entity.name);
        });

    if (JSON.stringify(participants) === JSON.stringify(original)) return 0;
    result.scene.participants = participants;
    return 1;
}

const AUDIT_EPISTEMIC_CATEGORY = /\b(?:belief|claim|knowledge|rumou?r|report|uncertain|allegation|speculation|intention)\b/iu;
const AUDIT_SUBJECTIVE_VALUE = /\b(?:believes?|thinks?|suspects?|claims?|alleges?|rumou?rs?|rumou?red|reportedly)\b/iu;
const AUDIT_POSSESSION_ATTRIBUTE = /\b(?:possession|possesses|inventory|ownership|carrying|carries|holds|equipment)\b/iu;
const AUDIT_OBJECT_TYPE = /^(?:object|item|artifact|weapon|tool|vehicle|device|equipment)$/iu;
const AUDIT_IMMUTABLE_IDENTITY = /\b(?:species|race|birthplace|birth place|date of birth|parentage|biological parent|true identity|real identity)\b/iu;
const AUDIT_ROLE_IDENTITY = /\b(?:rank|role|position|title|office|designation)\b/iu;
const AUDIT_TEMPORAL_TRANSITION = /\b(?:former|previous|prior|now|currently|became|becomes|promoted|demoted|appointed|retired|replaced|succeeded)\b/iu;
const AUDIT_ATTRIBUTED_CATEGORY = /^(?:(?:(?:former\s+)?character|attributed|subjective|unconfirmed|disputed|alleged|rumou?red)\s+)?(?:belief|claim|allegation|rumou?r|report|suspicion|speculation|perspective|uncertainty)\b/iu;
const AUDIT_ATTRIBUTED_PREDICATE = /^(?:belief|claim|allegation|rumou?r|report|suspicion|speculation|perspective) about\s/iu;
const AUDIT_ATTRIBUTION_VERB = /\b(?:believes?|believed|claims?|claimed|alleges?|alleged|reports?|reported|rumou?rs?|rumou?red|suspects?|suspected|speculates?|speculated|thinks?|thought|assumes?|assumed|infers?|inferred|concludes?|concluded|remembers?|remembered|recalls?|recalled|says?|said|tells?|told|states?|stated|insists?|insisted|argues?|argued)\b/iu;
const AUDIT_ACTIVE_ATTRIBUTION_VERB = /(?:believes?|believed|claims?|claimed|alleges?|alleged|reports?|reported|rumou?rs?|rumou?red|suspects?|suspected|speculates?|speculated|thinks?|thought|assumes?|assumed|infers?|inferred|concludes?|concluded|remembers?|remembered|recalls?|recalled|says?|said|states?|stated|insists?|insisted|argues?|argued)/iu;
const AUDIT_SOURCE_SUBJECTIVE = /(?:[“”"]|\b(?:i|we)\s+(?:say|said|tell|told|claim|claimed|state|stated|insist|insisted|argue|argued|believe|believed|think|thought|suspect|suspected|remember|remembered|recall|recalled)\b|\b(?:according to|in (?:his|her|their|my|our) (?:view|memory|belief)|appears?|appeared|seems?|seemed|probably|possibly|perhaps|maybe|might|unconfirmed|disputed)\b|\b(?:belief|claim|allegation|rumou?r|report|record|dossier|testimony|perspective|inference|conclusion|memory)\b)/iu;
const AUDIT_SOURCE_AUTHORITATIVE = /\bOOC\s*:\s*(?:correction|canon|canonical|fact|established|actually|retcon)\b/iu;
const AUDIT_HISTORICAL_RELATIONSHIP = /\b(?:former|previous|prior|once|used to|had been|was|were|trained|raised|parent|apprentice|student|mentor)\b/iu;
const AUDIT_ENTITY_HISTORY = /\b(?:former|formerly|previous|prior|once|used to|served|commanded|member|trained|born|birth|parentage|biological parent|true identity|real identity)\b/iu;

function epistemicFactShape(item) {
    return AUDIT_ATTRIBUTED_CATEGORY.test(cleanText(item?.category))
        || AUDIT_ATTRIBUTED_PREDICATE.test(cleanText(item?.predicate));
}

function entityNamedBeforeAttributionVerb(index, value) {
    const source = cleanText(value);
    const people = index.entities.filter(personEntity);
    const namesFor = entity => {
        const names = [entity.name, ...(entity.aliases || [])].map(cleanText).filter(Boolean);
        for (const part of cleanText(entity.name).split(/\s+/u)) {
            if (part.length < 3) continue;
            const owners = people.filter(candidate => [candidate.name, ...(candidate.aliases || [])]
                .some(name => cleanText(name).split(/\s+/u).some(candidatePart => normalized(candidatePart) === normalized(part))));
            if (owners.length === 1) names.push(part);
        }
        return [...new Set(names)];
    };
    const matches = people.filter(entity => namesFor(entity).some(name => new RegExp(
            `(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])\\s*(?:(?:explicitly|reportedly|allegedly|firmly|privately|now|still)\\s+){0,3}${AUDIT_ACTIVE_ATTRIBUTION_VERB.source}\\b`,
            'iu',
        ).test(source)));
    return matches.length === 1 ? matches[0] : null;
}

function attributedPredicateLabel(item) {
    const predicate = cleanText(item?.predicate);
    const dash = predicate.match(/[—–]\s*(.+)$/u);
    if (dash?.[1]) return cleanText(dash[1]);
    return predicate.replace(/^(?:belief|claim|allegation|rumou?r|report|suspicion|speculation|perspective) about\s+[^:—–]+[:—–]?\s*/iu, '').trim()
        || cleanText(item?.category)
        || 'claim';
}

export function normalizeEpistemicFactShapes(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    let normalizedFacts = 0;
    for (const fact of result.facts) {
        if (!epistemicFactShape(fact)) continue;
        const currentCategory = normalized(fact?.category);
        const currentPredicate = cleanText(fact?.predicate);
        const explicitHolder = entityNamedBeforeAttributionVerb(index, fact?.value);
        if ((currentCategory === 'character belief' || currentCategory === 'former character belief')
            && AUDIT_ATTRIBUTED_PREDICATE.test(currentPredicate)
            && (!explicitHolder || normalized(explicitHolder.name) === normalized(fact?.subject))) continue;
        const subjectHolder = canonicalMention(index, fact?.subject);
        const holder = explicitHolder || (/\bcharacter\b/iu.test(cleanText(fact?.category)) ? subjectHolder : null);
        if (!personEntity(holder)) continue;
        const predicateTopicText = currentPredicate.match(/^(?:belief|claim|allegation|rumou?r|report|suspicion|speculation|perspective) about\s+(.+?)(?:\s*[—–:]\s*|$)/iu)?.[1];
        const predicateTopic = predicateTopicText ? (canonicalMention(index, predicateTopicText)?.name || cleanText(predicateTopicText)) : '';
        const topic = explicitlyMentionedPeople(index, `${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`)
            .find(person => normalized(person.name) !== normalized(holder.name));
        const canonicalTopic = predicateTopic && normalized(predicateTopic) !== normalized(holder.name)
            ? predicateTopic
            : (explicitHolder && subjectHolder && normalized(subjectHolder.name) !== normalized(holder.name)
            ? subjectHolder.name
            : (topic?.name || cleanText(fact?.subject)));
        if (!canonicalTopic) continue;
        fact.subject = holder.name;
        fact.predicate = `belief about ${canonicalTopic} — ${attributedPredicateLabel(fact)}`;
        fact.category = /\b(?:former|rejected|revised)\b/iu.test(cleanText(fact?.category)) ? 'former character belief' : 'character belief';
        fact.persistence = cleanText(fact?.persistence) || 'persistent';
        normalizedFacts++;
    }
    return normalizedFacts;
}

function auditEvidenceThreshold(value) {
    return Math.max(4, Math.min(9, Math.ceil(coverageTerms(value).size * 0.42)));
}

function sourceEvidenceParts(message) {
    const source = String(message?.text ?? message?.mes ?? '').replace(/\r/g, ' ');
    const chunks = source.split(/\n+|(?<=[.!?])\s+(?=[\p{L}\p{N}“"'*_<])/u)
        .map(cleanText).filter(value => value && !/^<\/?[^>]+>$/u.test(value) && value !== '```');
    const subjective = [];
    const objective = [];
    for (const chunk of chunks) {
        if (AUDIT_SOURCE_AUTHORITATIVE.test(chunk)) objective.push(chunk);
        else if (AUDIT_SOURCE_SUBJECTIVE.test(chunk) || /^\*[^*]+\*$/u.test(chunk)) subjective.push(chunk);
        else objective.push(chunk);
    }
    return { subjective, objective };
}

function strongestEvidenceWindow(reference, segments) {
    let strongest = 0;
    for (let index = 0; index < segments.length; index++) {
        for (let width = 1; width <= 3 && index + width <= segments.length; width++) {
            strongest = Math.max(strongest, coverageOverlap(reference, segments.slice(index, index + width).join(' ')));
        }
    }
    return strongest;
}

function sourceEvidenceProfile(reference, messages) {
    let subjective = 0;
    let objective = 0;
    for (const message of messages || []) {
        const parts = sourceEvidenceParts(message);
        subjective = Math.max(subjective, strongestEvidenceWindow(reference, parts.subjective));
        objective = Math.max(objective, strongestEvidenceWindow(reference, parts.objective));
    }
    return { subjective, objective };
}

function storedRecordSupportsReference(reference, records, match) {
    const threshold = auditEvidenceThreshold(reference);
    return (records || []).some(item => match(item) && coverageOverlap(reference, JSON.stringify(item)) >= threshold);
}

function sourceOnlySubjective(reference, messages) {
    const threshold = auditEvidenceThreshold(reference);
    const evidence = sourceEvidenceProfile(reference, messages);
    return evidence.subjective >= threshold && evidence.objective < threshold;
}

function novelEntityDescriptionTerms(entity, existing) {
    const baseline = new Set(coverageTerms(`${cleanText(entity?.name)} ${cleanText(existing?.description)}`));
    return new Set([...coverageTerms(entity?.description)].filter(term => !baseline.has(term)));
}

function descriptionDuplicatesAttributedPerspective(result, entity, existing) {
    const novel = novelEntityDescriptionTerms(entity, existing);
    if (novel.size < 2) return false;
    const required = Math.max(2, Math.min(4, Math.ceil(novel.size * 0.25)));
    return (result?.facts || []).some(fact => {
        if (!epistemicFactShape(fact)
            && !AUDIT_EPISTEMIC_CATEGORY.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.category)}`)) return false;
        const terms = coverageTerms(`${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`);
        return [...novel].filter(term => terms.has(term)).length >= required;
    });
}

function resolvedAuditIdentity(result, value) {
    const requested = normalized(value);
    const resolution = (result?.identityResolutions || []).find(item => normalized(item?.reference) === requested);
    return cleanText(resolution?.canonical) || cleanText(value);
}

function resolvedAuditPair(result, item) {
    return [resolvedAuditIdentity(result, item?.from), resolvedAuditIdentity(result, item?.to)]
        .map(normalized).filter(Boolean).sort().join('|');
}

function resolvedAuditRecordText(result, item) {
    let source = JSON.stringify(item);
    for (const resolution of result?.identityResolutions || []) {
        const reference = cleanText(resolution?.reference);
        const canonical = cleanText(resolution?.canonical);
        if (!reference || !canonical) continue;
        source = source.replace(new RegExp(escaped(reference), 'giu'), canonical);
    }
    return source;
}

export function findSourceAttributionConflicts(result, world, messages) {
    if (!Array.isArray(messages) || !messages.length) return [];
    const conflicts = [];
    for (const [index, fact] of (result?.facts || []).entries()) {
        if (epistemicFactShape(fact)
            || AUDIT_EPISTEMIC_CATEGORY.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.category)}`)
            || isAddressFact(fact)) continue;
        const reference = `${cleanText(fact?.subject)} ${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`;
        if (coverageTerms(reference).size < 4) continue;
        const storedSupport = storedRecordSupportsReference(reference, world?.facts, item =>
            normalized(canonicalMemorySubject(world, item?.subject)) === normalized(canonicalMemorySubject(world, fact?.subject))
            && normalized(item?.predicate) === normalized(fact?.predicate)
            && !epistemicFactShape(item));
        if (storedSupport || !sourceOnlySubjective(reference, messages)) continue;
        const label = `${cleanText(fact?.subject)} — ${cleanText(fact?.predicate)}`;
        conflicts.push({
            category: 'facts', index, label,
            warning: `Source-attribution conflict: objective fact “${label}” is supported only by character speech, thought, report, memory, or focalized inference in this excerpt; preserve the attributed claims separately and leave canon unknown.`,
        });
    }
    for (const [index, entity] of (result?.entities || []).entries()) {
        const reference = `${cleanText(entity?.name)} ${cleanText(entity?.description)}`;
        if (coverageTerms(reference).size < 5) continue;
        const existing = (world?.entities || []).find(item => normalized(item?.name) === normalized(entity?.name));
        if (existing && normalized(existing.description) === normalized(entity.description)) continue;
        const novelTerms = novelEntityDescriptionTerms(entity, existing);
        if (existing && novelTerms.size < 2) continue;
        const duplicatesPerspective = descriptionDuplicatesAttributedPerspective(result, entity, existing);
        if (!duplicatesPerspective && !AUDIT_ENTITY_HISTORY.test(cleanText(entity?.description)) && !existing) continue;
        const storedSupport = !existing && storedRecordSupportsReference(reference, world?.entities, item =>
            normalized(item?.name) === normalized(entity?.name));
        if (storedSupport || (!duplicatesPerspective && !sourceOnlySubjective(reference, messages))) continue;
        const resolvedPriorDescriptions = (result?.identityResolutions || [])
            .filter(resolution => normalized(resolution?.canonical) === normalized(entity?.name))
            .flatMap(resolution => (world?.entities || []).filter(item =>
                normalized(item?.name) === normalized(resolution?.reference)
                || (item?.aliases || []).some(alias => normalized(alias) === normalized(resolution?.reference))))
            .map(item => cleanText(item?.description))
            .filter(description => description && !/^Details about .+ remain disputed or attributed/iu.test(description))
            .sort((left, right) => right.length - left.length);
        conflicts.push({
            category: 'entities', index, label: cleanText(entity?.name),
            replacementDescription: existing ? cleanText(existing.description) : (resolvedPriorDescriptions[0] || null),
            warning: `Source-attribution conflict: entity description update for “${cleanText(entity?.name)}” presents character belief, interpretation, or disputed history as objective; retain the prior established description and store the perspective under its holder.`,
        });
    }
    for (const [index, relationship] of (result?.relationships || []).entries()) {
        const reference = `${cleanText(relationship?.from)} ${cleanText(relationship?.to)} ${cleanText(relationship?.kind)} ${cleanText(relationship?.dynamic)}`;
        if (!AUDIT_HISTORICAL_RELATIONSHIP.test(reference) || coverageTerms(reference).size < 5) continue;
        const pairIdentity = resolvedAuditPair(result, relationship);
        const threshold = auditEvidenceThreshold(reference);
        const storedSupport = (world?.relationships || []).some(item => resolvedAuditPair(result, item) === pairIdentity
            && coverageOverlap(reference, resolvedAuditRecordText(result, item)) >= threshold);
        if (storedSupport || !sourceOnlySubjective(reference, messages)) continue;
        const label = `${cleanText(relationship?.from)} ↔ ${cleanText(relationship?.to)}`;
        conflicts.push({
            category: 'relationships', index, label,
            warning: `Source-attribution conflict: relationship “${label}” is supported only by character speech, thought, report, memory, or focalized inference; retain it as attributed claims until objectively corroborated.`,
        });
    }
    const priority = { entities: 0, relationships: 1, facts: 2 };
    return conflicts
        .sort((left, right) => (priority[left.category] ?? 3) - (priority[right.category] ?? 3))
        .slice(0, 24);
}

export function applySourceAttributionFailClosed(result, conflicts) {
    const grouped = new Map();
    for (const conflict of conflicts || []) {
        const entries = grouped.get(conflict.category) || [];
        entries.push(conflict);
        grouped.set(conflict.category, entries);
    }
    let removed = 0;
    for (const category of ['facts', 'relationships']) {
        const indexes = [...new Set((grouped.get(category) || []).map(item => Number(item.index)).filter(Number.isInteger))]
            .sort((left, right) => right - left);
        for (const index of indexes) {
            if (!Array.isArray(result?.[category]) || index < 0 || index >= result[category].length) continue;
            result[category].splice(index, 1);
            removed++;
        }
    }
    for (const conflict of grouped.get('entities') || []) {
        const entity = result?.entities?.[Number(conflict.index)];
        if (!entity) continue;
        entity.description = conflict.replacementDescription !== null && conflict.replacementDescription !== undefined
            ? cleanText(conflict.replacementDescription)
            : `Details about ${cleanText(entity.name)} remain disputed or attributed in this excerpt; consult character perspectives and source history.`;
        removed++;
    }
    return removed;
}

function durableAuditRecords(result) {
    return ['facts', 'states', 'relationships', 'threads', 'backgrounds']
        .flatMap(key => Array.isArray(result?.[key]) ? result[key] : [])
        .map(item => JSON.stringify(item));
}

function consequenceCovered(event, records) {
    const excluded = new Set((event?.participants || []).flatMap(coverageTerms));
    const terms = [...coverageTerms(event?.consequences)].filter(term => !excluded.has(term));
    if (terms.length < 2) return true;
    return records.some(record => {
        const recordTerms = coverageTerms(record);
        const matches = terms.filter(term => recordTerms.has(term)).length;
        return matches >= Math.max(2, Math.min(4, Math.ceil(terms.length * 0.4)));
    });
}

function sceneStateWarnings(result, world) {
    const sceneLocation = cleanText(result?.scene?.location || result?.sceneCapsule?.location);
    if (!sceneLocation) return [];
    const evidenceWorld = { ...(world || {}), entities: [...(world?.entities || []), ...(result?.entities || [])] };
    const participants = new Set([...(result?.scene?.participants || []), ...(result?.sceneCapsule?.participants || [])]
        .map(value => normalized(canonicalMemorySubject(evidenceWorld, value))).filter(Boolean));
    return (result?.states || []).filter(item => normalized(canonicalStateAttribute(item?.attribute)) === 'location'
        && normalized(item?.operation || 'set') !== 'clear'
        && participants.has(normalized(canonicalMemorySubject(evidenceWorld, item?.subject)))
        && normalized(item?.value) !== normalized(sceneLocation)
        && coverageOverlap(item?.value, sceneLocation) < 2)
        .slice(0, 2)
        .map(item => `Scene/state conflict: ${cleanText(item.subject)} is placed at “${cleanText(item.value)}” while the current scene is “${sceneLocation}”.`);
}

function possessionWarnings(result, world) {
    const evidenceWorld = { ...(world || {}), entities: [...(world?.entities || []), ...(result?.entities || [])] };
    const finalStates = new Map((world?.states || []).filter(isActiveState)
        .map(item => [stateIdentity(evidenceWorld, item), item]));
    for (const item of result?.states || []) {
        const identity = stateIdentity(evidenceWorld, item);
        if (!identity) continue;
        if (normalized(item?.operation) === 'clear') finalStates.delete(identity);
        else finalStates.set(identity, item);
    }
    const ownersByObject = new Map();
    for (const item of finalStates.values()) {
        if (!AUDIT_POSSESSION_ATTRIBUTE.test(cleanText(item?.attribute))) continue;
        const object = canonicalMention(continuityEntityIndex(result, world), item?.value);
        if (!object || !AUDIT_OBJECT_TYPE.test(cleanText(object?.type))) continue;
        const objectName = cleanText(object.name);
        const owners = ownersByObject.get(normalized(objectName)) || { objectName, subjects: new Set() };
        owners.subjects.add(cleanText(canonicalMemorySubject(evidenceWorld, item?.subject)));
        ownersByObject.set(normalized(objectName), owners);
    }
    return [...ownersByObject.values()].filter(item => item.subjects.size > 1).slice(0, 2)
        .map(item => `Possession conflict: ${item.objectName} is simultaneously assigned to ${[...item.subjects].join(' and ')} without a supported transfer or shared-ownership explanation.`);
}

function factConsistencyWarnings(result, world) {
    const warnings = [];
    for (const fact of result?.facts || []) {
        const identityText = `${cleanText(fact?.predicate)} ${cleanText(fact?.category)}`;
        if (!AUDIT_EPISTEMIC_CATEGORY.test(identityText) && AUDIT_SUBJECTIVE_VALUE.test(cleanText(fact?.value))) {
            warnings.push(`Epistemic conflict: “${cleanText(fact.subject)} — ${cleanText(fact.predicate)}” contains a belief, claim, or uncertainty but is categorized as objective.`);
        }
        if (!AUDIT_IMMUTABLE_IDENTITY.test(identityText) && !AUDIT_ROLE_IDENTITY.test(identityText)) continue;
        const stored = (world?.facts || []).find(item => normalized(canonicalMemorySubject(world, item?.subject)) === normalized(canonicalMemorySubject(world, fact?.subject))
            && normalized(item?.predicate) === normalized(fact?.predicate)
            && normalized(item?.category) === normalized(fact?.category));
        if (!stored || normalized(stored?.value) === normalized(fact?.value) || coverageOverlap(stored?.value, fact?.value) >= 2) continue;
        const transitionExplained = AUDIT_TEMPORAL_TRANSITION.test(`${cleanText(stored?.value)} ${cleanText(fact?.value)}`);
        if (AUDIT_IMMUTABLE_IDENTITY.test(identityText) || !transitionExplained) {
            warnings.push(`Identity/role conflict: ${cleanText(fact.subject)} has incompatible “${cleanText(fact.predicate)}” values without an explicit transition.`);
        }
    }
    return warnings.slice(0, 3);
}

function threadLifecycleWarnings(result) {
    const warnings = [];
    for (const thread of result?.threads || []) {
        const status = normalized(thread?.status);
        const detail = cleanText(thread?.detail);
        if (status === 'resolved' && THREAD_GAP.test(detail)) {
            warnings.push(`Thread lifecycle conflict: resolved thread “${cleanText(thread.title)}” still describes an unresolved condition.`);
        } else if (status === 'open' && THREAD_RESOLUTION.test(detail) && !THREAD_GAP.test(detail)) {
            warnings.push(`Thread lifecycle conflict: open thread “${cleanText(thread.title)}” describes only a completed condition.`);
        }
    }
    return warnings.slice(0, 2);
}

export function findTypedContinuityWarnings(result, world) {
    const warnings = [];
    const records = durableAuditRecords(result);
    for (const event of result?.events || []) {
        const consequences = cleanText(event?.consequences);
        if (Number(event?.importance || 0) < 4 || !consequences || /^(?:none|n\/a|unknown)$/iu.test(consequences)) continue;
        if (!consequenceCovered(event, records)) {
            warnings.push(`Typed coverage gap: major event “${cleanText(event.title)}” has a consequence that is not represented as a durable fact, state, relationship, thread, or background.`);
        }
    }
    warnings.push(...factConsistencyWarnings(result, world));
    warnings.push(...sceneStateWarnings(result, world));
    warnings.push(...possessionWarnings(result, world));
    warnings.push(...threadLifecycleWarnings(result));
    const temporal = result?.sceneCapsule?.temporal;
    if (cleanText(temporal?.elapsed) && normalized(temporal?.relation) === 'unknown') {
        warnings.push('Temporal conflict: an explicit elapsed interval was supplied without identifying what it is relative to.');
    }
    return [...new Set(warnings)].slice(0, 8);
}

export function findCoverageWarnings(result, messages) {
    return uncoveredDurableBeats(result, messages)
        .map(beat => `Potential durable detail remains only in L1: ${beat}`);
}

function explicitlyAttributesSpeech(text, speakerNames, form) {
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const speechVerb = '(?:says?|said|asks?|asked|replies?|replied|calls?|called|introduces?|introduced|identifies?|identified)';
    return speakerNames.some(name => {
        const speaker = escaped(name);
        if (!speaker) return false;
        return [
            new RegExp(`(?:^|[\\n\\r])\\s*(?:[*_]{1,2})?${speaker}(?:[*_]{1,2})?\\s*:\\s*(?:[*_]{1,2})?[^\\n\\r]{0,500}${formPattern}`, 'iu'),
            new RegExp(`\\b${speaker}\\b\\s+(?:\\w+\\s+){0,3}${speechVerb}\\b[^“”"\\n\\r]{0,40}[“"]?[^“”"\\n\\r]{0,200}${formPattern}`, 'iu'),
            new RegExp(`[“"][^“”"\\n\\r]{0,240}${formPattern}[^“”"\\n\\r]{0,240}[”"]\\s*[,.:;!?—–-]*\\s*\\b${speechVerb}\\s+\\b${speaker}\\b`, 'iu'),
            new RegExp(`[“"][^“”"\\n\\r]{0,240}${formPattern}[^“”"\\n\\r]{0,240}[”"]\\s*[,.:;!?—–-]*\\s*\\b${speaker}\\b\\s+(?:\\w+\\s+){0,3}${speechVerb}\\b`, 'iu'),
            new RegExp(`[“"][^“”"\\n\\r]{0,240}${formPattern}[^“”"\\n\\r]{0,240}[”"]\\s*[,.:;!?—–-]*\\s*\\b${speaker}[’']s\\s+(?:voice|tone|words?)\\b`, 'iu'),
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

function directlyVoicesFirstPersonSpeech(text, form) {
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const quoted = new RegExp(`[“\"][^”\"\n\r]{0,240}${formPattern}[^”\"\n\r]{0,240}[”\"]`, 'iu').test(text);
    const firstPersonSpeech = /\bI\b[^\n\r]{0,100}\b(?:say|said|ask|asked|reply|replied|shout|shouted|yell|yelled|call|called)\b|\b(?:say|said|ask|asked|reply|replied|shout|shouted|yell|yelled|call|called)\b[^\n\r]{0,100}\bI\b/iu.test(text);
    const firstPersonActionAfterQuote = new RegExp(`[“"][^”"\n\r]{0,240}${formPattern}[^”"\n\r]{0,240}[”"]\\s{0,20}\\bI\\b`, 'iu').test(text);
    return quoted && (firstPersonSpeech || firstPersonActionAfterQuote);
}

function quotedSpeechOccurrences(text) {
    const segments = [];
    const pattern = /[“"]([^”"\n\r]{1,500})[”"]/gu;
    for (const match of String(text || '').matchAll(pattern)) {
        segments.push({ segment: match[1], start: match.index, end: match.index + match[0].length });
    }
    return segments;
}

function quotedSpeechSegments(text) {
    return quotedSpeechOccurrences(text).map(item => item.segment);
}

function labeledSpeechSegments(text, speakerNames) {
    const segments = [];
    for (const name of speakerNames) {
        const speaker = escaped(name);
        if (!speaker) continue;
        const pattern = new RegExp(`(?:^|[\\n\\r])\\s*(?:[*_]{1,2})?${speaker}(?:[*_]{1,2})?\\s*:\\s*(?:[*_]{1,2})?([^\\n\\r]{1,500})`, 'giu');
        for (const match of String(text || '').matchAll(pattern)) segments.push(match[1]);
    }
    return segments;
}

function isVocativeUse(text, form) {
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const trailing = `(?=\\s*(?:[,!?.:;—–-]|$))`;
    const leadingCue = '(?:(?:hey|hello|hi|oi|yo|listen|look|please|thanks|sorry|welcome|good morning|good evening|shut up)\\b[\\s,!?:;—–-]*)*';
    return [
        new RegExp(`^\\s*${leadingCue}${formPattern}${trailing}`, 'iu'),
        new RegExp(`(?:[,;:!?—–-]|[.!?]\\s+)\\s*${formPattern}${trailing}`, 'iu'),
    ].some(pattern => pattern.test(String(text || '')));
}

function hasFirstPersonAddressCue(text, form) {
    const formPattern = escaped(form);
    if (!formPattern) return false;
    return new RegExp(`\\bI\\s+(?:(?:tell|told|ask|asked|call|called|address|addressed)\\s+|(?:say|said|shout|shouted|yell|yelled)\\s+(?:to\\s+)?)${formPattern}(?=\\s|[,!?.:;—–-]|$)`, 'iu')
        .test(String(text || ''));
}

function assistantOwnVocativeEvidence(message, world, speaker, form) {
    if (message?.isUser || canonicalAddressName(world, message?.name) !== canonicalAddressName(world, speaker)) return false;
    const text = String(message?.text ?? message?.mes ?? '');
    const speechVerb = '(?:says?|said|asks?|asked|replies?|replied|shouts?|shouted|yells?|yelled|calls?|called)';
    const otherNames = (world?.entities || [])
        .filter(entity => canonicalAddressName(world, entity?.name) !== canonicalAddressName(world, speaker))
        .flatMap(entity => addressNameVariants(world, entity?.name));
    return quotedSpeechOccurrences(text).some(({ segment, start, end }) => {
        if (!containsAddressForm(segment, form) || !isVocativeUse(segment, form)) return false;
        const before = text.slice(Math.max(0, start - 120), start);
        const after = text.slice(end, end + 120);
        const metalinguisticQuote = /\b(?:calls?|called|addresses?|addressed|nicknames?|nicknamed|refers? to|referred to|dubs?|dubbed)\b[^“”"\n\r]{0,80}$/iu.test(before);
        if (metalinguisticQuote) return false;
        const attributedElsewhere = otherNames.some(name => {
            const candidate = escaped(name);
            if (!candidate) return false;
            const beforePattern = new RegExp(`\\b${candidate}\\b\\s+(?:\\w+\\s+){0,3}${speechVerb}\\b[\\s,:;—–-]*$`, 'iu');
            const afterPattern = new RegExp(`^\\s*[,.:;!?—–-]*\\s*(?:\\b${candidate}\\b\\s+(?:\\w+\\s+){0,3}${speechVerb}\\b|${speechVerb}\\s+\\b${candidate}\\b|\\b${candidate}[’']s\\s+(?:voice|tone|words?)\\b)`, 'iu');
            return beforePattern.test(before) || afterPattern.test(after);
        });
        return !attributedElsewhere;
    });
}

function hasExplicitDirectionalAddressStatement(item, form, messages, world) {
    const speakerNames = addressNameVariants(world, item?.subject);
    const addresseeNames = addressNameVariants(world, addressFactAddressee(item));
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const addressVerb = '(?:calls?|called|addresses?|addressed|nicknames?|nicknamed|dubs?|dubbed|refers? to|referred to)';
    const quotedForm = `[“"']\\s*${formPattern}\\s*[”"']`;
    return (messages || []).some(message => {
        const source = String(message?.text ?? message?.mes ?? '');
        const authoredBySpeaker = Boolean(message?.isUser)
            && canonicalAddressName(world, message?.name) === canonicalAddressName(world, item?.subject);
        const namedDirection = speakerNames.some(speakerName => addresseeNames.some(addresseeName =>
            new RegExp(`\\b${escaped(speakerName)}\\b[^\\n\\r]{0,100}\\b${addressVerb}\\b[^\\n\\r]{0,100}\\b${escaped(addresseeName)}\\b[^\\n\\r]{0,80}${quotedForm}`, 'iu').test(source)));
        const firstPersonDirection = authoredBySpeaker && addresseeNames.some(addresseeName =>
            new RegExp(`\\bI\\b[^\\n\\r]{0,40}\\b${addressVerb}\\b[^\\n\\r]{0,100}\\b${escaped(addresseeName)}\\b[^\\n\\r]{0,80}${quotedForm}`, 'iu').test(source));
        return namedDirection || firstPersonDirection;
    });
}

function hasVocativeAddressEvidence(item, form, messages, world) {
    const speaker = canonicalAddressName(world, item?.subject);
    const speakerNames = addressNameVariants(world, item?.subject);
    return (messages || []).some(message => {
        const source = String(message?.text ?? message?.mes ?? '');
        if (!containsAddressForm(source, form)) return false;
        const authoredUserSpeech = Boolean(message?.isUser)
            && canonicalAddressName(world, message?.name) === speaker;
        const authoredAssistantSpeech = assistantOwnVocativeEvidence(message, world, item?.subject, form);
        const firstPersonSpeech = directlyVoicesFirstPersonSpeech(source, form);
        const attributedSpeech = explicitlyAttributesSpeech(source, speakerNames, form);
        const segments = [...quotedSpeechSegments(source), ...labeledSpeechSegments(source, speakerNames)];
        if (authoredUserSpeech || attributedSpeech) segments.push(source);
        return authoredAssistantSpeech || segments.some(segment => isVocativeUse(segment, form))
            && (authoredUserSpeech || firstPersonSpeech || attributedSpeech);
    });
}

export function removeUnsupportedAddressValues(container, messages, world = null) {
    if (!Array.isArray(container?.facts) || !Array.isArray(messages) || !messages.length) return 0;
    const empty = new Set();
    let removed = 0;
    for (const item of container.facts) {
        if (!isAddressFact(item)) continue;
        const retained = [];
        for (const form of mergeAddressValues(item.value).split(/\s*;\s*/u).filter(Boolean)) {
            const explicitDirection = hasExplicitDirectionalAddressStatement(item, form, messages, world);
            const supported = explicitDirection
                || (!addressFormNamesSpeaker(item, form, world)
                    && hasVocativeAddressEvidence(item, form, messages, world));
            if (supported) retained.push(form);
            else removed++;
        }
        item.value = mergeAddressValues(...retained);
        if (!item.value) empty.add(item);
    }
    container.facts = container.facts.filter(item => !empty.has(item));
    return removed;
}

function hasAuthoredVocativeEvidence(messages, world, speaker, form) {
    const canonicalSpeaker = canonicalAddressName(world, speaker);
    const speakerNames = addressNameVariants(world, speaker);
    return (messages || []).some(message => {
        const text = String(message?.text ?? message?.mes ?? '');
        const userEvidence = Boolean(message?.isUser)
            && canonicalAddressName(world, message?.name) === canonicalSpeaker
            && containsAddressForm(text, form)
            && ([...quotedSpeechSegments(text), ...labeledSpeechSegments(text, speakerNames), text]
                .some(segment => isVocativeUse(segment, form)) || hasFirstPersonAddressCue(text, form));
        return userEvidence || assistantOwnVocativeEvidence(message, world, speaker, form);
    });
}

function hasAddressSpeechEvidence(messages, world, speaker, form) {
    const canonicalSpeaker = canonicalAddressName(world, speaker);
    const speakerNames = addressNameVariants(world, speaker);
    return (messages || []).some(message => {
        const text = String(message?.text ?? message?.mes ?? '');
        if (!containsAddressForm(text, form)) return false;
        const authoredUser = Boolean(message?.isUser)
            && canonicalAddressName(world, message?.name) === canonicalSpeaker;
        const authoredVocative = hasAuthoredVocativeEvidence([message], world, speaker, form);
        const authoredDirectly = authoredVocative
            || (authoredUser && directlyVoicesFirstPersonSpeech(text, form));
        return authoredDirectly || explicitlyAttributesSpeech(text, speakerNames, form);
    });
}

function hasDirectionalAddressSpeechEvidence(messages, world, speaker, addressee, form) {
    const canonicalSpeaker = canonicalAddressName(world, speaker);
    const speakerNames = addressNameVariants(world, speaker);
    const addresseeNames = addressNameVariants(world, addressee);
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const addresseeContext = (messages || []).some(message => {
        const text = String(message?.text ?? message?.mes ?? '');
        return containsAddressForm(text, form)
            && addresseeNames.some(name => new RegExp(`\\b${escaped(name)}\\b`, 'iu').test(text));
    });
    return (messages || []).some(message => {
        const text = String(message?.text ?? message?.mes ?? '');
        if (!containsAddressForm(text, form)) return false;
        const authoredUser = Boolean(message?.isUser)
            && canonicalAddressName(world, message?.name) === canonicalSpeaker;
        const authoredVocative = hasAuthoredVocativeEvidence([message], world, speaker, form);
        const authoredDirectly = authoredVocative
            || (authoredUser && directlyVoicesFirstPersonSpeech(text, form));
        if (authoredDirectly && addresseeContext) return true;
        const explicitlyDirectional = speakerNames.some(speakerName => addresseeNames.some(addresseeName =>
            new RegExp(`\\b${escaped(speakerName)}\\b[^\\n\\r]{0,100}\\b(?:calls?|called|addresses?|addressed|nicknames?|nicknamed)\\s+\\b${escaped(addresseeName)}\\b[^\\n\\r]{0,100}${formPattern}`, 'iu').test(text)));
        if (explicitlyDirectional) return true;
        if (!explicitlyAttributesSpeech(text, speakerNames, form)) return false;
        return addresseeNames.some(name => {
            const addresseePattern = escaped(name);
            if (!addresseePattern) return false;
            return new RegExp(`\\b${addresseePattern}\\b[^\\n\\r]{0,240}${formPattern}|${formPattern}[^\\n\\r]{0,240}\\b${addresseePattern}\\b`, 'iu').test(text);
        });
    });
}

export function repairReversedAddressFacts(result, world, messages) {
    if (!Array.isArray(result?.facts) || !Array.isArray(messages) || !messages.length) return 0;
    const originalFacts = [...result.facts];
    const empty = new Set();
    let repaired = 0;
    for (const item of originalFacts) {
        if (!isAddressFact(item) || isSelfAddressFact(item, world)) continue;
        const speaker = canonicalAddressDisplayName(world, item.subject);
        const addressee = canonicalAddressDisplayName(world, addressFactAddressee(item));
        if (!speaker || !addressee) continue;
        const retained = [];
        const reversed = [];
        for (const form of mergeAddressValues(item.value).split(/\s*;\s*/u).filter(Boolean)) {
            const forwardEvidence = hasAddressSpeechEvidence(messages, world, speaker, form);
            const reverseEvidence = hasAddressSpeechEvidence(messages, world, addressee, form);
            const forwardAuthored = hasAuthoredVocativeEvidence(messages, world, speaker, form);
            const reverseAuthored = hasAuthoredVocativeEvidence(messages, world, addressee, form);
            if ((reverseAuthored && !forwardAuthored) || (reverseEvidence && !forwardEvidence)) reversed.push(form);
            else retained.push(form);
        }
        if (!reversed.length) continue;
        item.value = mergeAddressValues(...retained);
        if (!item.value) empty.add(item);
        const reverseCandidate = { subject: addressee, predicate: `calls ${speaker}`, category: 'form of address' };
        const reverseIdentity = addressFactIdentity(reverseCandidate, world);
        const existing = result.facts.find(candidate => candidate !== item
            && addressFactIdentity(candidate, world) === reverseIdentity);
        if (existing) {
            existing.value = mergeAddressValues(existing.value, ...reversed);
        } else {
            const stored = (world?.facts || []).find(candidate => addressFactIdentity(candidate, world) === reverseIdentity);
            const storedValues = addressValueSet(stored?.value);
            const novelReversed = reversed.filter(form => !storedValues.has(normalized(form)));
            if (novelReversed.length) {
                result.facts.push({
                    targetId: stored?.id || '',
                    subject: addressee,
                    predicate: `calls ${speaker}`,
                    value: mergeAddressValues(...novelReversed),
                    category: 'form of address',
                    importance: Number(item.importance || 2),
                    persistence: ['temporary', 'recurring', 'persistent'].includes(item.persistence) ? item.persistence : 'recurring',
                });
            }
        }
        repaired += reversed.length;
    }
    result.facts = result.facts.filter(item => !empty.has(item));
    return repaired;
}

export function removeCrossDirectionAddressContamination(result, world, messages) {
    if (!Array.isArray(result?.facts) || !Array.isArray(world?.facts)) return 0;
    const incomingValuesByDirection = new Map();
    for (const item of result.facts) {
        if (!isAddressFact(item) || isSelfAddressFact(item, world)) continue;
        const identity = addressFactIdentity(item, world);
        if (!identity) continue;
        const values = incomingValuesByDirection.get(identity) || new Set();
        for (const form of addressValueSet(item.value)) values.add(form);
        incomingValuesByDirection.set(identity, values);
    }
    const empty = new Set();
    let discarded = 0;
    for (const item of result.facts) {
        if (!isAddressFact(item) || isSelfAddressFact(item, world)) continue;
        const speaker = canonicalAddressDisplayName(world, item.subject);
        const addressee = canonicalAddressDisplayName(world, addressFactAddressee(item));
        const identity = addressFactIdentity(item, world);
        const oppositeIdentity = addressFactIdentity({
            subject: addressee,
            predicate: `calls ${speaker}`,
            category: 'form of address',
        }, world);
        if (!identity || !oppositeIdentity) continue;
        const sameDirection = new Set();
        const oppositeDirection = new Set();
        for (const stored of world.facts) {
            const storedIdentity = addressFactIdentity(stored, world);
            const target = storedIdentity === identity
                ? sameDirection
                : storedIdentity === oppositeIdentity ? oppositeDirection : null;
            if (!target) continue;
            for (const form of addressValueSet(stored.value)) target.add(form);
        }
        for (const form of incomingValuesByDirection.get(oppositeIdentity) || []) {
            oppositeDirection.add(form);
        }
        if (!oppositeDirection.size) continue;
        const retained = [];
        for (const form of mergeAddressValues(item.value).split(/\s*;\s*/u).filter(Boolean)) {
            const formIdentity = normalized(form);
            const copiedFromOpposite = oppositeDirection.has(formIdentity) && !sameDirection.has(formIdentity);
            const newlySupportedHere = hasDirectionalAddressSpeechEvidence(messages, world, speaker, addressee, form);
            if (copiedFromOpposite && !newlySupportedHere) discarded++;
            else retained.push(form);
        }
        item.value = mergeAddressValues(...retained);
        if (!item.value) empty.add(item);
    }
    result.facts = result.facts.filter(item => !empty.has(item));
    return discarded;
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

function addressValueSet(value) {
    return new Set(mergeAddressValues(value).split(/\s*;\s*/u).map(normalized).filter(Boolean));
}

function addressValuesOverlap(left, right) {
    const rightValues = addressValueSet(right);
    return [...addressValueSet(left)].some(value => rightValues.has(value));
}

function mergeSourceReferences(...collections) {
    const seen = new Set();
    return collections.flat().filter(item => {
        const identity = JSON.stringify(item);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

export function reconcileGenericAddressDuplicates(container, world = container) {
    if (!Array.isArray(container?.facts)) return 0;
    const localFacts = container.facts;
    const candidates = [...localFacts, ...(container === world ? [] : world?.facts || [])]
        .filter(isAddressFact)
        .map(item => ({ item, local: localFacts.includes(item), identity: addressFactIdentity(item, world) }))
        .filter(candidate => candidate.identity);
    let reconciled = 0;
    container.facts = localFacts.filter(item => {
        if (!isGenericAddressFact(item)) return true;
        const speaker = canonicalAddressName(world, item.subject);
        const anchor = String(item.temporalAnchorId || '');
        const matching = candidates.filter(candidate => {
            const candidateSpeaker = canonicalAddressName(world, candidate.item.subject);
            const candidateAnchor = String(candidate.item.temporalAnchorId || '');
            return speaker && speaker === candidateSpeaker
                && (!anchor || !candidateAnchor || anchor === candidateAnchor)
                && addressValuesOverlap(item.value, candidate.item.value);
        });
        const identities = [...new Set(matching.map(candidate => candidate.identity))];
        if (identities.length !== 1) return true;
        const local = matching.find(candidate => candidate.local);
        const canonical = local || matching[0];
        if (local) {
            local.item.value = mergeAddressValues(local.item.value, item.value);
            local.item.sources = mergeSourceReferences(local.item.sources || [], item.sources || []);
            const importance = Math.max(Number(local.item.importance || 0), Number(item.importance || 0));
            if (importance > 0) local.item.importance = importance;
            reconciled++;
            return false;
        }
        const addressee = addressFactAddressee(canonical.item);
        item.subject = canonical.item.subject;
        item.predicate = `calls ${addressee}`;
        item.category = 'form of address';
        item.targetId = canonical.item.id || item.targetId || '';
        reconciled++;
        return true;
    });
    return reconciled;
}

export function removeInvalidAddressFacts(container) {
    if (!Array.isArray(container?.facts)) return 0;
    let removed = 0;
    container.facts = container.facts.filter(item => {
        if (isGenericAddressFact(item)) return true;
        if (!isAddressFact(item)) return true;
        const fields = [item?.subject, item?.predicate, addressFactAddressee(item)];
        const invalid = fields.some(value => !String(value || '').trim()
            || !ADDRESS_MEANINGFUL.test(String(value))
            || ADDRESS_PLACEHOLDER.test(String(value))
            || ADDRESS_BRACKET.test(String(value)));
        if (invalid) {
            removed++;
            return false;
        }
        const forms = mergeAddressValues(item.value).split(/\s*;\s*/u).filter(Boolean);
        if (!forms.length) {
            removed++;
            return false;
        }
        const retained = forms.filter(form => {
            const invalidForm = !ADDRESS_MEANINGFUL.test(form)
                || ADDRESS_PLACEHOLDER.test(form)
                || ADDRESS_BRACKET.test(form)
                || ADDRESS_ABSENCE.test(form)
                || ADDRESS_CLAUSE_START.test(form);
            if (invalidForm) removed++;
            return !invalidForm;
        });
        item.value = mergeAddressValues(...retained);
        return Boolean(item.value);
    });
    return removed;
}

function hasExplicitPronounAddressEvidence(item, form, messages, world) {
    const speaker = canonicalAddressName(world, item?.subject);
    const speakerNames = addressNameVariants(world, item?.subject);
    const addresseeNames = addressNameVariants(world, addressFactAddressee(item));
    const quotedForm = new RegExp(`[“”"'‘’]\\s*${escaped(form)}\\s*[“”"'‘’]`, 'iu');
    return (messages || []).some(message => {
        const source = String(message?.text ?? message?.mes ?? '');
        if (!quotedForm.test(source) || !ADDRESS_PRONOUN_SIGNIFICANCE.test(source)) return false;
        const authoredFirstPerson = canonicalAddressName(world, message?.name) === speaker && /\bI\b/u.test(source);
        const explicitSpeaker = speakerNames.some(name => containsAddressForm(source, name));
        const explicitAddressee = addresseeNames.some(name => containsAddressForm(source, name));
        return explicitAddressee && (authoredFirstPerson || explicitSpeaker);
    });
}

export function removeUnsupportedPronounAddressValues(container, messages, world = null) {
    if (!Array.isArray(container?.facts)) return 0;
    const empty = new Set();
    let removed = 0;
    for (const item of container.facts) {
        if (!isAddressFact(item)) continue;
        const retained = [];
        let removedFromItem = 0;
        for (const form of mergeAddressValues(item.value).split(/\s*;\s*/u).filter(Boolean)) {
            if (ADDRESS_PRONOUN.test(form) && !hasExplicitPronounAddressEvidence(item, form, messages, world)) {
                removed++;
                removedFromItem++;
            }
            else retained.push(form);
        }
        if (!removedFromItem) continue;
        item.value = mergeAddressValues(...retained);
        if (!item.value) empty.add(item);
    }
    container.facts = container.facts.filter(item => !empty.has(item));
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

function messagesForTemporalAnchor(messages, anchorId) {
    const match = String(anchorId || '').match(/-(\d+)-(\d+)$/u);
    if (!match) return messages || [];
    const from = Number(match[1]);
    const to = Number(match[2]);
    return (messages || []).filter(message => Number(message?.index) >= from && Number(message?.index) <= to);
}

function repairReversedStoredAddressFacts(world, messages) {
    if (!Array.isArray(world?.facts) || !Array.isArray(messages) || !messages.length) return 0;
    let repaired = 0;
    for (const item of world.facts) {
        if (!isAddressFact(item) || isSelfAddressFact(item, world)) continue;
        const speaker = canonicalAddressDisplayName(world, item.subject);
        const addressee = canonicalAddressDisplayName(world, addressFactAddressee(item));
        if (!speaker || !addressee) continue;
        const evidence = messagesForTemporalAnchor(messages, item.temporalAnchorId);
        const forms = mergeAddressValues(item.value).split(/\s*;\s*/u).filter(Boolean);
        if (!forms.length || !forms.every(form => {
            const reverseAuthored = hasAuthoredVocativeEvidence(evidence, world, addressee, form);
            const forwardAuthored = hasAuthoredVocativeEvidence(evidence, world, speaker, form);
            return (reverseAuthored && !forwardAuthored)
                || (hasAddressSpeechEvidence(evidence, world, addressee, form)
                    && !hasAddressSpeechEvidence(evidence, world, speaker, form));
        })) continue;
        item.subject = addressee;
        item.predicate = `calls ${speaker}`;
        item.category = 'form of address';
        repaired += forms.length;
    }
    return repaired;
}

function removeImpossibleStoredAddressValues(world, messages) {
    if (!Array.isArray(world?.facts)) return 0;
    const empty = new Set();
    let removed = 0;
    for (const item of world.facts) {
        if (!isAddressFact(item)) continue;
        const evidence = messagesForTemporalAnchor(messages, item.temporalAnchorId);
        const retained = [];
        for (const form of mergeAddressValues(item.value).split(/\s*;\s*/u).filter(Boolean)) {
            const impossible = addressFormNamesSpeaker(item, form, world)
                && !hasExplicitDirectionalAddressStatement(item, form, evidence, world);
            if (impossible) removed++;
            else retained.push(form);
        }
        item.value = mergeAddressValues(...retained);
        if (!item.value) empty.add(item);
    }
    world.facts = world.facts.filter(item => !empty.has(item));
    return removed;
}

function restoreStoredAddressValuesFromReplay(world) {
    if (!Array.isArray(world?.facts) || !Array.isArray(world?.extractions)) return 0;
    const canonical = new Map(world.facts
        .filter(isAddressFact)
        .map(item => [addressFactIdentity(item, world), item])
        .filter(([identity]) => identity));
    let restored = 0;
    for (const extraction of world.extractions) {
        for (const item of extraction?.result?.facts || []) {
            if (!isAddressFact(item)) continue;
            const stored = canonical.get(addressFactIdentity(item, world));
            if (!stored || stored.correctionId) continue;
            const before = addressValueSet(stored.value);
            stored.value = mergeAddressValues(stored.value, item.value);
            restored += [...addressValueSet(stored.value)].filter(value => !before.has(value)).length;
        }
    }
    return restored;
}

export function removeInvalidStoredAddressFacts(world, messages = null) {
    let changed = normalizeDirectionalAddressFacts(world, world);
    changed += reconcileGenericAddressDuplicates(world, world);
    changed += repairReversedStoredAddressFacts(world, messages);
    changed += removeImpossibleStoredAddressValues(world, messages);
    changed += removeInvalidAddressFacts(world);
    const correctedAddressSelectors = new Set((world?.corrections || [])
        .flatMap(correction => correction?.operations || [])
        .filter(operation => operation?.category === 'facts' && ['update', 'delete'].includes(operation?.action))
        .map(operation => String(operation?.beforeSelector || ''))
        .filter(Boolean));
    for (const extraction of world?.extractions || []) {
        const extractionMessages = (messages || []).filter(message => Number(message?.index) >= Number(extraction?.from)
            && Number(message?.index) <= Number(extraction?.to));
        changed += normalizeDirectionalAddressFacts(extraction?.result, world);
        changed += repairReversedAddressFacts(extraction?.result, world, extractionMessages);
        changed += reconcileGenericAddressDuplicates(extraction?.result, world);
        changed += removeUnsupportedAddressValues(extraction?.result, extractionMessages, world);
        changed += removeInvalidAddressFacts(extraction?.result);
        if (!Array.isArray(extraction?.result?.facts) || !correctedAddressSelectors.size) continue;
        const retained = extraction.result.facts.filter(item => !isAddressFact(item)
            || !correctedAddressSelectors.has(addressFactIdentity(item)));
        changed += extraction.result.facts.length - retained.length;
        extraction.result.facts = retained;
    }
    changed += restoreStoredAddressValuesFromReplay(world);
    return changed;
}

export function reconciliationTargetIsCompatible(category, incoming, existing, world = null, result = null) {
    if (!existing) return false;
    const same = (left, right) => Boolean(normalized(left) && normalized(left) === normalized(right));
    const sameSubject = (left, right) => same(canonicalMemorySubject(world, left), canonicalMemorySubject(world, right));
    if (category === 'entities') {
        // Entity target IDs are identity anchors. Fuzzy subject resolution is
        // useful for facts, but is unsafe here: "Toska's Master" must never be
        // allowed to claim Toska's ID merely because the names share a token.
        const incomingName = normalized(incoming?.name);
        const exactNames = [existing?.name, ...(existing?.aliases || [])].map(normalized).filter(Boolean);
        if (!incomingName || !exactNames.includes(incomingName)) return false;
        return entityTypesAreCompatible(incoming?.type, existing?.type);
    }
    if (category === 'facts') {
        if (isAddressFact(incoming) || isAddressFact(existing)) {
            const incomingIdentity = addressFactIdentity(incoming, world);
            return Boolean(incomingIdentity && incomingIdentity === addressFactIdentity(existing, world));
        }
        return sameSubject(incoming?.subject, existing?.subject)
            && same(incoming?.predicate, existing?.predicate)
            && same(incoming?.category, existing?.category);
    }
    if (category === 'states') {
        const incomingIdentity = stateIdentity(world, incoming);
        return Boolean(normalized(incoming?.subject) && normalized(incoming?.attribute)
            && incomingIdentity === stateIdentity(world, existing));
    }
    if (category === 'relationships') {
        const incomingPair = result
            ? resolvedRelationshipPairIdentity(result, incoming, world)
            : relationshipPairIdentity(incoming, world);
        const existingPair = result
            ? resolvedRelationshipPairIdentity(result, existing, world)
            : relationshipPairIdentity(existing, world);
        return Boolean(incomingPair && incomingPair === existingPair);
    }
    if (category === 'threads') return same(incoming?.title, existing?.title);
    if (category === 'backgrounds') return same(incoming?.topic, existing?.topic);
    return false;
}

export function relationshipPairIdentity(item, world = null) {
    const endpoints = [item?.from, item?.to]
        .map(value => normalized(canonicalMemorySubject(world, value)))
        .filter(Boolean)
        .sort();
    return endpoints.length === 2 ? endpoints.join('|') : '';
}

const ENTITY_TYPE_FAMILIES = new Map([
    ['person', 'person'], ['character', 'person'], ['individual', 'person'], ['npc', 'person'], ['human', 'person'],
    ['object', 'object'], ['item', 'object'], ['artifact', 'object'], ['weapon', 'object'], ['tool', 'object'], ['vehicle', 'object'],
    ['place', 'place'], ['location', 'place'], ['site', 'place'], ['region', 'place'], ['world', 'place'],
    ['group', 'group'], ['organization', 'group'], ['organisation', 'group'], ['faction', 'group'], ['institution', 'group'], ['team', 'group'],
]);

const PERSON_TYPE_SIGNAL = /\b(?:person|character|individual|npc|human|adult|child|man|woman|boy|girl|captain|commander|officer|soldier|guard|pilot|agent|investigator|detective|leader|ruler|king|queen|prince|princess|emperor|empress|lord|lady|master|mentor|teacher|instructor|student|pupil|apprentice|padawan|parent|mother|father|brother|sister|sibling|spouse|husband|wife|attendant|retainer|servant|handler|prisoner|captor|captive|doctor|physician|nurse|engineer|scientist|scholar|archivist|mage|wizard|witch|priest|cleric)\b/iu;
const PERSON_TYPE_TAIL_SIGNAL = /\b(?:person|character|individual|npc|human|adult|child|man|woman|boy|girl|captain|commander|officer|soldier|guard|pilot|agent|investigator|detective|leader|ruler|king|queen|prince|princess|emperor|empress|lord|lady|master|mentor|teacher|instructor|student|pupil|apprentice|padawan|parent|mother|father|brother|sister|sibling|spouse|husband|wife|attendant|retainer|servant|handler|prisoner|captor|captive|doctor|physician|nurse|engineer|scientist|scholar|archivist|mage|wizard|witch|priest|cleric)\s*$/iu;
const OBJECT_TYPE_SIGNAL = /\b(?:object|item|artifact|weapon|tool|vehicle|device|equipment|book|document|letter|key|sword|gun|ship|shuttle|car|aircraft)\b/iu;
const PLACE_TYPE_SIGNAL = /\b(?:place|location|site|region|world|planet|moon|city|town|village|district|room|building|base|station|fort|castle|house|home|road|bridge|forest|desert|island)\b/iu;
const GROUP_TYPE_SIGNAL = /\b(?:group|organization|organisation|faction|institution|team|family|clan|guild|army|fleet|council|government|company|corporation|order)\b/iu;

export function entityTypeFamily(value) {
    const type = normalized(value);
    if (!type || ['entity', 'unknown', 'other'].includes(type)) return '';
    const exact = ENTITY_TYPE_FAMILIES.get(type);
    if (exact) return exact;
    if (PERSON_TYPE_TAIL_SIGNAL.test(type) || /\b(?:dead|deceased|living)\b/iu.test(type) && PERSON_TYPE_SIGNAL.test(type)) return 'person';
    if (OBJECT_TYPE_SIGNAL.test(type)) return 'object';
    if (PLACE_TYPE_SIGNAL.test(type)) return 'place';
    if (GROUP_TYPE_SIGNAL.test(type)) return 'group';
    if (PERSON_TYPE_SIGNAL.test(type) || /\b(?:young|elderly)\b/iu.test(type)) return 'person';
    return '';
}

export function entityIsPersonLike(value) {
    return entityTypeFamily(value) === 'person';
}

export function entityTypesAreCompatible(left, right) {
    const leftFamily = entityTypeFamily(left);
    const rightFamily = entityTypeFamily(right);
    return !leftFamily || !rightFamily || leftFamily === rightFamily;
}

export function reconciliationMergeIsCompatible(category, canonical, duplicate, world = null) {
    return reconciliationTargetIsCompatible(category, duplicate, canonical, world);
}

const REJECTED_TARGET_RECORDS = new WeakSet();

export function reconciliationTargetWasRejected(item) {
    return Boolean(item && typeof item === 'object' && REJECTED_TARGET_RECORDS.has(item));
}

export function sanitizeReconciliationMetadata(result, world, messages = null) {
    const missingIdentityResolutions = !Array.isArray(result.identityResolutions);
    if (missingIdentityResolutions) result.identityResolutions = [];
    const normalizedIdentityReferences = normalizeIdentityResolutionReferences(result);
    const discardedIdentityResolutions = discardUnsupportedIdentityResolutions(result, world, messages);
    const normalizedEpistemicFacts = normalizeEpistemicFactShapes(result, world);
    const normalizedAddresses = normalizeDirectionalAddressFacts(result, world);
    const repairedAddresses = repairReversedAddressFacts(result, world, messages);
    const recovered = recoverExplicitAddressFacts(result, world, messages);
    const discardedAddressValues = removeCrossDirectionAddressContamination(result, world, messages);
    const recoveredAliases = recoverExplicitEntityAliases(result, messages);
    const recoveredBoundaries = recoverExplicitConcealmentBoundaries(result, world);
    const recoveredKnowledge = recoverExplicitPriorKnowledge(result, world, messages);
    const recoveredIdentities = recoverExplicitNamedIdentityResolutions(result, world, messages);
    const canonicalizedIdentityReferences = canonicalizeResolvedIdentityReferences(result, world);
    const recoveredOocIdentityBoundaries = recoverExplicitOocIdentityBoundaries(result, world, messages);
    const normalizedIdentityEpistemicRiders = normalizeObjectiveIdentityEpistemicRiders(result, world);
    const discardedContradictedObjectFacts = discardContradictedObjectStateFacts(result, world, messages);
    const repairedRelationshipDescriptions = repairRelationshipPairDescriptionContamination(result, world);
    const recoveredFactRelationships = recoverExplicitFactRelationships(result, world, messages);
    const reconciledHistoricalRelationships = reconcileHistoricalRelationshipLifecycles(result, world);
    const recoveredSceneCoverage = recoverSourceGroundedCoverageRecords(result, world, messages);
    const recoveredCommitments = recoverExplicitFutureCommitments(result, world, messages);
    const recoveredIdentityThreads = recoverExplicitIdentityBoundaryThreads(result, world);
    const recoveredCoverage = recoveredFactRelationships + recoveredSceneCoverage + recoveredCommitments
        + recoveredIdentityThreads + recoveredOocIdentityBoundaries;
    const preservedResolvedThreads = preserveResolvedThreadHistory(result, world);
    const modelResolvedThreads = new Set((result?.threads || []).filter(thread => normalized(thread?.status) === 'resolved'));
    const resolvedCompletedThreads = resolveCompletedIncomingThreads(result);
    const reopenedUnsupportedThreads = reopenUnsupportedResolvedThreads(result, world, messages, modelResolvedThreads);
    const reconciledIdentityThreads = reconcileResolvedIdentityThreads(result, world);
    const reconciledThreads = reconcileExplicitlyResolvedThreads(result, world, messages);
    const normalizedRelationshipDescriptions = normalizeRelationshipDescriptions(result);
    const repairedStateOwners = repairStableStateOwners(result, world);
    const reconciledStateTransitions = reconcileStatePreviousValues(result, world);
    const reconciledSceneParticipants = reconcileSceneParticipants(result, world, messages);
    const reconciledAddresses = reconcileGenericAddressDuplicates(result, world);
    const discardedUnsupportedAddresses = removeUnsupportedAddressValues(result, messages, world);
    const discardedPronounAddresses = removeUnsupportedPronounAddressValues(result, messages, world);
    let ignored = discardedAddressValues + discardedUnsupportedAddresses + discardedPronounAddresses
        + discardedIdentityResolutions
        + discardedContradictedObjectFacts
        + removeInvalidAddressFacts(result) + Number(missingIdentityResolutions);
    ignored += removeUnsupportedSelfAddressFacts(result, messages, world);
    if (!Array.isArray(result.recordMerges)) {
        result.recordMerges = [];
        ignored++;
    }
    const relationshipEndpointConflicts = findRelationshipEndpointConflicts(result, world);

    for (const category of TARGET_RECORD_CATEGORIES) {
        const recordsById = new Map((world?.[category] || [])
            .map(item => [String(item.id || ''), item])
            .filter(([itemId]) => itemId));
        for (const item of result[category] || []) {
            if (!item || typeof item !== 'object') continue;
            const targetId = String(item.targetId || '').trim();
            const target = targetId ? recordsById.get(targetId) : null;
            const compatible = targetId && reconciliationTargetIsCompatible(category, item, target, world, result);
            if (targetId && target && !compatible) {
                REJECTED_TARGET_RECORDS.add(item);
                if (category === 'relationships') {
                    const incomingLabel = `${cleanText(item?.from)} ↔ ${cleanText(item?.to)}`;
                    const storedLabel = `${cleanText(target?.from)} ↔ ${cleanText(target?.to)}`;
                    relationshipEndpointConflicts.push({
                        category, index: (result[category] || []).indexOf(item), label: incomingLabel,
                        warning: `Relationship target conflict: “${incomingLabel}” attempted to reuse the stable ID belonging to “${storedLabel}”; relationship IDs cannot change their participant pair.`,
                    });
                }
                ignored++;
            } else if (targetId && !compatible) ignored++;
            item.targetId = compatible ? targetId : '';
        }
    }

    result.recordMerges = result.recordMerges.filter(merge => {
        const category = String(merge?.category || '');
        const allowedCategory = ['facts', 'states', 'relationships', 'threads', 'backgrounds'].includes(category);
        const records = allowedCategory && Array.isArray(world?.[category]) ? world[category] : [];
        const recordsById = new Map(records.map(item => [String(item.id || ''), item]).filter(([itemId]) => itemId));
        const validIds = new Set(records.map(item => String(item.id || '')).filter(Boolean));
        const canonicalId = String(merge?.canonicalId || '').trim();
        const duplicateIds = [...new Set((merge?.duplicateIds || []).map(value => String(value || '').trim()).filter(Boolean))];
        const valid = allowedCategory
            && Boolean(String(merge?.evidence || '').trim())
            && validIds.has(canonicalId)
            && duplicateIds.length > 0
            && !duplicateIds.includes(canonicalId)
            && duplicateIds.every(itemId => validIds.has(itemId))
            && duplicateIds.every(itemId => reconciliationMergeIsCompatible(
                category,
                recordsById.get(canonicalId),
                recordsById.get(itemId),
                world,
            ));
        if (!valid) ignored++;
        else merge.duplicateIds = duplicateIds;
        return valid;
    });
    const sourceAttributionConflicts = findSourceAttributionConflicts(result, world, messages);
    const localWarnings = [...new Set([
        ...relationshipEndpointConflicts.map(item => item.warning),
        ...sourceAttributionConflicts.map(item => item.warning),
    ])];
    const diagnosticWarnings = [...new Set([
        ...findCoverageWarnings(result, messages),
        ...findTypedContinuityWarnings(result, world),
        ...reconciledThreads.warnings,
    ])].slice(0, 8);
    const warnings = [...new Set([
        ...diagnosticWarnings,
        ...localWarnings,
    ])].slice(0, 8);
    if (result?.sceneCapsule && typeof result.sceneCapsule === 'object') result.sceneCapsule.coverageWarnings = warnings;
    return { ignored, recovered, recoveredAliases, recoveredBoundaries, recoveredKnowledge, recoveredIdentities, recoveredOocIdentityBoundaries, normalizedIdentityEpistemicRiders, normalizedIdentityReferences, discardedIdentityResolutions, canonicalizedIdentityReferences, discardedContradictedObjectFacts, repairedRelationshipDescriptions, recoveredFactRelationships, reconciledHistoricalRelationships, recoveredCommitments, recoveredIdentityThreads, recoveredCoverage, preservedResolvedThreads, reopenedUnsupportedThreads, reconciledThreads: Math.max(0, resolvedCompletedThreads - reopenedUnsupportedThreads) + reconciledIdentityThreads + reconciledThreads.resolved, normalizedEpistemicFacts, normalizedRelationshipDescriptions, repairedStateOwners, reconciledStateTransitions, reconciledSceneParticipants, repairedAddresses, normalizedAddresses, discardedAddressValues, discardedUnsupportedAddresses, discardedPronounAddresses, reconciledAddresses, sourceAttributionConflicts, relationshipEndpointConflicts, localWarnings, diagnosticWarnings, warnings };
}
