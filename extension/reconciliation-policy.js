import { canonicalMemorySubject, canonicalStateAttribute, isActiveState, stateIdentity } from './state-lifecycle.js';
import { canonicalCharacterProfileField, characterProfileDetailIsAdmissible, durableCharacterProfileDetail, entityProfile as storedEntityProfile, formatEntityProfile, normalizeEntityProfile } from './entity-profile.js';
import { canonicalProseIsThirdPerson, thirdPersonOnlyProse } from './canonical-prose.js';
import { EXTRACTION_VERSION } from './coverage.js';
import { randomUuid } from './uuid.js';

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
    const cue = /\b(?:calls?|called|nicknames?|nicknamed|dubs?|dubbed|addresses?|addressed|dismisses?|dismissed)\b/iu;
    const mentionPatterns = new Map();
    const evidence = new Map();
    const mentionedVariants = (entity, text) => entity.variants.filter(variant => {
        let pattern = mentionPatterns.get(variant);
        if (!pattern) {
            pattern = new RegExp(`\\b${escaped(variant)}\\b`, 'iu');
            mentionPatterns.set(variant, pattern);
        }
        return pattern.test(text);
    });
    const evidenceFor = form => {
        const key = normalized(form);
        if (evidence.has(key)) return evidence.get(key);
        let occurrences = 0;
        for (const value of strings) {
            if (containsAddressForm(value, form) && ++occurrences >= 2) break;
        }
        const value = occurrences >= 2
            && messages.some(message => containsAddressForm(message?.text ?? message?.mes, form));
        evidence.set(key, value);
        return value;
    };
    let recovered = 0;
    for (const text of strings) {
        if (!cue.test(text)) continue;
        const mentioned = entities
            .map(entity => ({ entity, variants: mentionedVariants(entity, text) }))
            .filter(item => item.variants.length);
        for (const { entity: speaker, variants: speakerNames } of mentioned) {
            for (const { entity: addressee, variants: addresseeNames } of mentioned) {
                if (normalized(speaker.name) === normalized(addressee.name)) continue;
                for (const speakerName of speakerNames) {
                    for (const addresseeName of addresseeNames) {
                        const pattern = new RegExp(`\\b${escaped(speakerName)}\\b[^\\n\\r]{0,80}\\b(?:calls?|called|nicknames?|nicknamed|dubs?|dubbed|addresses?|addressed|dismisses?|dismissed)\\s+\\b${escaped(addresseeName)}\\b\\s+(?:as\\s+)?[“\"']([^”\"'\\n\\r]{1,80})[”\"']`, 'iu');
                        const form = String(text.match(pattern)?.[1] || '').replace(/\s+/g, ' ').trim();
                        if (!form || !ADDRESS_MEANINGFUL.test(form) || ADDRESS_BRACKET.test(form) || !evidenceFor(form)) continue;
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
    const requested = cleanText(value);
    let subject = canonicalMemorySubject(world, value);
    const possessiveOwner = cleanText(subject).match(/^(.+?)[’']s\s+/u)?.[1] || '';
    // Fuzzy subject lookup must never turn the owner into the separate person
    // described by that owner's possessive role (for example, “Toska” into
    // “Toska's former master”). This also keeps reconciliation idempotent.
    if (possessiveOwner && normalized(requested) === normalized(possessiveOwner)) subject = requested;
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

// When a descriptive identity is explicitly resolved and the same holder has
// a positive knowledge record for the canonical person, update an older
// “identity unknown” boundary instead of leaving mutually stale facts.
export function supersedeResolvedDescriptiveIdentityBoundaries(result, world) {
    if (!Array.isArray(result?.facts) || !Array.isArray(world?.facts)) return 0;
    let superseded = 0;
    for (const resolution of result?.identityResolutions || []) {
        const descriptor = descriptivePersonIdentityContext(resolution?.reference, world);
        const canonical = cleanText(resolution?.canonical);
        if (!descriptor || !canonical) continue;
        const holder = cleanText(descriptor.owner);
        const roleWords = identityReferenceTokens(descriptor.role).filter(token => IDENTITY_ROLE_TOKENS.has(token));
        const positive = result.facts.find(fact => normalized(fact?.subject) === normalized(holder)
            && !/^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category))
            && !EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(fact?.value))
            && textMentionsIdentityVariant(`${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`, [canonical]));
        if (!positive) continue;
        for (const boundary of world.facts.filter(fact => normalized(fact?.subject) === normalized(holder)
            && (/^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category))
                || EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(fact?.value)))
            && /\bidentity\b/iu.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`)
            && (!roleWords.length || roleWords.some(role => new RegExp(`\\b${escaped(role)}\\b`, 'iu').test(`${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`))))) {
            if (result.facts.some(fact => cleanText(fact?.targetId) === cleanText(boundary?.id))) continue;
            result.facts.push({
                targetId: cleanText(boundary?.id), subject: holder, predicate: cleanText(boundary?.predicate),
                value: `${holder} knows that ${cleanText(resolution.reference)} is ${canonical}.`,
                category: 'knowledge', importance: Math.max(4, Number(boundary?.importance || positive?.importance || 4)),
                persistence: 'persistent', _knowledgeTransition: true,
            });
            superseded++;
        }
    }
    return superseded;
}

export function supersedeResolvedSubjectIdentityUnknowns(result, world) {
    if (!Array.isArray(result?.facts) || !Array.isArray(world?.facts)) return 0;
    let superseded = 0;
    for (const resolution of result?.identityResolutions || []) {
        const reference = cleanText(resolution?.reference);
        const canonical = cleanText(resolution?.canonical);
        if (!reference || !canonical) continue;
        for (const fact of world.facts.filter(item =>
            normalized(item?.subject) === normalized(reference)
            && /\b(?:identity|name|who)\b/iu.test(`${cleanText(item?.predicate)} ${cleanText(item?.category)} ${cleanText(item?.value)}`)
            && /\b(?:unknown|unidentified|unnamed|no answer|not (?:yet )?(?:known|identified|established|revealed|given)|has not (?:yet )?been (?:known|identified|established|revealed|given))\b/iu.test(cleanText(item?.value)))) {
            if (result.facts.some(item => cleanText(item?.targetId) === cleanText(fact?.id))) continue;
            result.facts.push({
                targetId: cleanText(fact?.id), subject: cleanText(fact?.subject),
                predicate: cleanText(fact?.predicate),
                value: `${canonical} is the established identity of ${reference}.`,
                category: cleanText(fact?.category) || 'identity', importance: Math.max(4, Number(fact?.importance || 4)),
                persistence: cleanText(fact?.persistence) || 'persistent',
            });
            superseded++;
        }
    }
    return superseded;
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
            if (/\b(?:believes?|believed|claims?|claimed|alleges?|alleged|reports?|reported|suspects?|suspected|speculates?|speculated|thinks?|thought|assumes?|assumed|infers?|inferred|concludes?|concluded|says?|said|states?|stated)\b/iu.test(clause.slice(0, verb.index))) continue;
            const actorWindow = clause.slice(Math.max(0, verb.index - 90), verb.index);
            const actor = nearestCanonicalMention(index, actorWindow);
            if (!actor || !/^(?:person|character|npc|human|individual)$/iu.test(actor.type || 'person')) continue;
            if (!hasNonPossessiveEntityMention(actor, actorWindow)) continue;
            const remainder = clause.slice(verb.index + verb[0].length);
            const topic = canonicalMention(index, remainder);
            if (!topic || !hasNonPossessiveEntityMention(topic, remainder)
                || normalized(topic.name) === normalized(actor.name)) continue;
            const evidence = clause
                .replace(new RegExp(`^${escaped(actor.name.split(/\s+/u).at(-1))}\\b`, 'iu'), actor.name)
                .replace(/[,:;]+$/u, '');
            if (!hasKnowledgeRecord(result, world, actor.name, topic.name)) {
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
            }

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
const EXPLICIT_KNOWLEDGE_NEGATION = /\b(?:does not|do not|did not|has not|have not|had not|cannot|can't|never)\s+(?:know|recognize|learn|identify|realize|discover)\b|\b(?:unaware|unknown to)\b/iu;
export function recoverExplicitOocIdentityBoundaries(result, world, messages) {
    if (!Array.isArray(result?.facts) || !Array.isArray(result?.threads)
        || !Array.isArray(messages) || !messages.length) return 0;
    const index = continuityEntityIndex(result, world);
    let recovered = 0;
    for (const message of messages) {
        if (message?.isUser !== true && message?.is_user !== true) continue;
        const source = cleanText(message?.text ?? message?.mes);
        const ooc = source.match(/(?:^|[\s[(])(?:OOC|out[- ]of[- ]character|meta|canon(?:ical)?\s+note|author(?:'s)?\s+note|GM\s+note|narrator\s+note)\s*(?:[:—–-]|\)|\])\s*([\s\S]+)$/iu)?.[1] || '';
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
            const sameKnowledgeTopic = fact => normalized(fact?.subject) === normalized(holder)
                && normalized(fact?.predicate) === normalized(predicate);
            // An explicit OOC concealment constraint is authoritative. A
            // model may mistake naming a historical person for the current
            // figure revealing that identity; discard that positive inference
            // and persist the holder-specific boundary instead.
            result.facts = result.facts.filter(fact => !sameKnowledgeTopic(fact)
                || /^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category))
                || (EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(fact?.value))
                    && /\b(?:current figure|true identity|real identity|recogniz(?:e|es|ed|ing))\b/iu.test(cleanText(fact?.value))));
            const stored = (world?.facts || []).find(sameKnowledgeTopic);
            const already = [...(world?.facts || []), ...result.facts].some(fact =>
                normalized(fact?.subject) === normalized(holder)
                && normalized(fact?.predicate) === normalized(predicate)
                && (/^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category))
                    || EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(fact?.value))));
            if (!already) {
                result.facts.push({
                    targetId: cleanText(stored?.id), subject: holder, predicate,
                    value: `${holder} does not know that the current figure’s true identity is ${canonical.name}; the canonical memory label does not grant that knowledge.`,
                    category: 'knowledge boundary', importance: 5, persistence: 'persistent', _knowledgeTransition: true,
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

const EXPLICIT_IDENTITY_LEARNING = /\b(?:learns?|learned|discovers?|discovered|recognizes?|recognized|identifies?|identified|realizes?|realized|is told|was told|now knows?|confirms?|confirmed|reveals?|revealed|discloses?|disclosed|introduces?|introduced)\b/iu;

function sourceExplicitlyGrantsIdentityKnowledge(messages, holder, identity) {
    const holderName = cleanText(holder);
    const identityName = cleanText(identity);
    if (!holderName || !identityName || !Array.isArray(messages)) return false;
    for (const message of messages) {
        const source = cleanText(message?.text ?? message?.mes);
        if (!source) continue;
        const speaker = cleanText(message?.name ?? message?.speaker);
        if (normalized(speaker) === normalized(holderName)
            && textMentionsIdentityVariant(source, [identityName])
            && /\b(?:my\s+[^.!?]{1,100}\s+(?:is|was)|I\s+(?:know|recognize|identify|remember)|my\s+name\s+is)\b/iu.test(source)) return true;
        const clauses = source.split(/\n+|(?<=[.!?;])\s+/u).map(cleanText).filter(Boolean);
        for (let index = 0; index < clauses.length; index++) {
            const window = clauses.slice(Math.max(0, index - 1), index + 2).join(' ');
            if (!textMentionsIdentityVariant(window, [holderName])
                || !textMentionsIdentityVariant(window, [identityName])
                || !EXPLICIT_IDENTITY_LEARNING.test(window)) continue;
            if (/\b(?:asks?|asked|wonders?|wondered|suspects?|suspected|guesses?|guessed|might|may|perhaps|possibly|not sure)\b/iu.test(window)
                && !/\b(?:confirms?|confirmed|recognizes?|recognized|learns?|learned|discovers?|discovered|now knows?)\b/iu.test(window)) continue;
            return true;
        }
        const ooc = (message?.isUser === true || message?.is_user === true)
            ? source.match(/(?:^|[\s[(])(?:OOC|out[- ]of[- ]character|meta|canon(?:ical)?\s+note|author(?:'s)?\s+note|GM\s+note|narrator\s+note)\s*(?:[:—–-]|\)|\])\s*([\s\S]+)$/iu)?.[1] || ''
            : '';
        if (ooc && textMentionsIdentityVariant(ooc, [holderName])
            && textMentionsIdentityVariant(ooc, [identityName])
            && /\b(?:knows?|recognizes?|is aware|learned|was told)\b/iu.test(ooc)
            && !EXPLICIT_KNOWLEDGE_NEGATION.test(ooc)) return true;
    }
    return false;
}

// Canonical entity labels are backend identifiers, not character knowledge.
// When an active boundary protects a true identity, a model-written positive
// fact may cross that boundary only with explicit raw-chat evidence that the
// named holder learned or recognized the protected identity.
export function discardKnowledgeBlockedIdentityLeaks(result, world, messages) {
    if (!Array.isArray(result?.facts)) return { discarded: 0, warnings: [] };
    const entities = [...(world?.entities || []), ...(result?.entities || [])]
        .filter(personEntity);
    const boundaries = [...(world?.facts || []), ...result.facts]
        .filter(fact => /^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category))
            || (normalized(fact?.category) === 'knowledge' && EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(fact?.value))))
        .filter(fact => /\b(?:identity|true name|real name|recogniz)\b/iu.test(`${fact?.predicate || ''} ${fact?.value || ''}`));
    let discarded = 0;
    const warnings = [];
    result.facts = result.facts.filter(fact => {
        if (normalized(fact?.category) !== 'knowledge'
            || EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(fact?.value))) return true;
        const holder = cleanText(canonicalMemorySubject(world, fact?.subject));
        if (!holder) return true;
        const protectedIdentities = entities.filter(entity => normalized(entity?.name) !== normalized(holder)
            && boundaries.some(boundary =>
                normalized(canonicalMemorySubject(world, boundary?.subject)) === normalized(holder)
                && textMentionsIdentityVariant(`${boundary?.predicate || ''} ${boundary?.value || ''}`, [entity.name, ...(entity.aliases || [])])));
        if (!protectedIdentities.length) return true;
        const leaked = protectedIdentities.find(entity =>
            textMentionsIdentityVariant(`${fact?.predicate || ''} ${fact?.value || ''}`, [entity.name])
            && !sourceExplicitlyGrantsIdentityKnowledge(messages, holder, entity.name));
        if (!leaked) return true;
        discarded++;
        warnings.push(`Knowledge boundary: withheld an unsupported claim that “${holder}” knows “${leaked.name}” as the protected identity.`);
        return false;
    });
    return { discarded, warnings };
}

const PERSON_IDENTITY_ROLE = '(?:master|mentor|teacher|captain|commander|leader|handler|apprentice|student|padawan|pupil|parent|mother|father|brother|sister)';
const PERSON_IDENTITY_SPECIALIZATION = '(?:[\\p{L}\\p{N}-]+\\s+){0,3}';
const DESCRIPTIVE_PERSON_IDENTITY = new RegExp(`^(.+?)[’']s\\s+((?:(?:former|dead|deceased|missing|unknown)\\s+)?${PERSON_IDENTITY_SPECIALIZATION}${PERSON_IDENTITY_ROLE})$`, 'iu');
const GENERIC_PERSON_IDENTITY = new RegExp(`^(?:(?:the|an?)\\s+)?((?:(?:unknown|unnamed|unidentified|mysterious|missing)\\s+)?(?:(?:former|previous|prior|lost|missing|dead|deceased)\\s+)?${PERSON_IDENTITY_SPECIALIZATION}(${PERSON_IDENTITY_ROLE}))(?:\\s+of\\s+(.+))?$`, 'iu');
const MIXED_OWNER_PERSON_IDENTITY = new RegExp(`^(.+?)[’']s\\s+((?:(?:former|previous|prior|lost|missing|dead|deceased|unknown|unnamed|unidentified)\\s+)?${PERSON_IDENTITY_SPECIALIZATION}${PERSON_IDENTITY_ROLE})\\s+of\\s+(.+)$`, 'iu');

// A person-role placeholder must have one owner. Repair malformed extractor
// output such as “A's former apprentice of B” to the grammatical “B's former
// apprentice” before it can become a second, falsely owned entity.
export function normalizeMixedOwnerPersonIdentities(result, world) {
    if (!Array.isArray(result?.entities)) return 0;
    const replacements = new Map();
    for (const entity of result.entities) {
        const previous = cleanText(entity?.name);
        const match = previous.match(MIXED_OWNER_PERSON_IDENTITY);
        if (!match) continue;
        const role = cleanText(match[2]);
        const owner = cleanText(canonicalMemorySubject(world, match[3]));
        if (!role || !owner) continue;
        const canonical = `${owner}’s ${role}`;
        replacements.set(normalized(previous), canonical);
        entity.name = canonical;
        entity.aliases = (entity.aliases || []).filter(alias => normalized(alias) !== normalized(previous));
    }
    if (!replacements.size) return 0;
    const replace = value => replacements.get(normalized(value)) || value;
    for (const item of result.facts || []) item.subject = replace(item.subject);
    for (const item of result.states || []) item.subject = replace(item.subject);
    for (const item of result.relationships || []) {
        item.from = replace(item.from);
        item.to = replace(item.to);
    }
    for (const category of ['events', 'threads', 'backgrounds']) {
        for (const item of result[category] || []) item.participants = (item.participants || []).map(replace);
    }
    for (const item of result.identityResolutions || []) {
        item.reference = replace(item.reference);
        item.canonical = replace(item.canonical);
    }
    return replacements.size;
}

function conservativeEntitySurfaceKey(value) {
    return normalized(value)
        .replace(/[’‘]/gu, "'")
        .replace(/\b([\p{L}\p{N}]+)'s\b/gu, '$1')
        .replace(/\bmoonbase\b/gu, 'moon base')
        .replace(/\bstarship\b/gu, 'star ship')
        .replace(/\b(?:the)\b/gu, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

// Normalize only punctuation, possessive, determiner, and closed-compound
// variants. No semantic similarity is used here, so two genuinely distinct
// people, places, or objects cannot be fused because a model found them alike.
export function canonicalizeConservativeEntityVariants(result, world) {
    if (!Array.isArray(result?.entities)) return 0;
    const establishedBySurface = new Map();
    for (const entity of world?.entities || []) {
        const surface = conservativeEntitySurfaceKey(entity?.name);
        if (!surface) continue;
        const items = establishedBySurface.get(surface) || [];
        items.push(entity);
        establishedBySurface.set(surface, items);
    }
    const canonicalBySurface = new Map();
    const replacements = new Map();
    let normalizedCount = 0;
    for (const entity of result.entities) {
        const supplied = cleanText(entity?.name);
        const surface = conservativeEntitySurfaceKey(supplied);
        if (!surface) continue;
        const established = (establishedBySurface.get(surface) || [])
            .filter(candidate => entityTypesAreCompatible(candidate?.type, entity?.type));
        const prior = canonicalBySurface.get(surface);
        const canonical = established.length === 1 ? established[0]
            : established.length === 0 && prior && entityTypesAreCompatible(prior?.type, entity?.type) ? prior
            : null;
        if (!canonical) {
            if (!prior && established.length === 0) canonicalBySurface.set(surface, entity);
            continue;
        }
        if (normalized(supplied) === normalized(canonical.name)) continue;
        replacements.set(normalized(supplied), canonical.name);
        entity.name = canonical.name;
        entity.targetId ||= cleanText(canonical.id);
        entity.aliases = [...new Set([...(entity.aliases || []), supplied].map(cleanText).filter(Boolean))];
        normalizedCount++;
    }
    if (!replacements.size) return normalizedCount;
    const replace = value => replacements.get(normalized(value)) || value;
    for (const item of result.facts || []) item.subject = replace(item.subject);
    for (const item of result.states || []) item.subject = replace(item.subject);
    for (const item of result.relationships || []) {
        item.from = replace(item.from);
        item.to = replace(item.to);
    }
    for (const item of [...(result.events || []), ...(result.threads || []), ...(result.backgrounds || [])]) {
        if (Array.isArray(item?.participants)) item.participants = item.participants.map(replace);
    }
    if (Array.isArray(result?.scene?.participants)) result.scene.participants = result.scene.participants.map(replace);
    if (Array.isArray(result?.sceneCapsule?.participants)) result.sceneCapsule.participants = result.sceneCapsule.participants.map(replace);
    for (const resolution of result.identityResolutions || []) {
        resolution.reference = replace(resolution.reference);
        resolution.canonical = replace(resolution.canonical);
    }
    return normalizedCount;
}

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

function descriptiveRoleEvidencePattern(role) {
    const value = cleanText(role);
    const qualified = value.match(/\b((?:Jedi|Sith)\s+(?:master|apprentice|padawan))\b/iu)?.[1];
    if (qualified) return new RegExp(`\\b${escaped(qualified)}\\b`, 'iu');
    const tail = value.split(/\s+/u).at(-1);
    return tail ? new RegExp(`\\b${escaped(tail)}\\b`, 'iu') : null;
}

function canonicalNameFromDescriptiveAlias(value) {
    const original = cleanText(value);
    if (!original) return '';
    const withoutTitle = original.replace(/^(?:(?:Jedi|Sith)\s+)?(?:master|mentor|teacher|captain|commander|leader|handler|apprentice|student|padawan|pupil)\s+/iu, '');
    const candidate = cleanText(withoutTitle || original);
    if (!candidate || /^(?:the|an?|unknown|unnamed|unidentified|mysterious|missing|former|previous|prior|dead|deceased)$/iu.test(candidate)) return '';
    if (/^(?:(?:Jedi|Sith)\s+)?(?:master|mentor|teacher|captain|commander|leader|handler|apprentice|student|padawan|pupil)$/iu.test(candidate)) return '';
    return candidate;
}

// Some extractors correctly attach the revealed name as an alias but keep the
// descriptive placeholder as the entity's primary name. Promote the unique,
// source-established alias so all later records use the revealed identity.
export function promoteExplicitDescriptiveEntityAliases(result, world, messages) {
    if (!Array.isArray(result?.entities) || !Array.isArray(result?.identityResolutions)
        || !Array.isArray(messages) || !messages.length) return 0;
    let promoted = 0;
    for (const entity of result.entities) {
        const reference = cleanText(entity?.name);
        const descriptor = descriptivePersonIdentityContext(reference, world);
        if (!descriptor || !entityIsPersonLike(entity?.type)) continue;
        const candidates = [...new Set((entity?.aliases || [])
            .map(canonicalNameFromDescriptiveAlias)
            .filter(name => name && normalized(name) !== normalized(reference)
                && normalized(name) !== normalized(descriptor.owner)))];
        const supported = candidates.filter(name => sourceSupportsNamedIdentity(
            messages, descriptor.owner, descriptor.role, name,
            (entity?.aliases || []).filter(alias => normalized(canonicalNameFromDescriptiveAlias(alias)) === normalized(name)),
        ));
        if (supported.length !== 1) continue;
        const canonical = supported[0];
        entity.name = canonical;
        entity.aliases = [...new Set([reference, ...(entity.aliases || [])]
            .map(cleanText).filter(alias => alias && normalized(alias) !== normalized(canonical)))];
        if (!result.identityResolutions.some(item => normalized(item?.reference) === normalized(reference))) {
            result.identityResolutions.push({
                reference, canonical,
                evidence: `${descriptor.owner} explicitly identifies ${reference} as ${canonical}.`,
            });
        }
        promoted++;
    }
    return promoted;
}

// Resolve a descriptive relationship endpoint from already-established
// canonical biography. This covers later model variants such as “A's former
// Jedi Master” after the memory has already established one unique named Jedi
// Master who trained A, without requiring the later excerpt to repeat the name.
export function recoverEstablishedDescriptiveIdentityResolutions(result, world) {
    if (!Array.isArray(result?.relationships) || !Array.isArray(result?.identityResolutions)) return 0;
    const index = continuityEntityIndex(result, world);
    const sourceEntities = [...(world?.entities || []), ...(result?.entities || [])];
    const facts = [...(world?.facts || []), ...(result?.facts || [])];
    const references = [...new Set(result.relationships.flatMap(item => [item?.from, item?.to]).map(cleanText).filter(Boolean))];
    let recovered = 0;
    for (const reference of references) {
        if (result.identityResolutions.some(item => normalized(item?.reference) === normalized(reference))) continue;
        const descriptor = descriptivePersonIdentityContext(reference, world);
        if (!descriptor) continue;
        const owner = canonicalMention(index, descriptor.owner);
        const rolePattern = descriptiveRoleEvidencePattern(descriptor.role);
        if (!personEntity(owner) || !rolePattern) continue;
        const ownerPattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(owner.name)}(?:$|[^\\p{L}\\p{N}])`, 'iu');
        const candidates = index.entities.filter(candidate => personEntity(candidate)
            && normalized(candidate.name) !== normalized(owner.name)
            && normalized(candidate.name) !== normalized(reference)
            && (() => {
                const subjectFacts = facts.filter(fact => normalized(canonicalMemorySubject({ ...(world || {}), entities: index.entities }, fact?.subject)) === normalized(candidate.name));
                const candidateEntities = sourceEntities.filter(entity => normalized(entity?.name) === normalized(candidate.name));
                const descriptions = candidateEntities.map(entity => entity?.description);
                const evidenceItems = [...descriptions, ...subjectFacts.map(fact => `${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`)].map(cleanText).filter(Boolean);
                // The candidate itself must be established in the requested
                // role. An incidental role mention is not identity evidence
                // (for example, “a Sith who killed Toska's Jedi Master”).
                const candidateHasRole = candidateEntities.some(entity => rolePattern.test(cleanText(entity?.type))
                    || new RegExp(`^(?:deceased|late|former|previous|renowned|retired|missing|unknown|an?|the)?\\s*${rolePattern.source}`, 'iu').test(cleanText(entity?.description)))
                    || subjectFacts.some(fact => rolePattern.test(cleanText(fact?.predicate))
                        && /\b(?:is|was|served|role|designation|identity|occupation|rank)\b/iu.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`));
                if (!candidateHasRole) return false;
                return evidenceItems.some(evidence => {
                    if (!ownerPattern.test(evidence) || !rolePattern.test(evidence)) return false;
                    const possessiveRole = new RegExp(`${escaped(owner.name)}[’']s[^.!?;]{0,80}${rolePattern.source}`, 'iu').exec(evidence);
                    // “A Sith who killed Toska's former Jedi master” mentions
                    // the role but does not make the Sith that master. A
                    // possessive role is identity evidence only when it leads
                    // the canonical description or is explicitly predicated
                    // of the candidate.
                    if (!possessiveRole) return /\b(?:train(?:ed|s|ing)?|teach(?:es|ing)?|taught|mentor(?:ed|s|ing)?|raise(?:d|s|ing)?|apprentice(?:d|s|ing)?)\b/iu.test(evidence);
                    if (possessiveRole.index <= 5) return true;
                    return new RegExp(`${escaped(candidate.name)}[^.!?;]{0,80}\\b(?:is|was|served as|became)\\b[^.!?;]{0,80}${escaped(possessiveRole[0])}`, 'iu').test(evidence);
                });
            })());
        if (candidates.length !== 1) continue;
        result.identityResolutions.push({
            reference,
            canonical: candidates[0].name,
            evidence: `Established canonical biography uniquely identifies ${reference} as ${candidates[0].name}.`,
        });
        recovered++;
    }
    return recovered;
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
            // A direct “Name the apprentice.” → “Lucas Alcazar.” exchange
            // identifies the already-anchored descriptive person even when
            // the question uses only the role and omits the owner's full name.
            return answered || (ownerPresent && (explicit.test(text) || roleApposition.test(text)));
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
        const ownerTokens = cleanText(owner).split(/\s+/u).filter(token => token.length >= 3);
        const uniqueOwnerTokens = ownerTokens.filter(token => {
            const matches = new Set([...existing, ...incoming].filter(entity => entityIsPersonLike(entity?.type)
                && cleanText(entity?.name).split(/\s+/u).some(part => normalized(part) === normalized(token)))
                .map(entity => normalized(entity?.name)).filter(Boolean));
            return matches.size === 1 && matches.has(normalized(ownerEntity?.name));
        });
        const ownerNames = [...new Set([owner, ...(ownerEntity?.aliases || []), ...uniqueOwnerTokens]
            .map(cleanText).filter(Boolean))];
        const directlyAnsweredNames = incoming.filter(entity => entityIsPersonLike(entity?.type)
            && normalized(entity?.name) !== normalized(owner)
            && normalized(entity?.name) !== normalized(reference)
            && (messages || []).some((message, index, all) => {
                const current = cleanText(message?.text ?? message?.mes);
                const previous = cleanText(all[index - 1]?.text ?? all[index - 1]?.mes);
                return new RegExp(`\\b(?:name|identify|identity|who)\\b[^.!?]{0,100}\\b${escaped(roleWord)}\\b|\\b${escaped(roleWord)}\\b[^.!?]{0,100}\\b(?:name|identify|identity|who)\\b`, 'iu').test(previous)
                    && [entity.name, ...(entity.aliases || [])].some(name => new RegExp(
                        `^[“\"']?${escaped(cleanText(name))}(?:[.!?,:”\"']|\\s|$)`, 'iu',
                    ).test(current));
            }));
        const directAnswerBeat = directlyAnsweredNames.length === 1 && result.sceneCapsule.beats.find(rawBeat => {
            const beat = cleanText(rawBeat);
            const entity = directlyAnsweredNames[0];
            const roleMatch = new RegExp(`\\b${escaped(roleWord)}\\b`, 'iu').exec(beat);
            const namedAfterRole = roleMatch && [entity.name, ...(entity.aliases || [])].some(name => {
                const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(cleanText(name))}(?:$|[^\\p{L}\\p{N}])`, 'iu').exec(beat);
                return match && match.index > roleMatch.index;
            });
            return !COVERAGE_NON_ASSERTION.test(beat)
                && /\b(?:identifies?|identified|names?|named|reveals?|revealed)\b/iu.test(beat)
                && namedAfterRole;
        });
        if (directAnswerBeat) {
            const canonical = cleanText(directlyAnsweredNames[0].name);
            const duplicate = result.identityResolutions.some(item => normalized(item?.reference) === normalized(reference));
            if (!duplicate) {
                result.identityResolutions.push({ reference, canonical, evidence: cleanText(directAnswerBeat) });
                recovered++;
            }
            continue;
        }
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
        const resolvedThreadNames = incoming.filter(entity => entityIsPersonLike(entity?.type)
            && normalized(entity?.name) !== normalized(owner)
            && normalized(entity?.name) !== normalized(reference)
            && (result?.threads || []).some(thread => normalized(thread?.status) === 'resolved'
                && textMentionsIdentityVariant(`${thread?.title || ''} ${thread?.detail || ''}`, [entity.name, ...(entity.aliases || [])])
                && ownerNames.some(name => textMentionsIdentityVariant(`${thread?.title || ''} ${thread?.detail || ''}`, [name]))
                && new RegExp(`\\b${escaped(roleWord)}\\b`, 'iu').test(`${thread?.title || ''} ${thread?.detail || ''}`)))
            .filter(entity => (result?.facts || []).some(fact => {
                const evidence = `${cleanText(fact?.subject)} ${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`;
                return !NON_CANONICAL_RELATIONSHIP_FACT.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.category)}`)
                    && new RegExp(`\\b${escaped(roleWord)}\\b`, 'iu').test(evidence)
                    && ownerNames.some(name => textMentionsIdentityVariant(evidence, [name]))
                    && textMentionsIdentityVariant(evidence, [entity.name, ...(entity.aliases || [])]);
            }));
        if (resolvedThreadNames.length === 1) {
            const canonical = cleanText(resolvedThreadNames[0].name);
            const duplicate = result.identityResolutions.some(item => normalized(item?.reference) === normalized(reference));
            if (!duplicate) {
                result.identityResolutions.push({
                    reference, canonical,
                    evidence: `Resolved identity continuity identifies ${reference} as ${canonical}.`,
                });
                recovered++;
            }
            continue;
        }
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

const EXPLICIT_RELATIONSHIP_FACT_ROLE = /\b(?:apprenticeship|apprentices?|students?|padawans?|pupils?|prot[eé]g[eé]s?|mentors?|mentees?|teachers?|instructors?|parents?|mothers?|fathers?|children|sons?|daughters?|siblings?|brothers?|sisters?|spouses?|husbands?|wives|married|friends?|allies|rivals?|enemies|attendants?|retainers?|servants?|employers?|employees?|commanders?|subordinates?|teammates?|partners?|captors?|captives?|prisoners?|guardians?|wards?)\b/iu;
const NON_CANONICAL_RELATIONSHIP_FACT = /\b(?:belief|claim|allegation|rumou?r|speculation|suspicion|intention|possibility|possible|possibly|perhaps|maybe|might|may be|whether|uncertain|unconfirmed|disputed|according to)\b/iu;
const EXPLICIT_RELATIONSHIP_ASSERTION = /\b(?:is|was|are|were|became|becomes|served as|serves as|trained|trains|taught|teaches|mentored|mentors|married|befriended|allied with|captured|holds? as|employs?|commands?|guards?|raised)\b/iu;

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

function relationshipEvidenceMentionsPerson(person, value, people = []) {
    const source = cleanText(value);
    const uniqueNameParts = cleanText(person?.name).split(/\s+/u).filter(part => part.length >= 3
        && people.filter(candidate => cleanText(candidate?.name).split(/\s+/u)
            .some(candidatePart => normalized(candidatePart) === normalized(part))).length === 1);
    return [person?.name, ...(person?.aliases || []), ...uniqueNameParts].map(cleanText).filter(Boolean)
        .some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(source));
}

function relationshipFactIsCorroborated(result, messages, people) {
    const supported = value => {
        const source = cleanText(value);
        return EXPLICIT_RELATIONSHIP_FACT_ROLE.test(source)
            && !NON_CANONICAL_RELATIONSHIP_FACT.test(source)
            && people.every(person => relationshipEvidenceMentionsPerson(person, source, people));
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
    if (/\bpadawans?\b/iu.test(source)) return 'Jedi master and Padawan';
    if (/\b(?:apprenticeship|apprentices?)\b/iu.test(source)) return 'master and apprentice';
    if (/\b(?:students?|pupils?|teachers?|instructors?)\b/iu.test(source)) return 'teacher and student';
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
        const relationalFraming = EXPLICIT_RELATIONSHIP_FACT_ROLE.test(`${predicate} ${category}`)
            || EXPLICIT_RELATIONSHIP_ASSERTION.test(core);
        if (!value || /^(?:knowledge boundary|knowledge gap)$/iu.test(category)
            || !EXPLICIT_RELATIONSHIP_FACT_ROLE.test(evidence)
            || !relationalFraming
            || NON_CANONICAL_RELATIONSHIP_FACT.test(`${predicate} ${category}`)
            || NON_CANONICAL_RELATIONSHIP_FACT.test(value)
            || normalized(fact?.persistence) === 'temporary') continue;
        const subject = canonicalMention(index, fact?.subject);
        const predicatePeople = explicitlyMentionedPeople(index, `${cleanText(fact?.subject)} ${predicate}`);
        const mentioned = explicitlyMentionedPeople(index, core);
        const predicatePair = [...new Map([subject, ...predicatePeople]
            .filter(personEntity).map(person => [normalized(person.name), person])).values()];
        const people = predicatePair.length === 2
            ? predicatePair
            : [...new Map([subject, ...mentioned].filter(personEntity).map(person => [normalized(person.name), person])).values()];
        const trainingList = personEntity(subject) && people.length > 2
            && /\b(?:teach(?:es|ing)?|taught|train(?:s|ed|ing)?|mentor(?:s|ed|ing)?)\b/iu.test(value)
            && EXPLICIT_RELATIONSHIP_FACT_ROLE.test(predicate);
        const pairs = people.length === 2
            ? [people]
            : trainingList
                ? people.filter(person => normalized(person.name) !== normalized(subject.name)).map(person => [subject, person])
                : [];
        for (const pair of pairs) {
            if (!relationshipFactIsCorroborated(result, messages, trainingList ? people : pair)) continue;
            const candidate = { from: pair[0].name, to: pair[1].name };
            const pairIdentity = resolvedRelationshipPairIdentity(result, candidate, { ...(world || {}), entities: index.entities });
            if (!pairIdentity || result.relationships.some(item => resolvedRelationshipPairIdentity(result, item, world) === pairIdentity)) continue;
            const stored = (world?.relationships || []).find(item => resolvedRelationshipPairIdentity(result, item, world) === pairIdentity);
            if (stored && /^knowledge$/iu.test(category)) continue;
            const migratedByIdentity = stored && (result?.identityResolutions || []).some(resolution =>
                [stored?.from, stored?.to].some(endpoint => normalized(endpoint) === normalized(resolution?.reference))
                && [candidate.from, candidate.to].some(endpoint => normalized(endpoint) === normalized(resolution?.canonical)));
            if (migratedByIdentity) continue;
            let kind = cleanText(stored?.kind) || relationshipKindFromFact(evidence);
            const pairDescriptions = pair.flatMap(person => [...(world?.entities || []), ...(result?.entities || [])]
                .filter(entity => normalized(entity?.name) === normalized(person.name))
                .map(entity => cleanText(entity?.description))).join(' ');
            if (/\bJedi\s+master\b/iu.test(pairDescriptions) && /\bpadawan\b/iu.test(pairDescriptions)) kind = 'Jedi master and Padawan';
            const description = trainingList
                ? kind === 'Jedi master and Padawan'
                    ? `${pair[0].name} trained ${pair[1].name} as a Jedi Padawan.`
                    : `${pair[0].name} trained ${pair[1].name} as an apprentice or student.`
                : relationshipDescriptionFromFact(fact, pair);
            const priorDescription = cleanText(stored?.dynamic);
            const dynamic = priorDescription && coverageOverlap(priorDescription, description) < 3
                ? `${priorDescription} ${description}`.slice(0, 1200)
                : description;
            const historical = /\b(?:former|previous|prior|ex-|ended|deceased|dead|late)\b/iu.test(evidence)
                || pair.some(person => entityIsEstablishedDead(person, result, world));
            const provenance = Array.isArray(fact?.sources) && fact.sources.length ? { sources: fact.sources } : {};
            const temporal = cleanText(fact?.temporalAnchorId || stored?.temporalAnchorId);
            result.relationships.push({
                targetId: cleanText(stored?.id),
                from: cleanText(stored?.from) || pair[0].name,
                to: cleanText(stored?.to) || pair[1].name,
                kind,
                status: cleanText(stored?.status) || (historical ? 'ended' : 'active'),
                dynamic,
                importance: Math.max(3, Math.min(5, Number(fact?.importance || stored?.importance || 3))),
                ...(temporal ? { temporalAnchorId: temporal } : {}),
                ...provenance,
            });
            recovered++;
        }
    }
    return recovered;
}

function identityRoleRelationshipKind(role) {
    const value = cleanText(role);
    if (/\bpadawan\b/iu.test(value)) return 'Jedi master and Padawan';
    if (/\bapprentice\b/iu.test(value)) return 'master and apprentice';
    if (/\b(?:student|pupil)\b/iu.test(value)) return 'teacher and student';
    if (/\b(?:mentor|prot[eé]g[eé])\b/iu.test(value)) return 'mentor and protégé';
    if (/\b(?:jedi\s+master)\b/iu.test(value)) return 'Jedi master and Padawan';
    if (/\b(?:master|teacher)\b/iu.test(value)) return 'master and student';
    if (/\b(?:parent|mother|father)\b/iu.test(value)) return 'parent and child';
    if (/\b(?:brother|sister|sibling)\b/iu.test(value)) return 'siblings';
    return 'established personal relationship';
}

// A validated descriptive-person resolution also establishes the relationship
// encoded by that description. This prevents a model from resolving “A's
// former apprentice” to B while leaving only an entity merge and no A↔B
// relationship in durable memory.
function recoverIdentityResolutionRelationships(result, world) {
    if (!Array.isArray(result?.identityResolutions) || !Array.isArray(result?.relationships)) return 0;
    const index = continuityEntityIndex(result, world);
    let recovered = 0;
    for (const resolution of result.identityResolutions) {
        const descriptor = descriptivePersonIdentityContext(resolution?.reference, world);
        if (!descriptor) continue;
        const owner = canonicalMention(index, descriptor.owner);
        const canonical = canonicalMention(index, resolution?.canonical);
        if (!personEntity(owner) || !personEntity(canonical)
            || normalized(owner.name) === normalized(canonical.name)) continue;
        const pair = resolvedRelationshipPairIdentity(result, { from: owner.name, to: canonical.name }, world);
        if (!pair || [...(world?.relationships || []), ...result.relationships]
            .some(item => resolvedRelationshipPairIdentity(result, item, world) === pair)) continue;
        const historical = /\b(?:former|previous|prior|dead|deceased)\b/iu.test(descriptor.role);
        const role = cleanText(descriptor.role).toLocaleLowerCase()
            .replace(/\bjedi\b/giu, 'Jedi').replace(/\bsith\b/giu, 'Sith');
        result.relationships.push({
            targetId: '', from: owner.name, to: canonical.name,
            kind: identityRoleRelationshipKind(descriptor.role),
            status: historical ? 'ended' : 'active',
            dynamic: `${canonical.name} ${historical ? 'was' : 'is'} ${owner.name}'s ${role}.`,
            importance: 4,
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

const ACTIVE_PHYSICAL_RESTRAINT = /\b(?:restrained|bound|cuffed|handcuffed|shackled|chained|tied)\b/iu;
const PHYSICAL_RELEASE_ACTION = /\b(?:removes?|removed|unclips?|unclipped|unlocks?|unlocked|releases?|released|frees?|freed|unfastens?|unfastened|cuts? off|cut off)\b/iu;
const PHYSICAL_RESTRAINT_OBJECT = /\b(?:restraints?|cuffs?|handcuffs?|shackles?|chains?|bindings?|bonds?)\b/iu;
const ENDED_PHYSICAL_RESTRAINT = /\bno longer\s+(?:restrained|bound|cuffed|handcuffed|shackled|chained|tied)\b/iu;

export function trimSupersededPhysicalRestraintFacts(result, messages) {
    if (!Array.isArray(result?.facts)) return 0;
    const transitionEvidence = [
        ...(messages || []).map(message => cleanText(message?.text ?? message?.mes)),
        ...(result?.states || []).map(state => `${cleanText(state?.subject)} ${cleanText(state?.value)}`),
        ...(result?.events || []).flatMap(event => [cleanText(event?.summary), cleanText(event?.consequences)]),
    ].filter(value => ENDED_PHYSICAL_RESTRAINT.test(value)
        || (PHYSICAL_RELEASE_ACTION.test(value) && PHYSICAL_RESTRAINT_OBJECT.test(value)));
    if (!transitionEvidence.length) return 0;
    let trimmed = 0;
    const discarded = new Set();
    for (const fact of result.facts) {
        const subject = cleanText(fact?.subject);
        const value = cleanText(fact?.value);
        if (!subject || !ACTIVE_PHYSICAL_RESTRAINT.test(value)
            || !transitionEvidence.some(evidence => textMentionsCanonicalName(evidence, subject))) continue;
        const staleRider = new RegExp(`(?:,?\\s+)(?:while|although|but)\\s+(?:${escaped(subject)}|he|she|they)\\s+(?:still\\s+)?(?:remains?|is|are|was|were)\\s+(?:physically\\s+)?(?:restrained|bound|cuffed|handcuffed|shackled|chained|tied)\\b[^.!?]*[.!?]?$`, 'iu');
        const staleSentence = new RegExp(`^(?:${escaped(subject)}|he|she|they)\\s+(?:still\\s+)?(?:remains?|is|are|was|were)\\s+(?:physically\\s+)?(?:restrained|bound|cuffed|handcuffed|shackled|chained|tied)\\b[^.!?]*[.!?]?$`, 'iu');
        let next = staleSentence.test(value) ? '' : value.replace(staleRider, '').trim();
        if (!next) {
            discarded.add(fact);
            trimmed++;
            continue;
        }
        if (/[.!?]$/u.test(value) && !/[.!?]$/u.test(next)) next += value.slice(-1);
        if (normalized(next) === normalized(value)) continue;
        fact.value = next;
        trimmed++;
    }
    if (discarded.size) result.facts = result.facts.filter(fact => !discarded.has(fact));
    return trimmed;
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
        // A model-written L1 beat cannot turn the proposition embedded in a
        // character's assertion into objective memory. Commitments are kept as
        // speech acts (the vow itself happened), but identity, relationship,
        // capability, state, and event records require objective or explicit
        // user OOC/meta support.
        if (!COVERAGE_COMMITMENT.test(beat) && sourceOnlySubjective(beat, messages)) continue;
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

const THREAD_GAP = /\b(?:not yet|never (?:told|learned|knew|disclosed|answered|explained|revealed|identified|confirmed|established)|has not|have not|had not|does not|do not|did not|is not|are not|was not|were not|continues? to|seek(?:s|ing)? to (?:determine|learn|discover|identify|find|decide|understand)|tr(?:y|ies|ied|ying) to (?:determine|learn|discover|identify|find|decide|understand)|unknown|unanswered|unresolved|undecided|pending|unconfirmed|incomplete|incoming|en route|on the way|on standby|ready (?:for|to)|prepared (?:for|to)|not (?:complete|completed|done|confirmed|established|disclosed|answered|accepted|met|delivered)|no (?:(?:clear|definitive|final|verified)\s+)?(?:answer|decision|confirmation|evidence|proof)|no (?:confirmed|verified|established|identified|known)\b[^.!?;]{0,100}\b(?:identified|confirmed|verified|established|found|determined|known)|neither\b[^.!?;]{0,160}\b(?:complete|completed|done|obtained|recovered)|lacks? (?:confirmation|evidence|proof|an answer)|awaits?|must (?:learn|discover|identify|find|decide|preserve|maintain|continue|keep)|still (?:required|needed|missing|pending|unresolved|unconfirmed)|remains? (?:unknown|unanswered|unresolved|undecided|missing|pending|unconfirmed|incomplete|open|hidden|concealed|undisclosed))\b/iu;
const THREAD_UNCERTAIN_ASSERTION = /\b(?:suspects?|believes?|thinks?|assumes?|speculates?|claims?|alleges?|may|might|possibly|perhaps|apparently|reportedly|unverified|uncorroborated|partially|partly|without (?:proof|evidence|confirmation)|provides? no (?:proof|evidence|confirmation))\b/iu;
const THREAD_COMMITMENT_PENDING = /\b(?:must|will|shall|['’]ll|going to|plans? to|intends? to|promises? to|vows? to|prepar(?:e|es|ed|ing) to|en route|in transit|heading to|on (?:the )?way to|arrival (?:is )?expected|tomorrow|later|next (?:day|morning|afternoon|evening|night|week|month|year))\b/iu;
const THREAD_IN_PROGRESS = /\b(?:begins?|began|start(?:s|ed|ing)?|ongoing|in progress|underway|continues?|continuing)\b/iu;
const THREAD_RESOLUTION = /\b(?:answers?|answered|reveals?|revealed|discloses?|disclosed|describes?|described|explains?|explained|details?|detailed|identifies?|identified|learns?|learned|discovers?|discovered|finds?|found|recovers?|recovered|secures?|secured|logs?|logged|establishes?|established|returns?|returned|departs?|departed|leaves?|left|sets? out|set out|arrives?|arrived|reaches?|reached|enters?|entered|ends?|ended|meets?|met|contacts?|contacted|reports?|reported|delivers?|delivered|presents?|presented|completes?|completed|finishes?|finished|decides?|decided|chooses?|chose|accepts?|accepted|rejects?|rejected|defeats?|defeated|destroys?|destroyed|repairs?|repaired|opens?|opened|closes?|closed|fulfills?|fulfilled|obtains?|obtained|acquires?|acquired|now knows?)\b/iu;
const THREAD_VAGUE_RESIDUAL = /\b(?:extent|consequences|broader (?:history|implications|meaning|exploration)|further (?:exploration|evaluation)|what (?:this|that) means)\b[^.!?;]{0,160}\b(?:open|unexplored|unclear|unknown|unresolved|incomplete|partly explored)\b/iu;
const THREAD_ACTION_RESOLUTION_RULES = [
    [/\b(?:conceal(?:s|ed|ing)?|concealment|keep\b[^.!?;]{0,80}\bhidden)\b/iu, /\b(?:discovers?|discovered|reveals?|revealed|exposes?|exposed|learns?|learned|no longer concealed|concealment (?:ends?|ended|fails?|failed|is broken|was broken))\b/iu],
    [/\b(?:answer|description|describe|details?)\b/iu, /\b(?:answers?|answered|describes?|described|details?|detailed|explains?|explained|reports?|reported)\b/iu],
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
        || THREAD_UNCERTAIN_ASSERTION.test(evidence)
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
        if (splitPartiallyResolvedCompoundThread(result, stored, incoming, resolvedDetail)) continue;
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
        const multiTopicBaseline = Boolean(stored && THREAD_GAP.test(cleanText(stored?.detail))
            && /\b(?:and|or|additional|circumstances|questions?|claims?|history|reasons?)\b/iu.test(cleanText(stored?.detail))
            && topic.size >= 6);
        const minimumTopicOverlap = specificAction ? 1 : multiTopicBaseline
            ? Math.max(3, Math.ceil(topic.size * 0.45)) : 2;
        const supported = narrowedResolution || (!explicitUnfinished && cleanText(incoming?.detail).length <= 1800 && candidates.some((evidence, index) =>
            THREAD_RESOLUTION.test(evidence)
            && threadResolutionActionMatches(baseline, evidence)
            && threadResolutionActorMatches(baseline, evidence)
            && termSetOverlap(topic, threadTopicTerms(evidence, result, world)) >= minimumTopicOverlap
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
        // Identity questions are resolved only by the structured identity
        // resolver below. Generic prose such as "identifies herself as a
        // prisoner" must not close an unrelated true-identity thread.
        if (IDENTITY_THREAD.test(cleanText(thread?.title))) continue;
        const incoming = incomingThreadFor(result, thread);
        if (incoming && incoming.status !== 'open') continue;
        const topic = threadTopicTerms(`${thread.title || ''} ${thread.detail || ''}`, result, world);
        const title = threadTopicTerms(thread.title, result, world);
        if (/\b(?:answer|description|describe|details?)\b/iu.test(cleanText(thread?.title))) {
            const explicitAnswer = resolutionEvidence.map(cleanText).find(beat => beat
                && THREAD_RESOLUTION.test(beat)
                && threadResolutionActionMatches(thread, beat)
                && !threadEvidenceIsIncomplete(thread, beat)
                && threadParticipantMatch(thread, beat, world, result)
                && termSetOverlap(title, threadTerms(beat)) >= 1);
            const structuredSupport = explicitAnswer && (result?.facts || []).some(fact =>
                !THREAD_GAP.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`)
                && coverageOverlap(explicitAnswer, `${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`) >= 3
                && (thread?.participants || []).some(participant => normalized(participant) === normalized(fact?.subject)));
            if (explicitAnswer && (structuredSupport || sourceSupportsThreadAction(messages, thread, world, result))) {
                const resolution = incoming || {};
                Object.assign(resolution, {
                    targetId: thread.id, title: thread.title, detail: `Resolved by explicit continuity: ${explicitAnswer}`,
                    status: 'resolved', participants: thread.participants || [], importance: thread.importance || 3,
                });
                if (!incoming) result.threads.push(resolution);
                resolved++;
                continue;
            }
        }
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
                ? (commitmentResolution || /\b(?:answer|description|describe|details?|recover|recovery|retrieve|retrieval|request|contact|channel)\b/iu.test(cleanText(thread?.title)) ? 1 : 2)
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

// Final fail-closed lifecycle gate. Earlier passes combine model output,
// historical records, and recovered evidence; no matter which path produced
// the record, "resolved" cannot survive when its own detail still says that
// the answer or action is pending and contains no completed atomic clause.
export function reopenInternallyUnresolvedThreads(result) {
    if (!Array.isArray(result?.threads)) return 0;
    let reopened = 0;
    for (const thread of result.threads) {
        if (normalized(thread?.status) !== 'resolved') continue;
        const detail = cleanText(thread?.detail).replace(/^Resolved(?:(?: by| through)[^:]*)?:\s*/iu, '');
        const historicalGapResolved = /\bunanswered\b[^.!?;]{0,160}\b(?:led to|resulted in|ended (?:when|with))\b/iu.test(detail)
            && threadResolutionActionMatches(thread, detail);
        if (!detail || historicalGapResolved || !threadEvidenceIsIncomplete(thread, detail) || completedThreadEvidence(thread, detail)) continue;
        thread.status = 'open';
        thread.detail = detail;
        reopened++;
    }
    return reopened;
}

const IDENTITY_THREAD = /\b(?:identity|identif(?:y|ies|ied|ying)|true name|real name|who (?:is|was|are|were))\b/iu;
const IDENTITY_RESIDUAL_GENERIC = new Set([
    ...THREAD_MATCH_STOP_WORDS,
    'identity', 'name', 'named', 'real', 'true', 'canonical', 'known', 'revealed', 'identified',
    'ask', 'asked', 'asking', 'answer', 'answered', 'answering', 'become', 'became', 'becoming',
    'background', 'before', 'circumstances', 'dead', 'deceased', 'explain', 'explained', 'former',
    'give', 'given', 'history', 'jedi', 'know', 'knowing', 'knows', 'master', 'past', 'prior',
    'role', 'roles', 'status', 'undisclosed', 'what', 'whether',
]);

function identityResolutionMatchesThread(thread, resolution) {
    const reference = cleanText(resolution?.reference);
    const canonical = cleanText(resolution?.canonical);
    const title = cleanText(thread?.title);
    const text = `${title} ${thread?.detail || ''}`;
    // Identity resolution may answer a name question, but it must not close a
    // broader biographical thread merely because its detail mentions identity.
    if (!reference || !canonical || !IDENTITY_THREAD.test(title)) return false;
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
        && (textMentionsIdentityVariant(title, [descriptor.owner])
            || new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(descriptor.owner)}[’']s`, 'iu').test(title))
        && new RegExp(`\\b${escaped(cleanText(descriptor.role).split(/\\s+/u).at(-1))}\\b`, 'iu').test(title)) return true;
    const referenceTerms = threadTerms(reference);
    return termSetOverlap(referenceTerms, threadTerms(title)) >= 2;
}

function identityThreadResidualDetail(incoming, resolution, world, result, messages = null) {
    const detail = cleanText(incoming?.detail);
    if (!detail || !THREAD_GAP.test(detail)) return '';
    const residualQuestion = /\b(?:fate|what became|what happened|later life|subsequent history)\b/iu;
    if (Array.isArray(messages) && residualQuestion.test(detail)
        && !messages.some(message => residualQuestion.test(cleanText(message?.text ?? message?.mes)))) return '';
    const entityTerms = new Set(recoveryEntities(result, world).flatMap(entity => entity.variants)
        .flatMap(value => [...coverageTerms(value)]));
    for (const value of [resolution?.reference, resolution?.canonical]) {
        for (const term of coverageTerms(value)) entityTerms.add(term);
    }
    const topical = [...coverageTerms(detail)].filter(term => !IDENTITY_RESIDUAL_GENERIC.has(term) && !entityTerms.has(term));
    return topical.length >= 2 ? detail : '';
}

function identityResidualSuccessorDetail(detail, resolution, thread) {
    const canonical = cleanText(resolution?.canonical);
    const participants = (thread?.participants || []).map(cleanText)
        .filter(name => name && normalized(name) !== normalized(canonical));
    const holder = participants[0] || 'The involved characters';
    if (/\b(?:fate|what became|what happened|later life|subsequent history)\b/iu.test(detail)) {
        return `The identity is resolved as ${canonical}; ${holder} still lacks the separately requested later fate or subsequent history.`;
    }
    return cleanText(detail);
}

export function reconcileResolvedIdentityThreads(result, world, messages = null) {
    if (!Array.isArray(result?.threads) || !Array.isArray(result?.identityResolutions)) return 0;
    let resolved = 0;
    for (const resolution of result.identityResolutions) {
        for (const thread of (world?.threads || []).filter(item => item?.status === 'open'
            && identityResolutionMatchesThread(item, resolution))) {
            const incoming = incomingThreadFor(result, thread);
            if (incoming?.status && incoming.status !== 'open') continue;
            const residualDetail = incoming ? identityThreadResidualDetail(incoming, resolution, world, result, messages) : '';
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
                detail: identityResidualSuccessorDetail(residualDetail, resolution, thread),
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

function compactRepeatedRelationshipLead(dynamic, from, to) {
    const clauses = cleanText(dynamic).split(/\s*;\s*|(?<=[.!?])\s+/u).map(cleanText).filter(Boolean);
    if (clauses.length < 2) return cleanText(dynamic);
    const names = [from, to].map(escaped).join('|');
    const leadPattern = new RegExp(`^((?:${names})\\s+(?:commands?|controls?|employs?|guards?|mentors?|trains?|serves?|supports?|protects?|follows?|assists?)\\s+(?:the\\s+|an?\\s+)?(?:${names}))\\s*,?\\s+(?:who\\s+)?(.+)$`, 'iu');
    const seen = new Set();
    const compacted = clauses.map(clause => {
        const match = clause.match(leadPattern);
        if (!match) return clause;
        const lead = normalized(match[1]);
        if (!seen.has(lead)) {
            seen.add(lead);
            return clause;
        }
        const object = [from, to].find(name => new RegExp(`${escaped(name)}$`, 'iu').test(cleanText(match[1]))) || to;
        return `${object} ${cleanText(match[2])}`;
    });
    return compacted.join('; ');
}

export function normalizeRelationshipDescriptions(result) {
    if (!Array.isArray(result?.relationships)) return 0;
    let normalizedDescriptions = 0;
    for (const item of result.relationships) {
        const from = cleanText(item?.from);
        const to = cleanText(item?.to);
        if (!from || !to) continue;
        let dynamic = cleanText(item?.dynamic);
        for (const name of [from, to]) {
            const tail = cleanText(name).split(/\s+/u).at(-1);
            if (!tail) continue;
            dynamic = dynamic.replace(new RegExp(`((?:^|[^\\p{L}\\p{N}])${escaped(name)})\\s+${escaped(tail)}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1');
        }
        dynamic = compactRepeatedRelationshipLead(dynamic, from, to);
        item.dynamic = dynamic;
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

export function normalizeCompositeStateSubjects(result, world) {
    if (!Array.isArray(result?.states)) return 0;
    const index = continuityEntityIndex(result, world);
    const normalizedStates = [];
    let split = 0;
    for (const state of result.states) {
        const parts = cleanText(state?.subject).split(/\s+and\s+/iu).map(cleanText).filter(Boolean);
        const owners = parts.map(part => canonicalMention(index, part)).filter(personEntity);
        const distinctOwners = [...new Map(owners.map(owner => [normalized(owner.name), owner])).values()];
        if (parts.length < 2 || distinctOwners.length !== parts.length) {
            normalizedStates.push(state);
            continue;
        }
        for (const [ownerIndex, owner] of distinctOwners.entries()) normalizedStates.push({
            ...state,
            targetId: ownerIndex === 0 ? cleanText(state?.targetId) : '',
            subject: owner.name,
        });
        split += distinctOwners.length - 1;
    }
    result.states = normalizedStates;
    return split;
}

const SCENE_ONLY_STATE = /\b(?:attending|dressed|escorting|freshly|kneeling|lying|outfit|positioned|seated|sitting|standing|waiting|wearing)\b/iu;
const DURABLE_CONDITION_STATE = /\b(?:assigned|bound|broken|burned|chronic|disabled|duty|healing|injured|missing|ordered|paralyzed|pregnant|recovering|scarred|sworn|wounded)\b/iu;
const NEGATIVE_ONLY_STATE = /\b(?:no|not|none|without)\b[^.!?]{0,80}\b(?:change|condition|injury|wound)\b|\b(?:nothing|no change)\s+(?:new|established)\b/iu;

export function sanitizeStateDurability(result) {
    if (!Array.isArray(result?.states)) return { discarded: 0, demoted: 0 };
    let discarded = 0;
    let demoted = 0;
    result.states = result.states.filter(state => {
        if (normalized(state?.operation) === 'clear') return true;
        const value = cleanText(state?.value);
        const attribute = cleanText(state?.attribute);
        if (!value) return true;
        const clothingOrNegativeCondition = /\b(?:physical condition|health|injury|wounds?)\b/iu.test(attribute)
            && (NEGATIVE_ONLY_STATE.test(value) || (/\b(?:dressed|outfit|wearing|robes?|armor)\b/iu.test(value)
                && !DURABLE_CONDITION_STATE.test(value)));
        if (clothingOrNegativeCondition) {
            discarded++;
            return false;
        }
        if (normalized(state?.scope) === 'ongoing' && SCENE_ONLY_STATE.test(value)
            && !DURABLE_CONDITION_STATE.test(value)) {
            state.scope = 'scene';
            demoted++;
        }
        return true;
    });
    return { discarded, demoted };
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
    const canonicalRecords = [entity, ...(world?.entities || []), ...(result?.entities || [])]
        .filter(item => normalized(item?.name) === normalized(name));
    if (canonicalRecords.some(item => /\b(?:dead|deceased)\b/iu.test(`${cleanText(item?.type)} ${cleanText(item?.description)}`))) return true;
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
const AUDIT_ATTRIBUTION_VERB = /\b(?:believes?|believed|claims?|claimed|alleges?|alleged|reports?|reported|rumou?rs?|rumou?red|suspects?|suspected|speculates?|speculated|thinks?|thought|assumes?|assumed|infers?|inferred|concludes?|concluded|remembers?|remembered|recalls?|recalled|says?|said|tells?|told|states?|stated|reveals?|revealed|discloses?|disclosed|explains?|explained|informs?|informed|insists?|insisted|argues?|argued)\b/iu;
const AUDIT_ACTIVE_ATTRIBUTION_VERB = /(?:believes?|believed|claims?|claimed|alleges?|alleged|reports?|reported|rumou?rs?|rumou?red|suspects?|suspected|speculates?|speculated|thinks?|thought|assumes?|assumed|infers?|inferred|concludes?|concluded|remembers?|remembered|recalls?|recalled|says?|said|states?|stated|reveals?|revealed|discloses?|disclosed|explains?|explained|informs?|informed|insists?|insisted|argues?|argued)/iu;
const AUDIT_SOURCE_SUBJECTIVE = /(?:[“”"]|\b(?:i|we)\s+(?:(?:say|said|tell|told|claim|claimed|state|stated|insist|insisted|argue|argued|believe|believed|think|thought|suspect|suspected|remember|remembered|recall|recalled)|(?:(?:am|are|was|were|have been|had been|serve|serves|served|work|works|worked|command|commands|commanded|hold|holds|held|possess|possesses|possessed|own|owns|owned)\b))|\b(?:according to|in (?:his|her|their|my|our) (?:view|memory|belief)|appears?|appeared|seems?|seemed|probably|possibly|perhaps|maybe|might|unconfirmed|disputed)\b|\b(?:belief|claim|allegation|rumou?r|report|record|dossier|testimony|perspective|inference|conclusion|memory)\b)/iu;
const AUDIT_SOURCE_AUTHORITATIVE = /(?:^|[\s[(])(?:OOC|out[- ]of[- ]character|meta|canon(?:ical)?\s+note|author(?:'s)?\s+note|GM\s+note|narrator\s+note)\s*(?:[:—–-]|\)|\])/iu;
const CHARACTER_PROFILE_SECTION = /(Role\/background|Age\/demographics|Appearance|Personality\/quirks):\s*/giu;
const CHARACTER_PROFILE_ORDER = ['roleBackground', 'ageDemographics', 'appearance', 'personalityQuirks'];
const CHARACTER_PROFILE_LABEL = {
    roleBackground: 'Role/background',
    ageDemographics: 'Age/demographics',
    appearance: 'Appearance',
    personalityQuirks: 'Personality/quirks',
};
const CHARACTER_PROFILE_GENERIC_TERMS = new Set([
    'role', 'background', 'age', 'demographics', 'appearance', 'personality', 'quirk', 'quirks', 'character', 'entity',
]);
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

function repairTopicKnowledgeAsHolder(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    let repaired = 0;
    for (const fact of result.facts) {
        if (normalized(fact?.category) !== 'character belief') continue;
        const match = cleanText(fact?.predicate).match(/^belief about\s+(.+?)\s+[—–-]\s+knowledge of\s+(.+)$/iu);
        if (!match) continue;
        const topic = canonicalMention(index, cleanText(match[1]));
        const holder = canonicalMention(index, fact?.subject);
        if (!personEntity(topic) || normalized(topic.name) === normalized(holder?.name)) continue;
        const value = cleanText(fact?.value);
        const verb = '(?:knows?|learns?|learned|has learned|recognizes?|remembers?|recalls?)';
        const directKnowledge = new RegExp(`^(?:(?:now|still|already)\\s+)?${verb}\\b`, 'iu').test(value);
        const topicKnowledge = new RegExp(`^${escaped(topic.name)}\\s+(?:(?:now|still|already)\\s+)?${verb}\\b`, 'iu').test(value);
        if (!directKnowledge && !topicKnowledge) continue;
        fact.subject = topic.name;
        fact.predicate = `knowledge of ${cleanText(match[2])}`;
        fact.category = 'knowledge';
        fact.targetId = '';
        repaired++;
    }
    return repaired;
}

function trimCrossHolderAttributedClauses(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    let trimmed = 0;
    for (const fact of result.facts) {
        if (!AUDIT_ATTRIBUTED_CATEGORY.test(cleanText(fact?.category))) continue;
        const holder = canonicalMention(index, fact?.subject);
        const clauses = cleanText(fact?.value).split(/(?<=[.!?])\s+/u).filter(Boolean);
        if (!personEntity(holder) || clauses.length < 2) continue;
        const retained = [clauses[0]];
        for (const clause of clauses.slice(1)) {
            const other = index.entities.filter(personEntity).find(entity => normalized(entity.name) !== normalized(holder.name)
                && [entity.name, ...(entity.aliases || [])].some(name => new RegExp(
                    `^${escaped(cleanText(name))}\\s+(?:(?:now|still|additionally|also|already|privately)\\s+){0,3}(?:knows?|learns?|hears?|believes?|thinks?|recognizes?|rejects?|accepts?)\\b`, 'iu',
                ).test(clause)));
            if (other) {
                trimmed++;
                continue;
            }
            retained.push(clause);
        }
        fact.value = retained.join(' ');
    }
    return trimmed;
}

// Coverage models sometimes turn a character's inference clause into an
// objective designation, e.g. “that Alice is building a hidden network”. A
// subordinate “that …” clause is not itself a role/title assertion and must
// not enter durable identity memory under the validator-generated predicate.
function discardMalformedEstablishedDesignationFacts(result) {
    if (!Array.isArray(result?.facts)) return 0;
    const before = result.facts.length;
    result.facts = result.facts.filter(fact => normalized(fact?.predicate) !== 'established role or designation'
        || !/^that\b/iu.test(cleanText(fact?.value)));
    return before - result.facts.length;
}

// A knowledge record belongs to the character whose knowledge it states, not
// to a different character who merely infers or claims that knowledge. Models
// occasionally emit “Alice — knowledge of Bob: Cara concludes that Alice…”;
// preserve that useful statement as Cara's belief so it cannot block later
// direct evidence of what Alice actually knows.
export function normalizeKnowledgeHolderContamination(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    let normalizedFacts = 0;
    for (const fact of result.facts) {
        if (normalized(fact?.category) !== 'knowledge'
            || !/^knowledge of\s+\S/iu.test(cleanText(fact?.predicate))) continue;
        const statedSubject = canonicalMention(index, fact?.subject);
        const value = cleanText(fact?.value);
        if (/^(?:(?:now|still|already)\s+)?(?:knows?|learns?|learned|has learned|had learned|recognizes?|recognized|remembers?|remembered|recalls?|recalled|does not know|did not know|has not learned)\b/iu.test(value)) continue;
        if (personEntity(statedSubject) && new RegExp(
            `^${escaped(statedSubject.name)}\\s+(?:(?:now|still|already)\\s+)?(?:knows?|learns?|learned|has learned|had learned|recognizes?|recognized|remembers?|remembered|recalls?|recalled|does not know|did not know|has not learned)\\b`, 'iu',
        ).test(value)) continue;
        const attribution = value.match(AUDIT_ATTRIBUTION_VERB);
        const actorWindow = attribution?.index == null ? '' : value.slice(Math.max(0, attribution.index - 120), attribution.index);
        const explicitHolder = entityNamedBeforeAttributionVerb(index, value)
            || nearestCanonicalMention(index, actorWindow);
        if (!personEntity(statedSubject) || !personEntity(explicitHolder)
            || normalized(statedSubject.name) === normalized(explicitHolder.name)) continue;
        const topicText = cleanText(fact.predicate).replace(/^knowledge of\s+/iu, '');
        const topic = canonicalMention(index, topicText)?.name || topicText;
        fact.subject = explicitHolder.name;
        fact.predicate = `belief about ${statedSubject.name} — knowledge of ${topic}`;
        fact.category = 'character belief';
        fact.persistence = cleanText(fact.persistence) || 'persistent';
        fact.targetId = '';
        normalizedFacts++;
    }
    return normalizedFacts;
}

function discardMisownedQuestionKnowledgeFacts(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    const before = result.facts.length;
    result.facts = result.facts.filter(fact => {
        if (normalized(fact?.category) !== 'knowledge'
            || !/^knowledge of\s+\S/iu.test(cleanText(fact?.predicate))) return true;
        const statedSubject = canonicalMention(index, fact?.subject);
        const value = cleanText(fact?.value);
        const leadingActor = index.entities.filter(personEntity).map(entity => {
            const positions = [entity.name, ...(entity.aliases || [])].map(cleanText).filter(Boolean).map(name => {
                const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').exec(value.slice(0, 120));
                return match ? match.index : Number.POSITIVE_INFINITY;
            });
            return { entity, position: Math.min(...positions) };
        }).filter(item => Number.isFinite(item.position)).sort((left, right) => left.position - right.position)[0]?.entity;
        if (!personEntity(statedSubject) || !personEntity(leadingActor)
            || normalized(statedSubject.name) === normalized(leadingActor.name)) return true;
        // Questions and requests describe the leading actor's uncertainty;
        // they cannot establish what another person knows merely because that
        // other person is mentioned as the topic of the question.
        return !/\b(?:asks?|asked|questions?|questioned|wonders?|wondered|seeks? to (?:learn|know|understand)|tries? to (?:learn|know|understand))\b/iu.test(value);
    });
    return before - result.facts.length;
}

function discardMismatchedKnowledgeTopicFacts(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    const mentionVariants = entity => {
        const uniqueParts = cleanText(entity?.name).split(/\s+/u).filter(part => part.length >= 3
            && index.entities.filter(candidate => cleanText(candidate?.name).split(/\s+/u)
                .some(candidatePart => normalized(candidatePart) === normalized(part))).length === 1);
        return [entity?.name, ...(entity?.aliases || []), ...uniqueParts];
    };
    const before = result.facts.length;
    result.facts = result.facts.filter(fact => {
        if (normalized(fact?.category) !== 'knowledge') return true;
        const topicText = cleanText(fact?.predicate).match(/^knowledge of\s+(.+)$/iu)?.[1];
        if (topicText && descriptivePersonIdentityContext(topicText, world)) return true;
        const topic = topicText ? (index.entities.find(entity => [entity?.name, ...(entity?.aliases || [])]
            .some(name => normalized(name) === normalized(topicText))) || canonicalMention(index, topicText)) : null;
        const holder = canonicalMention(index, fact?.subject);
        const value = cleanText(fact?.value);
        const explicitHolderKnowledge = personEntity(holder) && new RegExp(
            `^${escaped(holder.name)}\\s+(?:(?:now|still|already)\\s+)?(?:knows?|learns?|learned|has learned|recognizes?|recognized|remembers?|remembered|recalls?|recalled)\\b`, 'iu',
        ).test(value);
        const normalizedValue = normalized(value).replace(/\bmoonbase\b/gu, 'moon base');
        const nonPersonTopicLexeme = topic && !personEntity(topic)
            && [topic.name, ...(topic.aliases || [])].some(name => {
                const terms = normalized(name).replace(/\bmoonbase\b/gu, 'moon base').match(/[\p{L}\p{N}]{4,}/gu) || [];
                return terms.length >= 2 && terms.filter(term => normalizedValue.includes(term)).length >= 2;
            });
        if (explicitHolderKnowledge && (textMentionsIdentityVariant(value, [topic?.name, ...(topic?.aliases || [])])
            || nonPersonTopicLexeme)) return true;
        if (!topic || !value || textMentionsIdentityVariant(value, [topic.name, ...(topic.aliases || [])])) return true;
        const otherEntities = index.entities.filter(entity => normalized(entity?.name) !== normalized(holder?.name)
            && normalized(entity?.name) !== normalized(topic.name)
            && textMentionsIdentityVariant(value, mentionVariants(entity)));
        return otherEntities.length === 0;
    });
    return before - result.facts.length;
}

// Resolve unambiguous relational descriptions in knowledge predicates through
// the relationship ledger. This keeps “her former master” and the established
// canonical person in one record without mapping the possessive owner to the
// owned role.
export function normalizeRelationalKnowledgeTopics(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    const relationships = [...(result?.relationships || []), ...(world?.relationships || [])];
    let normalizedFacts = 0;
    for (const fact of result.facts) {
        if (fact?.correctionId || normalized(fact?.category) !== 'knowledge') continue;
        const match = cleanText(fact?.predicate).match(/^knowledge of\s+(?:(her|his|their)|(.+?)[’']s)\s+((?:former|previous|prior|dead|deceased|missing|unknown|unnamed|unidentified)?\s*(?:jedi\s+|sith\s+)?(?:master|mentor|teacher|captain|commander|leader|handler|apprentice|student|padawan|pupil|parent|mother|father|brother|sister))(?:[’']s\s+(?:true\s+|real\s+)?identity)?$/iu);
        if (!match) continue;
        const holder = canonicalMention(index, fact?.subject);
        const namedOwner = cleanText(match[2]);
        if (!personEntity(holder) || (namedOwner && normalized(namedOwner) !== normalized(holder.name))) continue;
        const roleWord = cleanText(match[3]).split(/\s+/u).at(-1);
        const candidates = relationships.flatMap(relationship => {
            const from = canonicalMention(index, relationship?.from);
            const to = canonicalMention(index, relationship?.to);
            if (!personEntity(from) || !personEntity(to)) return [];
            const other = normalized(from.name) === normalized(holder.name) ? to
                : normalized(to.name) === normalized(holder.name) ? from : null;
            // Match the declared relationship type, not incidental mentions of
            // somebody else's role inside the descriptive prose.
            if (!other || !new RegExp(`\\b${escaped(roleWord)}\\b`, 'iu').test(cleanText(relationship?.kind))) return [];
            return [other.name];
        });
        const unique = [...new Set(candidates.map(cleanText).filter(Boolean))];
        if (unique.length !== 1) continue;
        fact.predicate = `knowledge of ${unique[0]}`;
        if (Object.hasOwn(fact, 'targetId') && !fact._knowledgeTransition) fact.targetId = '';
        normalizedFacts++;
    }
    return normalizedFacts;
}

// Schema/taxonomy labels occasionally leak into a knowledge predicate after an
// em dash (for example “knowledge of Alice — IDENTITY_AND_HISTORY”). They do
// not identify a different topic and must not defeat boundary reconciliation.
export function normalizeKnowledgePredicateTaxonomy(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    let normalizedFacts = 0;
    for (const fact of result.facts) {
        if (!/^(?:knowledge|knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category))) continue;
        const match = cleanText(fact?.predicate).match(/^knowledge of\s+(.+?)\s+[—–-]\s+[A-Z][A-Z0-9_]{2,}$/u);
        if (!match) continue;
        const topicText = cleanText(match[1]);
        const mentioned = canonicalMention(index, topicText);
        const exactMention = mentioned && [mentioned.name, ...(mentioned.aliases || [])]
            .some(value => normalized(value) === normalized(topicText));
        const topic = exactMention ? mentioned.name : topicText;
        const canonical = `knowledge of ${topic}`;
        if (cleanText(fact.predicate) === canonical) continue;
        fact.predicate = canonical;
        if (Object.hasOwn(fact, 'targetId')) fact.targetId = '';
        normalizedFacts++;
    }
    return normalizedFacts;
}

// Prefer an explicit knowledge boundary over a vague same-range summary that
// conflates working for a governing body with membership in it. Preserve the
// remainder of a compound summary instead of dropping the whole record.
export function sanitizeKnowledgeMembershipOverclaims(result, world = null) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    const groups = new Map();
    for (const fact of result.facts) {
        if (!/^knowledge of\s+\S/iu.test(cleanText(fact?.predicate))) continue;
        const topicText = cleanText(fact.predicate).replace(/^knowledge of\s+/iu, '');
        const topic = canonicalMention(index, topicText)?.name || topicText;
        const identity = `${normalized(fact?.subject)}|${normalized(topic)}`;
        const group = groups.get(identity) || { facts: [], topic };
        const values = group.facts;
        values.push(fact);
        groups.set(identity, group);
    }
    let repaired = 0;
    const bodies = '(?:high\\s+)?(?:council|board|committee|cabinet|senate|parliament|court)';
    for (const { facts, topic } of groups.values()) {
        const explicitBoundaries = facts.filter(fact => /^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category)));
        const uncertainMembership = facts.filter(fact => normalized(fact?.category) === 'knowledge'
            && (new RegExp(`\\b(?:possible|possibly|may|might|alleged|claimed|unconfirmed)[^.;]{0,80}\\b${bodies}\\b`, 'iu').test(cleanText(fact?.value))
                || new RegExp(`\\b${bodies}\\b[^.;]{0,80}\\b(?:possible|possibly|may|might|alleged|claimed|unconfirmed)\\b`, 'iu').test(cleanText(fact?.value))));
        const constraints = [...explicitBoundaries, ...uncertainMembership];
        const positives = facts.filter(fact => normalized(fact?.category) === 'knowledge' && !uncertainMembership.includes(fact));
        if (!constraints.length || !positives.length) continue;
        const boundaryText = constraints.map(fact => cleanText(fact?.value)).join(' ');
        const explicitMembershipGap = new RegExp(`\\b(?:did not know|didn't know|was not told|wasn't told|unaware)[^.;]{0,140}\\b(?:in|on|member(?:ship)?|seat|served)[^.;]{0,60}\\b${bodies}\\b`, 'iu').test(boundaryText);
        const uncertainMembershipGap = uncertainMembership.length > 0;
        if (!explicitMembershipGap && !uncertainMembershipGap) continue;
        for (const fact of positives) {
            const before = cleanText(fact.value);
            let after = before
                .replace(new RegExp(`\\b(?:the\\s+)?${bodies}\\s*(?:(?:and|&)\\s+|,\\s*)`, 'giu'), '')
                .replace(new RegExp(`\\b(?:an?\\s+)?(?:former\\s+)?${bodies}\\s+member(?:ship)?\\b(?:\\s*,?\\s*(?:and|&)\\s*)?`, 'giu'), '')
                .replace(new RegExp(`\\b(?:his|her|their|the)\\s+${bodies}\\s+(?:membership|seat|service|history)\\b(?:\\s*,?\\s*(?:and|&)\\s*)?`, 'giu'), '');
            after = cleanText(after).replace(/\s+([,.;])/gu, '$1');
            if (!after || after === before) continue;
            fact.value = after;
            repaired++;
        }
        for (const resolution of result.identityResolutions || []) {
            if (normalized(resolution?.canonical) !== normalized(topic)) continue;
            const before = cleanText(resolution.evidence);
            const after = cleanText(before.replace(
                new RegExp(`\\b(?:an?\\s+)?(?:former\\s+)?${bodies}\\s+member(?:ship)?\\b(?:\\s*,?\\s*(?:and|&)\\s*)?`, 'giu'),
                '',
            )).replace(/\s+([,.;])/gu, '$1');
            if (!after || after === before) continue;
            resolution.evidence = after;
            repaired++;
        }
    }
    return repaired;
}

// Repair the narrow reversed extraction “A — knowledge of B: A identifies
// herself as A.” That sentence records B learning A's stated identity.
export function repairReversedSelfIdentificationKnowledge(result, world) {
    if (!Array.isArray(result?.facts)) return 0;
    const index = continuityEntityIndex(result, world);
    let repaired = 0;
    for (const fact of result.facts) {
        if (normalized(fact?.category) !== 'knowledge'
            || !/^knowledge of\s+\S/iu.test(cleanText(fact?.predicate))) continue;
        const holder = canonicalMention(index, fact?.subject);
        const topicText = cleanText(fact.predicate).replace(/^knowledge of\s+/iu, '');
        const topic = canonicalMention(index, topicText);
        if (!personEntity(holder) || !personEntity(topic)
            || normalized(holder.name) === normalized(topic.name)) continue;
        const reflexive = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(holder.name)}\\s+(?:identifies?|identified|introduces?|introduced|names?|named)\\s+(?:himself|herself|themself|themselves)\\s+as\\b`, 'iu');
        const value = cleanText(fact?.value);
        if (!reflexive.test(value)) continue;
        fact.subject = topic.name;
        fact.predicate = `knowledge of ${holder.name}`;
        fact.value = `${topic.name} learns ${holder.name}’s stated identity: ${value}`;
        fact.targetId = '';
        repaired++;
    }
    return repaired;
}

function auditEvidenceThreshold(value) {
    return Math.max(4, Math.min(9, Math.ceil(coverageTerms(value).size * 0.42)));
}

function sourceEvidenceParts(message) {
    const source = String(message?.text ?? message?.mes ?? '').replace(/\r/g, ' ');
    const userAuthored = message?.isUser === true || message?.is_user === true;
    const chunks = source.split(/\n+|(?<=[.!?])\s+(?=[\p{L}\p{N}“"'*_<])/u)
        .map(cleanText).filter(value => value && !/^<\/?[^>]+>$/u.test(value) && value !== '```');
    const subjective = [];
    const objective = [];
    for (const chunk of chunks) {
        if (userAuthored && AUDIT_SOURCE_AUTHORITATIVE.test(chunk)) objective.push(chunk);
        else if (AUDIT_SOURCE_SUBJECTIVE.test(chunk) || /^\*[^*]+\*$/u.test(chunk)) subjective.push(chunk);
        else objective.push(chunk);
    }
    return { subjective, objective };
}

function characterProfileObjectiveParts(message) {
    const source = stripGeneratedProfileControlBlocks(String(message?.text ?? message?.mes ?? '')).replace(/\r/g, ' ');
    const userAuthored = message?.isUser === true || message?.is_user === true;
    return source.split(/\n+|(?<=[.!?])\s+(?=[\p{L}\p{N}“"'*_<])/u)
        .map(cleanText)
        .map(chunk => {
            if (!chunk || /^<\/?[^>]+>$/u.test(chunk) || chunk === '```' || looksLikeStructuredProfilePanel(chunk)) return '';
            if ((userAuthored && AUDIT_SOURCE_AUTHORITATIVE.test(chunk)) || !AUDIT_SOURCE_SUBJECTIVE.test(chunk)) return chunk;
            // Quoted claims cannot establish appearance or personality. Keep
            // only a bare proper-name self-introduction as a discourse anchor
            // so immediately preceding objective narration can be attributed
            // without treating anything else the speaker says as canon.
            const introduction = chunk.match(/\b(?:I\s+am|I['’]m|my\s+name\s+is)\s+[\p{Lu}][\p{L}\p{N}'’-]*(?:\s+[\p{Lu}][\p{L}\p{N}'’-]*){0,3}\b/u);
            return introduction?.[0] || '';
        })
        .map(chunk => cleanText(chunk.replace(/^\*+|\*+$/gu, '')))
        .filter(Boolean);
}

const PROFILE_PANEL_NAME = /(?:^|[-_ ])(?:character|current|scene|world)?[-_ ]*(?:dashboard|hud|metadata|panel|profile|sheet|stat(?:e|s|us)?|status|tracker)(?:$|[-_ ])/iu;
const PROFILE_PANEL_HEADING = /^\s*(?:#{1,6}\s*)?(?:character\s+|current\s+|scene\s+|world\s+)?(?:dashboard|hud|metadata|panel|profile|sheet|stats?|state|status|tracker)\b/iu;
const PROFILE_PANEL_KEY_VALUE = /^\s*(?:[-*+]\s*)?(?:["']?)[\p{L}\p{N}_][\p{L}\p{N}_ &'’/().-]{0,48}(?:["']?)\s*(?::|=|=>|->)\s*\S/iu;

function looksLikeStructuredProfilePanel(value) {
    const source = String(value ?? '').trim();
    if (!source) return false;
    if (PROFILE_PANEL_HEADING.test(source)) return true;
    if ((source.match(/\|/gu) || []).length >= 2 || (source.match(/(?:^|\s)[\p{L}\p{N}_][\p{L}\p{N}_ &'’/().-]{0,32}\s*=\s*/gu) || []).length >= 1) return true;
    if ((source.match(/["'][^"'\n]{1,48}["']\s*:/gu) || []).length >= 2) return true;
    if (/^\s*\|.*\|\s*$/u.test(source) || /^\s*[{}[\]]/u.test(source) && /[":]/u.test(source)) return true;
    return PROFILE_PANEL_KEY_VALUE.test(source);
}

function structuredPanelBody(value) {
    const lines = String(value ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return false;
    const structured = lines.filter(line => looksLikeStructuredProfilePanel(line)).length;
    const markdownTable = lines.some(line => /^\|?(?:\s*:?-{3,}:?\s*\|){1,}/u.test(line));
    return markdownTable || structured >= 2 || (lines.length <= 3 && structured === lines.length);
}

function stripGeneratedProfileControlBlocks(value) {
    let source = String(value ?? '');
    // Profiles never use fenced material as evidence. This covers named and
    // unnamed JSON, YAML, TOML, INI, Markdown, and custom stat-box formats.
    source = source.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, ' ');
    source = source.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/giu, ' ');
    const taggedPanel = /<([a-z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/giu;
    const bracketedPanel = /\[([a-z][\w -]*)[^\]]*\]([\s\S]*?)\[\/\1\]/giu;
    for (let pass = 0; pass < 3; pass++) {
        source = source.replace(taggedPanel, (whole, tag, body) => (
            PROFILE_PANEL_NAME.test(String(tag).replace(/:/gu, '-')) || structuredPanelBody(body) ? ' ' : whole
        ));
        source = source.replace(bracketedPanel, (whole, tag, body) => (
            PROFILE_PANEL_NAME.test(tag) || structuredPanelBody(body) ? ' ' : whole
        ));
    }
    // Also handle unclosed conventional panels and untagged key-value/table
    // runs. A single ordinary speaker label is retained; two structured rows
    // establish that this is a panel rather than narrative prose.
    source = source.replace(/<(?:background[-_ ]?updates?|character[-_ ]?(?:sheet|status)|dashboard|hud|metadata|panel|stats?|status|tracker|world[-_ ]?state)\b[^>]*>[\s\S]*$/giu, ' ');
    const lines = source.split(/\r?\n/u);
    const kept = [];
    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (PROFILE_PANEL_HEADING.test(line)) {
            index++;
            while (index < lines.length && (looksLikeStructuredProfilePanel(lines[index]) || /^\s*(?:[-*+]\s+|[{}[\],]+\s*$)/u.test(lines[index]))) index++;
            continue;
        }
        let end = index;
        while (end < lines.length && looksLikeStructuredProfilePanel(lines[end])) end++;
        if (end - index >= 2 || (end - index === 1 && ((line.match(/\|/gu) || []).length >= 2 || /[{}[\]]/u.test(line)))) {
            index = end;
            continue;
        }
        kept.push(line);
        index++;
    }
    return kept.join('\n');
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

function characterProfileKey(label) {
    const value = normalized(label).replace(/\s+/gu, '');
    if (value === 'role/background') return 'roleBackground';
    if (value === 'age/demographics') return 'ageDemographics';
    if (value === 'appearance') return 'appearance';
    if (value === 'personality/quirks') return 'personalityQuirks';
    return '';
}

function parseCharacterProfile(value) {
    const source = cleanText(value);
    const matches = [...source.matchAll(CHARACTER_PROFILE_SECTION)];
    if (!matches.length) return null;
    const profile = {};
    for (let index = 0; index < matches.length; index++) {
        const key = characterProfileKey(matches[index][1]);
        if (!key) continue;
        const start = Number(matches[index].index) + matches[index][0].length;
        const end = index + 1 < matches.length ? Number(matches[index + 1].index) : source.length;
        const detail = cleanText(source.slice(start, end)).replace(/^[;,.\s]+|[;,.\s]+$/gu, '');
        if (detail) profile[key] = detail;
    }
    return Object.keys(profile).length ? profile : null;
}

function suppliedCharacterProfile(entity) {
    const profile = entity?.characterProfile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
    const supplied = {
        roleBackground: characterProfileDetails(profile.roleBackground),
        ageDemographics: characterProfileDetails(profile.ageDemographics),
        appearance: characterProfileDetails(profile.appearance),
        personalityQuirks: characterProfileDetails(profile.personalityQuirks),
    };
    return CHARACTER_PROFILE_ORDER.some(key => supplied[key].length) ? supplied : null;
}

function formatCharacterProfile(profile) {
    const sections = CHARACTER_PROFILE_ORDER
        .filter(key => cleanText(profile?.[key]))
        .map(key => `${CHARACTER_PROFILE_LABEL[key]}: ${cleanText(profile[key]).replace(/[;,.\s]+$/gu, '')}`);
    return sections.length ? `${sections.join('; ')}.` : '';
}

function characterProfileDetails(value) {
    if (Array.isArray(value)) return value.flatMap(characterProfileDetails);
    return cleanText(value).replace(/[.]+$/gu, '')
        .split(/\s*(?:,|;|\b(?:and|but)\b)\s*/iu)
        .map(cleanText).filter(Boolean);
}

function characterProfileTerms(value, entity) {
    const excluded = new Set([
        ...CHARACTER_PROFILE_GENERIC_TERMS,
        ...coverageTerms(cleanText(entity?.name)),
        ...(entity?.aliases || []).flatMap(alias => [...coverageTerms(alias)]),
    ]);
    return [...coverageTerms(value)].filter(term => !excluded.has(term));
}

function characterProfileSupportCount(terms, evidence) {
    const available = coverageTerms(evidence);
    return terms.filter(term => available.has(term)).length;
}

function characterProfileSubjectPattern(entity) {
    const variants = [entity?.name, ...(entity?.aliases || [])].map(cleanText).filter(Boolean);
    if (!variants.length) return null;
    const identity = variants.sort((left, right) => right.length - left.length).map(escaped).join('|');
    // Profile evidence must make the named entity the grammatical topic. A
    // bare nearby mention is not enough: "Toska studies Lucas" is evidence
    // about Toska's action, not Lucas's body, history, or temperament.
    const intrinsicPossessive = '(?:age|appearance|background|beard|build|complexion|eyes?|face|hair|habits?|height|history|markings?|personality|quirks?|role|scars?|skin|stammer|stature|stutter|temperament|voice)';
    return new RegExp(
        `^(?:[\\s*“”"'‘’([{]*)(?:(?:OOC\\s*:\\s*)|(?:[^,]{1,80},\\s+))?(?:${identity})(?:[’']s\\s+${intrinsicPossessive}\\b|\\b(?![’']))`,
        'iu',
    );
}

function characterProfileHasExplicitSubject(segment, entity) {
    const source = cleanText(segment);
    if (characterProfileSubjectPattern(entity)?.test(source)) return true;
    const variants = [entity?.name, ...(entity?.aliases || [])].map(cleanText).filter(Boolean);
    for (const variant of variants) {
        const identity = escaped(variant);
        // Appositive subjects such as "The court mage Aria" are common in
        // introductions. A preposition before the name marks it as contextual
        // instead ("the guard beside Aria") and must not claim the sentence.
        const appositive = source.match(new RegExp(`^(?:[\\s*“”"'‘’([{]*)(?:a|an|the)\\s+([^,.]{1,70}?)\\s+${identity}\\b`, 'iu'));
        if (appositive && !/\b(?:against|around|before|behind|beside|by|for|from|near|of|over|to|under|with)\b/iu.test(appositive[1])) return true;
        // Handle a narrow, unambiguous inverted construction without treating
        // every name before a verb as its grammatical subject.
        if (new RegExp(`^(?:[\\s*“”"'‘’([{]*)(?:across from|behind|beside|near)\\b[^.!?]{0,80}\\b(?:sat|stood|waited)\\s+${identity}\\b`, 'iu').test(source)) return true;
    }
    return false;
}

function partialCompoundThreadResolution(thread, evidence) {
    const originalTitle = cleanText(thread?.title);
    const parts = originalTitle.split(/\s+and\s+/iu).map(cleanText).filter(Boolean);
    if (parts.length !== 2) return null;
    const evidenceTerms = threadTerms(evidence);
    const scored = parts.map(part => {
        const terms = threadTerms(part);
        const required = terms.size <= 2 ? 1 : 2;
        return { part, score: termSetOverlap(terms, evidenceTerms), required };
    });
    const matched = scored.filter(item => item.score >= item.required);
    const unmatched = scored.filter(item => item.score < item.required);
    if (matched.length !== 1 || unmatched.length !== 1) return null;
    const action = originalTitle.match(/^(?:Determine|Verify|Explain|Identify|Answer|Confirm|Establish|Resolve)\b/iu)?.[0] || 'Resolve';
    const atomicTitle = part => new RegExp(`^${escaped(action)}\\b`, 'iu').test(part) ? part : `${action} ${part}`;
    return {
        resolvedTitle: atomicTitle(matched[0].part),
        unresolvedTitle: atomicTitle(unmatched[0].part),
    };
}

function splitPartiallyResolvedCompoundThread(result, stored, incoming, evidence) {
    if (!stored || normalized(stored?.status) !== 'open' || normalized(incoming?.status) !== 'resolved') return false;
    const split = partialCompoundThreadResolution(stored, evidence);
    if (!split) return false;
    incoming.targetId = cleanText(stored.id);
    incoming.title = split.resolvedTitle;
    incoming.detail = `Resolved as to ${split.resolvedTitle.replace(/^[\p{L}-]+\s+/u, '')}: ${cleanText(evidence)}`;
    incoming.status = 'resolved';
    incoming.participants = stored.participants || incoming.participants || [];
    incoming.importance = stored.importance || incoming.importance || 3;
    ATOMIC_THREAD_SPLITS.add(incoming);
    const duplicate = (result?.threads || []).some(candidate => candidate !== incoming
        && normalized(candidate?.status) === 'open'
        && normalized(candidate?.title) === normalized(split.unresolvedTitle));
    if (!duplicate) result.threads.push({
        targetId: '',
        title: split.unresolvedTitle,
        detail: `${split.unresolvedTitle.replace(/^[\p{L}-]+\s+/u, '')} remains unresolved after the other compound claim was established.`,
        status: 'open',
        participants: stored.participants || incoming.participants || [],
        importance: stored.importance || incoming.importance || 3,
    });
    return true;
}

const ATOMIC_THREAD_SPLITS = new WeakSet();

export function reconciliationThreadWasAtomicallySplit(item) {
    return Boolean(item && typeof item === 'object' && ATOMIC_THREAD_SPLITS.has(item));
}

export function splitResolvedCompoundThreads(result, world) {
    if (!Array.isArray(result?.threads) || !Array.isArray(world?.threads)) return 0;
    let split = 0;
    for (const incoming of [...result.threads]) {
        if (normalized(incoming?.status) !== 'resolved') continue;
        const stored = storedOpenThreadFor(result, world, incoming);
        const evidence = cleanText(incoming?.detail).replace(/^Resolved(?:(?: by| through)[^:]*)?:\s*/iu, '');
        if (splitPartiallyResolvedCompoundThread(result, stored, incoming, evidence)) split++;
    }
    return split;
}

function characterProfilePronounLed(segment) {
    return /^(?:[\s*“”"'‘’([{]*)(?:he|she|they|his|her|their)\b/iu.test(cleanText(segment));
}

function characterProfileEvidenceWindows(entity, objectiveSequences, people) {
    const variants = [entity?.name, ...(entity?.aliases || [])].map(cleanText).filter(Boolean);
    const otherPeople = people.filter(person => normalized(person?.name) !== normalized(entity?.name));
    const windows = [];
    for (const segments of objectiveSequences) {
        let activeSubject = '';
        for (let index = 0; index < segments.length; index++) {
            // A self-introduction can explicitly resolve immediately preceding
            // pronoun-led description to the named speaker. Walk backward only
            // through unnamed clauses and stop at any other known person, so a
            // nearby character's appearance cannot bleed into this profile.
            const selfIntroduction = variants.some(variant => new RegExp(
                `\\b(?:I\\s+am|I['’]m|my\\s+name\\s+is)\\s+${escaped(variant)}\\b`, 'iu',
            ).test(segments[index]));
            if (selfIntroduction) {
                activeSubject = normalized(entity?.name);
                let start = index;
                for (let prior = index - 1; prior >= 0 && prior >= index - 3; prior--) {
                    // An object mention such as "nearly hit the seneschal"
                    // does not transfer ownership. Stop only when another
                    // known person is the grammatical subject.
                    if (otherPeople.some(person => characterProfileHasExplicitSubject(segments[prior], person))) break;
                    start = prior;
                    windows.push(segments.slice(start, index + 1).join(' '));
                }
            }
            const explicitSubjects = [...new Set(people
                .filter(person => characterProfileHasExplicitSubject(segments[index], person))
                .map(person => normalized(person?.name)).filter(Boolean))];
            if (explicitSubjects.length === 1) {
                activeSubject = explicitSubjects[0];
                if (activeSubject === normalized(entity?.name)) windows.push(segments[index]);
                continue;
            }
            if (explicitSubjects.length > 1) {
                activeSubject = '';
                continue;
            }
            // A leading pronoun continues only the immediately active named
            // subject. An intervening environment or abstract-subject sentence
            // clears the anchor instead of reaching backward speculatively.
            if (activeSubject && characterProfilePronounLed(segments[index])) {
                if (activeSubject === normalized(entity?.name)) windows.push(segments[index]);
            } else if (!selfIntroduction) {
                activeSubject = '';
            }
        }
    }
    return windows;
}

function characterProfileDetailSupported(detail, entity, existing, objectiveWindows) {
    const terms = characterProfileTerms(detail, entity);
    if (!terms.length) return false;
    // Require every meaningful term. The extraction prompt asks the model to
    // retain source wording, so semantic paraphrase must not become a loophole
    // through which one unsupported adjective can ride beside valid details.
    const threshold = terms.length;
    // A legacy free-form biography may seed its one-time typed conversion. A
    // typed profile must never validate new proposals through its own rendered
    // description, because that would make earlier contamination self-proving.
    if (existing && !Object.keys(storedEntityProfile(existing)).length
        && characterProfileSupportCount(terms, cleanText(existing?.description)) >= threshold) return true;
    return objectiveWindows.some(window => characterProfileSupportCount(terms, window) >= threshold);
}

function mergeCharacterProfileDetails(priorValue, incomingDetails) {
    const merged = characterProfileDetails(priorValue);
    for (const detail of incomingDetails) {
        const terms = coverageTerms(detail);
        const duplicate = merged.some(existing => {
            const required = Math.max(1, Math.min(terms.size, Math.ceil(terms.size * 0.75)));
            return coverageOverlap(detail, existing) >= required;
        });
        if (!duplicate) merged.push(detail);
    }
    return merged.join(', ');
}

function characterProfileNeedsVersionAudit(existing, world) {
    const entityVersion = Number(existing?.profileValidationVersion || 0);
    if (entityVersion) return entityVersion !== EXTRACTION_VERSION;
    const processedVersions = Object.values(world?.sources || {})
        .flatMap(source => source?.processedMessages || [])
        .map(item => Number(item?.version || 0)).filter(Boolean);
    // Imported or hand-authored memory without extraction provenance remains
    // accepted memory. A locally extracted older profile is re-grounded once.
    return processedVersions.length > 0 && processedVersions.some(version => version !== EXTRACTION_VERSION);
}

function relationshipEndpointVariants(value) {
    const source = cleanText(value);
    if (!source) return [];
    const variants = [source];
    const possessed = source.match(/^[^’']{1,80}[’']s\s+(.+)$/u);
    if (possessed) variants.push(cleanText(possessed[1]));
    return [...new Set(variants.map(cleanText).filter(Boolean))];
}

function relationshipEndpointAlternation(value) {
    return relationshipEndpointVariants(value).sort((left, right) => right.length - left.length).map(escaped).join('|');
}

function qualifiedRelationshipRoleEvidence(entityName, relationship) {
    const name = cleanText(entityName);
    const other = normalized(relationship?.from) === normalized(name)
        ? cleanText(relationship?.to) : cleanText(relationship?.from);
    if (!name || !other) return { roles: [], family: '', nameIsSenior: false, nameIsJunior: false };
    const dynamic = cleanText(relationship?.dynamic).replace(/^Relationship between [^:]{2,180}:\s*/iu, '');
    const kind = cleanText(relationship?.kind);
    const relationText = `${kind} ${dynamic}`;
    const namePattern = relationshipEndpointAlternation(name);
    const otherPattern = relationshipEndpointAlternation(other);
    if (!namePattern || !otherPattern) return { roles: [], family: '', nameIsSenior: false, nameIsJunior: false };
    const namedSubject = pattern => `(?:^|[^\\p{L}\\p{N}])(?:the\\s+)?(?:${pattern})(?![’'])`;
    const namedObject = pattern => `(?:the\\s+)?(?:${pattern})(?:$|[^\\p{L}\\p{N}])`;
    const seniorRole = '(?:Jedi\\s+|Sith\\s+)?(?:master|mentor|teacher)';
    const juniorRole = '(?:Jedi\\s+|Sith\\s+)?(?:apprentice|student|pupil|Padawan)';
    const nameActsOnOther = new RegExp(`${namedSubject(namePattern)}\\s+(?:commands?|trained|trains?|taught|teaches?|mentored|mentors?)\\s+${namedObject(otherPattern)}`, 'iu').test(dynamic);
    const otherActsOnName = new RegExp(`${namedSubject(otherPattern)}\\s+(?:commands?|trained|trains?|taught|teaches?|mentored|mentors?)\\s+${namedObject(namePattern)}`, 'iu').test(dynamic);
    const nameHasSeniorRole = new RegExp(`${namedSubject(namePattern)}\\s+(?:is|was|remains?|became|served as)\\s+(?:${namedObject(otherPattern)}[’']s\\s+)?(?:former\\s+)?${seniorRole}\\b`, 'iu').test(dynamic);
    const nameHasJuniorRole = new RegExp(`${namedSubject(namePattern)}\\s+(?:is|was|remains?|became|served as)\\s+(?:(?:${otherPattern})[’']s\\s+|(?:his|her|their)\\s+)?(?:former\\s+)?${juniorRole}\\b`, 'iu').test(dynamic);
    const otherIsNamesJunior = new RegExp(`${namedSubject(otherPattern)}\\s+(?:is|was|remains?|became)\\s+(?:(?:${namePattern})[’']s\\s+|(?:his|her|their)\\s+)(?:former\\s+)?${juniorRole}\\b`, 'iu').test(dynamic);
    const nameIsOthersJunior = new RegExp(`${namedSubject(namePattern)}\\s+(?:is|was|remains?|became)\\s+(?:(?:${otherPattern})[’']s\\s+|(?:his|her|their)\\s+)(?:former\\s+)?${juniorRole}\\b`, 'iu').test(dynamic);
    const trainedNameAsJunior = new RegExp(`\\b(?:trained|trains?|taught|teaches?|mentored|mentors?)\\s+${namedObject(namePattern)}\\s+(?:as\\s+)?(?:an?\\s+)?${juniorRole}\\b`, 'iu').test(dynamic);
    const trainedOtherAsJunior = new RegExp(`\\b(?:trained|trains?|taught|teaches?|mentored|mentors?)\\s+${namedObject(otherPattern)}\\s+(?:as\\s+)?(?:an?\\s+)?${juniorRole}\\b`, 'iu').test(dynamic);
    const nameIsJunior = nameHasJuniorRole || nameIsOthersJunior || otherActsOnName || trainedNameAsJunior;
    const nameIsSenior = nameHasSeniorRole || nameActsOnOther || otherIsNamesJunior || trainedOtherAsJunior;
    const jediFamily = (/\bJedi\b/iu.test(kind) && /\bmaster\b/iu.test(kind)
        && /\b(?:apprentice|student|pupil|Padawan)\b/iu.test(kind))
        || /\bJedi\s+(?:Master|Padawan|apprentice)\b/iu.test(dynamic);
    const sithFamily = (/\bSith\b/iu.test(kind) && /\bmaster\b/iu.test(kind) && /\bapprentice\b/iu.test(kind))
        || /\bSith\s+(?:Master|apprentice)\b/iu.test(dynamic);
    const family = jediFamily ? 'Jedi' : sithFamily ? 'Sith' : '';
    const roles = [];
    if (family === 'Jedi') {
        if (nameIsJunior && /\bPadawan\b/iu.test(relationText)) roles.push('Jedi Padawan');
        else if (nameIsSenior) roles.push('Jedi Master');
    } else if (family === 'Sith') {
        if (nameIsJunior) roles.push('Sith apprentice');
        else if (nameIsSenior) roles.push('Sith Master');
    }
    return { roles, family, nameIsSenior, nameIsJunior };
}

function canonicalRecordProfileRoles(entity, result, world, messages) {
    const roles = [];
    const add = value => {
        const role = cleanText(value)
            .split(/\b(?:although|as far as|because|even though|though|unless|until|whereas|while)\b/iu)[0]
            .replace(/^(?:a|an|the)\s+/iu, '').replace(/[;,.:\s]+$/gu, '');
        if (role && durableCharacterProfileDetail('roleBackground', role)
            && !roles.some(existing => normalized(existing) === normalized(role))) roles.push(role);
    };
    const name = cleanText(entity?.name);
    const relationships = [
        ...(world?.relationships || []).map(record => ({ record, stored: true })),
        ...(result?.relationships || []).map(record => ({ record, stored: false })),
    ].filter(({ record }) => [record?.from, record?.to].some(endpoint => normalized(endpoint) === normalized(name)));
    const isJediContext = relationships.some(({ record }) => qualifiedRelationshipRoleEvidence(name, record).family === 'Jedi');
    for (const { record: relationship, stored } of relationships) {
        const dynamic = cleanText(relationship?.dynamic);
        const other = normalized(relationship?.from) === normalized(name) ? relationship?.to : relationship?.from;
        if (!dynamic || !other) continue;
        if (!stored && sourceOnlySubjective(`${relationship?.from} ${relationship?.to} ${relationship?.kind} ${dynamic}`, messages)) continue;
        const escapedName = escaped(name);
        for (const match of dynamic.matchAll(new RegExp(`${escapedName}(?![’'])\\s+(?:is|was|served as|works as|became)\\s+([^.!?;]{2,100})`, 'giu'))) {
            for (const detail of characterProfileDetails(match[1])) add(detail);
        }
        for (const role of qualifiedRelationshipRoleEvidence(name, relationship).roles) add(role);
    }
    const facts = [
        ...(world?.facts || []).map(record => ({ record, stored: true })),
        ...(result?.facts || []).map(record => ({ record, stored: false })),
    ];
    for (const { record: fact, stored } of facts) {
        const factTaxonomy = `${cleanText(fact?.category)} ${cleanText(fact?.predicate)}`;
        if (normalized(canonicalMemorySubject({ ...(world || {}), entities: [...(world?.entities || []), ...(result?.entities || [])] }, fact?.subject)) !== normalized(name)
            // The subject of an epistemic fact is its holder. A role named in
            // what they know or believe belongs to the topic, not the holder.
            || /(?:^|\b)(?:belief|claim|knowledge|perspective|rumou?r|speculation)(?:\b|$)/iu.test(factTaxonomy)
            || normalized(fact?.persistence) === 'temporary') continue;
        const evidence = `${cleanText(fact?.predicate)}. ${cleanText(fact?.value)}`;
        if (!stored && sourceOnlySubjective(`${name} ${evidence}`, messages)) continue;
        if (/\b(?:held|had|occupied|served on)\b[^.!?]{0,60}\bCouncil\s+seat\b/iu.test(evidence)
            || /\bformer\b[^.!?]{0,40}\bCouncil\s+member\b/iu.test(evidence)) {
            add(isJediContext ? 'former Jedi Council member' : 'former Council member');
        }
        for (const match of cleanText(fact?.value).matchAll(new RegExp(`${escaped(name)}\\s+(?:is|was|served as|works as|became)\\s+([^.!?;]{2,100})`, 'giu'))) {
            for (const detail of characterProfileDetails(match[1])) add(detail);
        }
    }
    return roles;
}

function sourceDerivedCharacterProfile(entity, objectiveWindows, messages, result, world) {
    const derived = { roleBackground: [], ageDemographics: [], appearance: [], personalityQuirks: [] };
    const add = (field, detail) => {
        const value = cleanText(detail)
            .replace(field === 'roleBackground' ? /^(?:a|an|the|my|his|her|their|our|your)\s+/iu : /^(?:a|an|the)\s+/iu, '')
            .replace(/[;,.:\s]+$/gu, '');
        if (!value || !durableCharacterProfileDetail(field, value, objectiveWindows)) return;
        if (!derived[field].some(existing => normalized(existing) === normalized(value))) derived[field].push(value);
    };
    const grammaticalSubject = [...new Set([entity?.name, ...(entity?.aliases || [])].map(cleanText).filter(Boolean))]
        .map(escaped).join('|');
    const copula = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${grammaticalSubject}|he|she|they)\\s+(?:is|was|appears?|seems?)\\s+([^.!?]{2,180})`, 'giu');
    const appearanceCue = /\b(?:bald|beard|build|cheek(?:ed|s)?|complexion|ear[sd]?|eye[sd]?|face|facial|freckle[sd]?|hair|height|horn[sd]?|markings?|moustache|mustache|scar(?:red|s)?|short|skin|stature|tall|tattoo(?:ed|s)?|voice|wing[sd]?|blood|bruise|dust|grime|injur|mud|tear|wound)\b/iu;
    const ageCue = /\b(?:age[ds]?|adolescen(?:ce|t|ts)|adult|child(?:hood|ren)?|elder(?:ly)?|infants?|middle[- ]aged|minors?|newborns?|preteens?|teen(?:age[drs]?|s)?|toddlers?|young(?:er|est)?|years?[- ]old|year[- ]old|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b|\b(?:at most|about|around|approximately|nearly|only|roughly|under|over)\s+(?:\d{1,3}|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b|\b(?:\d{1,3}|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\s+(?:at most|years? old)\b|^(?:0|[1-9]\d?|1[0-4]\d|150)$/iu;
    const roleCue = /\b(?:acolyte|adviser|advisor|agent|apprentice|attendant|captain|commander|council|doctor|emperor|empress|guard|heir|investigator|Jedi|king|knight|leader|lieutenant|mage|master|member|mentor|minister|mistress|officer|Padawan|pilot|prince|princess|queen|seneschal|Sith|soldier|student|teacher|veteran)\b/iu;
    const worldviewCue = /\b(?:adherent|belie(?:f|fs|ve[sd]?)|believer|creed|devout|ideology|principle|worldview)\b/iu;
    const behaviorCue = /\b(?:always|characteristically|habit(?:ual|ually)?|often|quirk|regularly|repeatedly|stammer|stumble|stutter|temper(?:ament|ed)?|typically|usually)\b|\bby nature\b/iu;
    const addObserved = detail => {
        const value = cleanText(detail);
        if (/^(?:a|an|the)\s+/iu.test(value) || roleCue.test(value)) add('roleBackground', value);
        else if (ageCue.test(value)) add('ageDemographics', value);
        else if (worldviewCue.test(value) || behaviorCue.test(value)) add('personalityQuirks', value.replace(/\s+by nature$/iu, ''));
        else if (appearanceCue.test(value)) add('appearance', value);
    };
    for (const window of objectiveWindows) {
        for (const match of window.matchAll(copula)) {
            for (const detail of characterProfileDetails(match[1])) addObserved(detail);
        }
    }
    const variants = [entity?.name, ...(entity?.aliases || [])].map(cleanText).filter(Boolean);
    const variantPattern = variants.map(escaped).join('|');
    for (const message of messages || []) {
        const source = cleanText(message?.text ?? message?.mes);
        if (!source || !variantPattern || !textMentionsIdentityVariant(source, variants)) continue;
        const ownedClauses = source.split(/\n+|(?<=[.!?])\s+/u)
            .map(cleanText)
            .filter(clause => characterProfileHasExplicitSubject(clause.replace(/^OOC\s*:\s*/iu, ''), entity));
        for (const clause of ownedClauses) {
            if (/\b(?:has\s+(?:a\s+)?s(?:tutter|utter)|stutters?|stammers?)\b/iu.test(clause)) add('personalityQuirks', 'stutters');
            if (/\b(?:stumbles?|trips?)\s+(?:randomly|often|frequently|habitually)\b|\b(?:randomly|often|frequently|habitually)\s+(?:stumbles?|trips?)\b/iu.test(clause)) {
                add('personalityQuirks', 'habitually stumbles');
            }
        }
        // A named self-introduction inside visibly stuttered dialogue is
        // direct, owner-bound evidence. Dialogue remains invalid evidence for
        // unrelated appearance or personality proposals.
        const selfIntroduction = new RegExp(`\\b(?:I\\s+am|I['’]m|my\\s+name\\s+is)\\s+(?:${variantPattern})\\b`, 'iu');
        if (selfIntroduction.test(source)
            && (source.match(/(?:^|[\s“"'‘’])([\p{L}])-\1[\p{L}]+/giu) || []).length >= 2) {
            add('personalityQuirks', 'stutters');
        }
    }
    for (const role of canonicalRecordProfileRoles(entity, result, world, messages)) add('roleBackground', role);
    return derived;
}

// A structured profile is useful only if each part is grounded. Validate its
// comma/conjunction-sized details independently so one supported trait cannot
// carry an invented neighboring trait into durable memory. Prior stored details
// are valid evidence and are retained when a later chunk omits them.
export function sanitizeStructuredCharacterProfiles(result, world, messages) {
    if (!Array.isArray(messages) || !messages.length || !Array.isArray(result?.entities)) {
        return { discarded: 0, warnings: [] };
    }
    const objectiveSequences = [];
    for (const message of messages) {
        // Asterisk-wrapped prose is the common RP form for narration and
        // observable action. Accept it here while still excluding quotations,
        // claims, memories, reports, and explicitly uncertain language.
        const objective = characterProfileObjectiveParts(message);
        if (objective.length) objectiveSequences.push(objective);
    }
    const people = [...(world?.entities || []), ...result.entities].filter(item => entityIsPersonLike(item?.type));
    const isBareEntityIdentity = value => /^\p{Lu}[\p{L}\p{N}'’-]*$/u.test(cleanText(value))
        || people.some(person => [person?.name, ...(person?.aliases || [])]
            .some(identity => normalized(identity) === normalized(value)));
    let discarded = 0;
    const warnings = [];
    for (const entity of result.entities) {
        if (!entityIsPersonLike(entity?.type)) {
            delete entity.characterProfile;
            continue;
        }
        const incoming = suppliedCharacterProfile(entity) || parseCharacterProfile(entity?.description) || {};
        delete entity.characterProfile;
        const targetId = cleanText(entity?.targetId);
        const existing = (world?.entities || []).find(item => (targetId && cleanText(item?.id) === targetId)
            || normalized(item?.name) === normalized(entity?.name));
        const objectiveWindows = characterProfileEvidenceWindows(entity, objectiveSequences, people);
        const derived = sourceDerivedCharacterProfile(entity, objectiveWindows, messages, result, world);
        const prior = storedEntityProfile(existing);
        const hadStoredProfile = Object.keys(prior).length > 0;
        const versionAudit = characterProfileNeedsVersionAudit(existing, world);
        if (!CHARACTER_PROFILE_ORDER.some(key => characterProfileDetails(incoming[key]).length
            || characterProfileDetails(derived[key]).length || characterProfileDetails(prior[key]).length)) continue;
        const safe = {};
        let entityDiscarded = 0;
        // Preserve or reject prior details independently. One malformed sibling
        // must never erase valid appearance, history, or personality details.
        for (const key of CHARACTER_PROFILE_ORDER) {
            const priorDetails = characterProfileDetails(prior[key]);
            for (const detail of priorDetails) {
                if (!isBareEntityIdentity(detail) && characterProfileDetailIsAdmissible(key, detail)
                    && (!versionAudit || characterProfileDetailSupported(detail, entity, null, objectiveWindows))) {
                    safe[key] ||= [];
                    safe[key].push(detail);
                }
            }
        }
        const supportedByField = Object.fromEntries(CHARACTER_PROFILE_ORDER.map(key => [key, []]));
        for (const key of CHARACTER_PROFILE_ORDER) {
            for (const detail of characterProfileDetails(incoming[key] || [])) {
                const destination = canonicalCharacterProfileField(key, detail);
                const independentlyDerived = destination && derived[destination]
                    .some(candidate => normalized(candidate) === normalized(detail));
                if (!isBareEntityIdentity(detail)
                    && (independentlyDerived || characterProfileDetailSupported(detail, entity, existing, objectiveWindows))
                    && destination
                    && durableCharacterProfileDetail(destination, detail, objectiveWindows)) supportedByField[destination].push(detail);
                else {
                    discarded++;
                    entityDiscarded++;
                }
            }
        }
        for (const key of CHARACTER_PROFILE_ORDER) {
            for (const detail of derived[key]) if (!isBareEntityIdentity(detail)) supportedByField[key].push(detail);
            if (supportedByField[key].length) {
                safe[key] = characterProfileDetails(mergeCharacterProfileDetails(safe[key], supportedByField[key]));
            }
        }
        entity.profile = normalizeEntityProfile(safe);
        // The safe profile already contains every retained prior detail plus
        // supported incoming details. Tell the memory merger to replace, not
        // union, so details rejected during revalidation cannot resurrect.
        entity._validatedProfileReplace = true;
        entity._profileValidationVersion = EXTRACTION_VERSION;
        const safeDescription = formatEntityProfile(entity.profile);
        if (safeDescription) entity.description = safeDescription;
        else if (hadStoredProfile) entity.description = '';
        else if (existing?.description) entity.description = cleanText(existing.description);
        else entity.description = '';
        if (entityDiscarded) warnings.push(
            `Character-profile grounding: withheld ${entityDiscarded} unsupported detail(s) for “${cleanText(entity?.name)}”; retained source-grounded and prior established details.`,
        );
    }
    return { discarded, warnings };
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

function isDisputedEntityPlaceholder(value) {
    return /^Details about .+ remain disputed or attributed/iu.test(cleanText(value));
}

// A direct, non-epistemic relationship fact is stronger than the generic
// source-attribution heuristic when the source happens to be spoken by one of
// the participants. Preserve the relationship and keep any genuinely
// uncertain clauses in their own attributed records.
function relationshipHasEstablishedFact(result, relationship) {
    const endpoints = [cleanText(relationship?.from), cleanText(relationship?.to)].filter(Boolean);
    if (endpoints.length !== 2) return false;
    const people = endpoints.map(name => ({ name, aliases: [] }));
    return (result?.facts || []).some(fact => {
        const taxonomy = `${cleanText(fact?.predicate)} ${cleanText(fact?.category)}`;
        const evidence = `${cleanText(fact?.subject)} ${cleanText(fact?.predicate)} ${cleanText(fact?.value)}`;
        if (!EXPLICIT_RELATIONSHIP_FACT_ROLE.test(evidence)
            || NON_CANONICAL_RELATIONSHIP_FACT.test(taxonomy)
            || normalized(fact?.persistence) === 'temporary'
            || normalized(fact?.subject) !== normalized(endpoints[0]) && normalized(fact?.subject) !== normalized(endpoints[1])) return false;
        return people.every(person => relationshipEvidenceMentionsPerson(person, evidence, people));
    });
}

function relationshipBackedEntityDescription(result, world, entity, messages) {
    const canonical = normalized(entity?.name);
    if (!canonical) return '';
    const variants = new Set([canonical]);
    for (const resolution of result?.identityResolutions || []) {
        if (normalized(resolution?.canonical) === canonical) variants.add(normalized(resolution?.reference));
    }
    for (const value of [...variants]) {
        const parts = value.split(/\s+/u).filter(part => part.length >= 3);
        if (parts.length > 1) {
            if (!/^(?:admiral|captain|commander|darth|doctor|general|instructor|lady|lord|master|professor|sir)$/iu.test(parts[0])) variants.add(parts[0]);
            variants.add(parts.at(-1));
        }
    }
    const candidates = [];
    const incomingRelationships = (result?.relationships || []).map(relationship => ({ relationship, stored: false }));
    const storedRelationships = (world?.relationships || []).map(relationship => ({ relationship, stored: true }));
    for (const { relationship, stored } of [...incomingRelationships, ...storedRelationships]) {
        if (![relationship?.from, relationship?.to].some(value => variants.has(normalized(value)))) continue;
        const relationshipReference = `${cleanText(relationship?.from)} ${cleanText(relationship?.to)} ${cleanText(relationship?.kind)} ${cleanText(relationship?.dynamic)}`;
        // Stored relationships were already validated against their own source
        // range. A later subjective discussion must not make that established
        // role unusable as the entity's fallback description.
        if (!stored && sourceOnlySubjective(relationshipReference, messages)) continue;
        const canonicalName = cleanText(entity?.name);
        const other = normalized(relationship?.from) === canonical
            ? cleanText(relationship?.to) : cleanText(relationship?.from);
        const dynamicText = cleanText(relationship?.dynamic);
        const kindText = cleanText(relationship?.kind);
        const rolePairs = [
            ['Jedi Master', 'Padawan'], ['Sith Master', 'apprentice'], ['master', 'apprentice'],
            ['mentor', 'student'], ['teacher', 'student'], ['captor', 'captive'],
            ['employer', 'retainer'], ['mistress', 'attendant'], ['parent', 'child'],
        ];
        for (const [seniorRole, juniorRole] of rolePairs) {
            if (!new RegExp(`\\b${escaped(seniorRole)}\\b`, 'iu').test(kindText)
                || !new RegExp(`\\b${escaped(juniorRole)}\\b`, 'iu').test(kindText)) continue;
            const canonicalPossessive = [...new Set([canonicalName, ...variants].map(cleanText).filter(Boolean))]
                .map(value => `${escaped(value)}[’']s`).join('|');
            const otherWasJunior = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(other)}\\s+(?:is|was|remains?|became)\\s+(?:${canonicalPossessive})(?:\\s+(?:former|personal))?\\s+${escaped(juniorRole)}\\b`, 'iu');
            const otherWasPronounJunior = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(other)}\\s+(?:is|was|remains?|became)\\s+(?:his|her|their)(?:\\s+(?:former|personal))?\\s+${escaped(juniorRole)}\\b`, 'iu');
            const otherWasJuniorOfSenior = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(other)}\\s+(?:is|was|remains?|became)\\s+(?:the\\s+)?${escaped(juniorRole)}\\s+of\\s+(?:the\\s+)?(?:[^.!?;]{0,50}\\s+)?${escaped(seniorRole)}\\b`, 'iu');
            const canonicalWasSenior = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(canonicalName)}\\s+(?:is|was|remains?|became)\\s+${escaped(other)}[’']s(?:\\s+(?:former|personal))?\\s+${escaped(seniorRole)}\\b`, 'iu');
            if (otherWasJunior.test(dynamicText) || otherWasPronounJunior.test(dynamicText)
                || otherWasJuniorOfSenior.test(dynamicText) || canonicalWasSenior.test(dynamicText)) {
                candidates.push(`${canonicalName} was ${other}’s ${seniorRole}.`);
            }
        }
        const dynamic = cleanText(relationship?.dynamic)
            .replace(/^Relationship between [^:]{2,180}:\s*/iu, '');
        for (const clause of dynamic.split(/\s*;\s*|(?<=[.!?])\s+/u).map(cleanText).filter(Boolean)) {
            if (![...variants].some(value => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(value)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(normalized(clause)))) continue;
            // A relationship clause may mention both endpoints. It can serve
            // as a biography only for its grammatical subject, never for a
            // participant that appears solely as the object.
            const subjectVariants = [...variants].map(value => escaped(value)).join('|');
            if (!new RegExp(`^(?:(?:the|a|an)\\s+)?(?:${subjectVariants})(?:$|[^\\p{L}\\p{N}])`, 'iu').test(normalized(clause))) continue;
            if (AUDIT_ATTRIBUTION_VERB.test(clause)
                || /\b(?:possibly|perhaps|maybe|might|uncertain|unconfirmed|disputed)\b/iu.test(clause)) continue;
            if (!/\b(?:is|was|serves?|served|remains?|became|killed|died|deceased|slain|former|master|mentor|teacher|apprentice|student|padawan|captor|captive|attendant|ally|enemy|rival|parent|child|spouse)\b/iu.test(clause)) continue;
            candidates.push(clause);
        }
    }
    return candidates.sort((left, right) => {
        const beginsWithCanonical = value => new RegExp(`^${escaped(cleanText(entity?.name))}\\b`, 'iu').test(cleanText(value)) ? 1 : 0;
        const role = value => /\b(?:master|mentor|teacher|apprentice|student|padawan|captor|captive|attendant|parent|child|spouse)\b/iu.test(value) ? 1 : 0;
        return beginsWithCanonical(right) - beginsWithCanonical(left)
            || role(right) - role(left) || right.length - left.length;
    })[0] || '';
}

export function recoverRelationshipBackedEntityDescriptions(result, world, messages) {
    let recovered = 0;
    for (const entity of result?.entities || []) {
        const stored = (world?.entities || []).find(item => normalized(item?.name) === normalized(entity?.name));
        const relationships = [...(world?.relationships || []), ...(result?.relationships || [])]
            .filter(relationship => [relationship?.from, relationship?.to]
                .some(endpoint => normalized(endpoint) === normalized(entity?.name)));
        const inferredRoles = [...new Set(relationships.flatMap(relationship =>
            qualifiedRelationshipRoleEvidence(entity?.name, relationship).roles))];
        const storedProfile = storedEntityProfile(stored);
        const incomingProfile = storedEntityProfile(entity);
        const hasStructuredProfile = Object.keys(storedProfile).length > 0 || Object.keys(incomingProfile).length > 0;
        if (inferredRoles.length && (hasStructuredProfile
            || isDisputedEntityPlaceholder(stored?.description || entity?.description)
            || !cleanText(stored?.description || entity?.description))) {
            const profile = {};
            for (const key of CHARACTER_PROFILE_ORDER) {
                profile[key] = characterProfileDetails([
                    ...(storedProfile?.[key] || []), ...(incomingProfile?.[key] || []),
                ]);
            }
            for (const role of inferredRoles) if (!profile.roleBackground.some(item => normalized(item) === normalized(role))) {
                profile.roleBackground.push(role);
            }
            entity.profile = normalizeEntityProfile(profile);
            entity.description = formatEntityProfile(entity.profile);
            if (entity === stored) {
                entity.profileValidationVersion = EXTRACTION_VERSION;
                delete entity._validatedProfileReplace;
                delete entity._profileValidationVersion;
            } else {
                entity._validatedProfileReplace = true;
                entity._profileValidationVersion = EXTRACTION_VERSION;
            }
            recovered++;
            continue;
        }
        if (stored && !isDisputedEntityPlaceholder(stored?.description) && cleanText(stored?.description)) continue;
        const description = relationshipBackedEntityDescription(result, world, entity, messages);
        if (!description) continue;
        const current = cleanText(entity?.description);
        const qualifiedRole = description.match(/\b(?:Jedi|Sith)\s+(?:master|apprentice|padawan)\b/iu)?.[0] || '';
        const resolvedPrior = (result?.identityResolutions || [])
            .filter(resolution => normalized(resolution?.canonical) === normalized(entity?.name))
            .flatMap(resolution => (world?.entities || []).filter(item => normalized(item?.name) === normalized(resolution?.reference)))
            .map(item => cleanText(item?.description))
            .find(value => value && !isDisputedEntityPlaceholder(value));
        if (resolvedPrior && (!qualifiedRole || new RegExp(escaped(qualifiedRole), 'iu').test(resolvedPrior))) continue;
        if (!isDisputedEntityPlaceholder(current)
            && (!qualifiedRole || new RegExp(escaped(qualifiedRole), 'iu').test(current))) continue;
        entity.description = description;
        recovered++;
    }
    return recovered;
}

function processedStoredMessages(world, messages) {
    if (!Array.isArray(messages) || !messages.length) return [];
    const processed = new Set(Object.values(world?.sources || {})
        .flatMap(source => source?.processedMessages || [])
        .filter(item => Number(item?.version) === EXTRACTION_VERSION)
        .map(item => Number(item?.index)).filter(Number.isFinite));
    return processed.size ? messages.filter(message => processed.has(Number(message?.index))) : [];
}

function splitResolvedStoredCompoundThreads(world) {
    let split = 0;
    const now = new Date().toISOString();
    for (const thread of [...(world?.threads || [])]) {
        if (normalized(thread?.status) !== 'resolved') continue;
        const evidence = cleanText(thread?.detail).replace(/^Resolved(?:(?: by| through)[^:]*)?:\s*/iu, '');
        const parts = partialCompoundThreadResolution(thread, evidence);
        if (!parts) continue;
        thread.title = parts.resolvedTitle;
        thread.detail = `Resolved as to ${parts.resolvedTitle.replace(/^[\p{L}-]+\s+/u, '')}: ${evidence}`;
        thread.updatedAt = now;
        const duplicate = (world.threads || []).some(candidate => candidate !== thread
            && normalized(candidate?.status) === 'open'
            && normalized(candidate?.title) === normalized(parts.unresolvedTitle));
        if (!duplicate) world.threads.push({
            ...thread,
            id: `thread_${randomUuid()}`,
            title: parts.unresolvedTitle,
            detail: `${parts.unresolvedTitle.replace(/^[\p{L}-]+\s+/u, '')} remains unresolved after the other compound claim was established.`,
            status: 'open',
            createdAt: now,
            updatedAt: now,
        });
        split++;
    }
    return split;
}

export function reconcileStoredMemoryRecords(world, messages = null) {
    if (!world || typeof world !== 'object') return 0;
    const sourceMessages = processedStoredMessages(world, messages);
    let reconciled = normalizeRelationshipDescriptions(world);
    reconciled += trimSupersededPhysicalRestraintFacts(world, sourceMessages);
    reconciled += repairTopicKnowledgeAsHolder(world, world);
    reconciled += normalizeKnowledgeHolderContamination(world, world);

    const recovered = {
        entities: world.entities || [], facts: world.facts || [], states: world.states || [], relationships: [],
        events: world.events || [], threads: world.threads || [], backgrounds: world.backgrounds || [],
        identityResolutions: [], recordMerges: [],
    };
    recoverExplicitFactRelationships(recovered, world, sourceMessages);
    const now = new Date().toISOString();
    for (const relationship of recovered.relationships) {
        const identity = relationshipPairIdentity(relationship, world);
        if (!identity || (world.relationships || []).some(item => relationshipPairIdentity(item, world) === identity)) continue;
        const { targetId: _targetId, ...canonical } = relationship;
        world.relationships ||= [];
        world.relationships.push({
            ...canonical,
            id: `relationship_${randomUuid()}`,
            createdAt: now,
            updatedAt: now,
        });
        reconciled++;
    }
    reconciled += normalizeRelationshipDescriptions(world);
    reconciled += recoverRelationshipBackedEntityDescriptions(world, world, sourceMessages);
    reconciled += splitResolvedStoredCompoundThreads(world);

    if (sourceMessages.length && Array.isArray(world?.threads) && world.threads.some(thread => normalized(thread?.status) === 'open')) {
        const evidence = {
            entities: world.entities || [], facts: world.facts || [], states: world.states || [],
            relationships: world.relationships || [], events: world.events || [], backgrounds: world.backgrounds || [],
            threads: [],
            sceneCapsule: {
                beats: [
                    ...(world.capsules || []).flatMap(capsule => capsule?.beats || []),
                    ...(world.extractions || []).flatMap(extraction => extraction?.result?.sceneCapsule?.beats || []),
                ],
            },
        };
        reconcileExplicitlyResolvedThreads(evidence, world, sourceMessages);
        for (const update of evidence.threads) {
            const stored = world.threads.find(thread => cleanText(thread?.id) === cleanText(update?.targetId));
            if (!stored || normalized(stored.status) === normalized(update.status)
                && normalized(stored.detail) === normalized(update.detail)) continue;
            stored.title = cleanText(update.title) || stored.title;
            stored.detail = cleanText(update.detail) || stored.detail;
            stored.status = cleanText(update.status) || stored.status;
            stored.updatedAt = now;
            reconciled++;
        }
    }
    reconciled += reopenInternallyUnresolvedThreads(world);
    return reconciled;
}

export function enrichEntityDescriptionsFromEstablishedFacts(result, world) {
    if (!Array.isArray(result?.entities) || !Array.isArray(result?.facts)) return 0;
    let enriched = 0;
    for (const entity of result.entities) {
        const name = cleanText(entity?.name);
        if (!name || !entityIsPersonLike(entity?.type)) continue;
        const stored = (world?.entities || []).find(item => normalized(item?.name) === normalized(name));
        const candidates = result.facts.filter(fact =>
            normalized(canonicalMemorySubject({ ...(world || {}), entities: [...(world?.entities || []), ...result.entities] }, fact?.subject)) === normalized(name)
            && !AUDIT_EPISTEMIC_CATEGORY.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.category)}`)
            && /\b(?:identity|history|role|rank|title|designation|affiliation|training)\b/iu.test(`${cleanText(fact?.predicate)} ${cleanText(fact?.category)}`)
            && Number(fact?.importance || 0) >= 4
            && cleanText(fact?.value)
            && !AUDIT_SOURCE_SUBJECTIVE.test(cleanText(fact?.value)))
            .sort((left, right) => coverageTerms(cleanText(right?.value)).size - coverageTerms(cleanText(left?.value)).size);
        if (!candidates.length) continue;
        const incomingDescription = cleanText(entity?.description);
        const storedDescription = cleanText(stored?.description);
        let description = !isDisputedEntityPlaceholder(storedDescription) ? storedDescription : '';
        const appendSentence = (base, addition) => {
            const left = cleanText(base);
            const right = cleanText(addition);
            if (!right) return left;
            const separated = left && !/[.!?]$/u.test(left) ? `${left}.` : left;
            const complete = /[.!?]$/u.test(right) ? right : `${right}.`;
            return `${separated}${separated ? ' ' : ''}${complete}`.slice(0, 800);
        };
        if (!isDisputedEntityPlaceholder(incomingDescription)
            && coverageOverlap(description, incomingDescription) < 4) {
            description = appendSentence(description, incomingDescription);
        }
        for (const fact of candidates.slice(0, 2)) {
            const value = cleanText(fact.value);
            if (!value || coverageOverlap(description, value) >= Math.min(4, coverageTerms(value).size)) continue;
            const predicate = cleanText(fact?.predicate);
            const namePattern = new RegExp(`^(?:${escaped(name)}|he|she|they|it)(?:$|[^\\p{L}\\p{N}])`, 'iu');
            const factSentence = namePattern.test(value) || !/^(?:is|was|serves?|served|became|remains?|held|holds?|trained|teaches?|taught|mentored|commands?|commanded)\b/iu.test(predicate)
                ? value
                : `${name} ${predicate} ${value}`;
            description = appendSentence(description, factSentence);
        }
        if (!description || normalized(description) === normalized(entity?.description)) continue;
        entity.description = description;
        enriched++;
    }
    return enriched;
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
            .filter(description => description && !isDisputedEntityPlaceholder(description))
            .sort((left, right) => right.length - left.length);
        const existingDescription = cleanText(existing?.description);
        const relationshipDescription = relationshipBackedEntityDescription(result, world, entity, messages);
        conflicts.push({
            category: 'entities', index, label: cleanText(entity?.name),
            replacementDescription: (!isDisputedEntityPlaceholder(existingDescription) && existingDescription)
                || relationshipDescription || resolvedPriorDescriptions[0] || null,
            warning: `Source-attribution conflict: entity description update for “${cleanText(entity?.name)}” presents character belief, interpretation, or disputed history as objective; retain the prior established description and store the perspective under its holder.`,
        });
    }
    for (const [index, relationship] of (result?.relationships || []).entries()) {
        const reference = `${cleanText(relationship?.from)} ${cleanText(relationship?.to)} ${cleanText(relationship?.kind)} ${cleanText(relationship?.dynamic)}`;
        if (!AUDIT_HISTORICAL_RELATIONSHIP.test(reference) || coverageTerms(reference).size < 5) continue;
        const endpoints = new Set([relationship?.from, relationship?.to].map(normalized).filter(Boolean));
        const identityBacked = (result?.identityResolutions || []).some(resolution => {
            const descriptor = descriptivePersonIdentityContext(resolution?.reference, world);
            return descriptor && endpoints.has(normalized(descriptor.owner))
                && endpoints.has(normalized(resolution?.canonical));
        });
        if (identityBacked) continue;
        const pairIdentity = resolvedAuditPair(result, relationship);
        const threshold = auditEvidenceThreshold(reference);
        const storedSupport = (world?.relationships || []).some(item => resolvedAuditPair(result, item) === pairIdentity
            && coverageOverlap(reference, resolvedAuditRecordText(result, item)) >= threshold);
        if (storedSupport || relationshipHasEstablishedFact(result, relationship) || !sourceOnlySubjective(reference, messages)) continue;
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
        const validatedResolution = !exactNames.includes(incomingName) && (result?.identityResolutions || []).some(resolution =>
            normalized(resolution?.canonical) === incomingName
            && exactNames.includes(normalized(resolution?.reference)));
        if (!incomingName || (!exactNames.includes(incomingName) && !validatedResolution)) return false;
        return entityTypesAreCompatible(incoming?.type, existing?.type);
    }
    if (category === 'facts') {
        if (isAddressFact(incoming) || isAddressFact(existing)) {
            const incomingIdentity = addressFactIdentity(incoming, world);
            return Boolean(incomingIdentity && incomingIdentity === addressFactIdentity(existing, world));
        }
        if (incoming?._knowledgeTransition && sameSubject(incoming?.subject, existing?.subject)) {
            const existingBoundary = /^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(existing?.category))
                || EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(existing?.value));
            const incomingBoundary = /^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(incoming?.category))
                || EXPLICIT_KNOWLEDGE_NEGATION.test(cleanText(incoming?.value));
            if (existingBoundary !== incomingBoundary) return true;
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
    if (category === 'threads') return reconciliationThreadWasAtomicallySplit(incoming)
        || same(incoming?.title, existing?.title);
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

function sanitizeCanonicalThirdPersonProse(result) {
    let trimmed = 0;
    let discarded = 0;
    const sanitizeField = (record, field, allowExactWording = false) => {
        if (!record || allowExactWording) return false;
        const before = cleanText(record[field]);
        if (!before || canonicalProseIsThirdPerson(before)) return false;
        record[field] = thirdPersonOnlyProse(before);
        trimmed++;
        return Boolean(before && !record[field]);
    };
    const sanitizeList = (record, field) => {
        if (!record || !Array.isArray(record[field])) return;
        const before = record[field];
        record[field] = before.map(thirdPersonOnlyProse).filter(Boolean);
        trimmed += before.length - record[field].length;
    };
    const sanitizeRecords = (category, requiredFields, optionalFields = [], exactWording = () => false) => {
        if (!Array.isArray(result?.[category])) return;
        result[category] = result[category].filter(record => {
            let lostRequired = false;
            for (const field of requiredFields) lostRequired = sanitizeField(record, field, exactWording(record, field)) || lostRequired;
            for (const field of optionalFields) sanitizeField(record, field, exactWording(record, field));
            if (lostRequired) discarded++;
            return !lostRequired;
        });
    };

    for (const field of ['activity', 'mood']) sanitizeField(result?.scene, field);
    for (const field of ['title', 'opening', 'emotionalArc', 'closing']) sanitizeField(result?.sceneCapsule, field);
    sanitizeList(result?.sceneCapsule, 'beats');
    if (Array.isArray(result?.entities)) {
        for (const entity of result.entities) sanitizeField(entity, 'description');
    }
    sanitizeRecords('identityResolutions', ['evidence']);
    sanitizeRecords('recordMerges', ['evidence']);
    sanitizeRecords('facts', ['predicate', 'value'], [], (record, field) => field === 'value' && isAddressFact(record));
    sanitizeRecords('states', ['attribute', 'value'], ['previous']);
    sanitizeRecords('relationships', ['kind', 'status', 'dynamic']);
    sanitizeRecords('events', ['title', 'summary'], ['consequences']);
    sanitizeRecords('threads', ['title', 'detail']);
    sanitizeRecords('backgrounds', ['topic', 'summary']);
    const warnings = trimmed || discarded
        ? [`Third-person canonical prose: withheld ${trimmed} first/second-person field(s) and ${discarded} dependent record(s); exact address-form values remain unchanged.`]
        : [];
    return { trimmed, discarded, warnings };
}

const EXPLICIT_KNOWLEDGE_GAIN = /\b(?:now\s+knows?|has\s+learned|learned|discovers?|discovered|recognizes?|recognized|realizes?|realized|identifies?|identified)\b/iu;

export function ensureSceneCapsuleEpistemicCoverage(result) {
    if (!result?.sceneCapsule || typeof result.sceneCapsule !== 'object' || !Array.isArray(result?.facts)) return 0;
    const beats = Array.isArray(result.sceneCapsule.beats) ? result.sceneCapsule.beats.map(cleanText).filter(Boolean) : [];
    const capsuleText = cleanText([
        result.sceneCapsule.opening,
        ...beats,
        result.sceneCapsule.emotionalArc,
        result.sceneCapsule.closing,
    ].join(' '));
    const candidates = result.facts.filter(fact => {
        const category = cleanText(fact?.category);
        const predicate = cleanText(fact?.predicate);
        const value = cleanText(fact?.value);
        const epistemic = /^(?:knowledge|knowledge boundary|knowledge gap)$/iu.test(category)
            || /^knowledge of\b/iu.test(predicate);
        return epistemic && (/^(?:knowledge boundary|knowledge gap)$/iu.test(category)
            || EXPLICIT_KNOWLEDGE_NEGATION.test(value)
            || fact?._knowledgeTransition
            || EXPLICIT_KNOWLEDGE_GAIN.test(value));
    }).sort((left, right) => Number(right?.importance || 0) - Number(left?.importance || 0));
    const missing = [];
    const seen = new Set();
    for (const fact of candidates) {
        const subject = cleanText(fact?.subject);
        const predicate = cleanText(fact?.predicate);
        let value = cleanText(fact?.value)
            .replace(/;\s*(?:the\s+)?canonical memory label[^.]*\.?$/iu, '')
            .replace(/;\s*model access[^.]*\.?$/iu, '');
        const identity = `${normalized(subject)}|${normalized(predicate)}`;
        if (!subject || !value || seen.has(identity)) continue;
        seen.add(identity);
        const negative = /^(?:knowledge boundary|knowledge gap)$/iu.test(cleanText(fact?.category))
            || EXPLICIT_KNOWLEDGE_NEGATION.test(value);
        const alreadyCovered = capsuleText.includes(normalized(value))
            || (normalized(capsuleText).includes(normalized(subject))
                && (!negative || EXPLICIT_KNOWLEDGE_NEGATION.test(capsuleText))
                && predicate.split(/\s+/u).filter(word => word.length > 4)
                    .some(word => normalized(capsuleText).includes(normalized(word))));
        if (!alreadyCovered) missing.push(value.slice(0, 400));
        if (missing.length >= 2) break;
    }
    if (!missing.length) return 0;
    const retained = beats.slice(0, Math.max(0, 10 - missing.length));
    result.sceneCapsule.beats = [...retained, ...missing];
    return missing.length;
}

// Model schemas use uppercase placeholder tokens in instructions and examples.
// They are never valid continuity content; reject them before normalizers or
// recovery helpers can turn the surrounding malformed record into canon.
const SCHEMA_PLACEHOLDER_TOKEN = /\b(?:CHARACTER_ASSESSMENT|PROPOSITION_TYPE|CANONICAL_SUBJECT|CANONICAL_NAME|ACTUAL_CANONICAL_NAME|UNKNOWN_HOLDER|UNKNOWN_TOPIC|SUBJECT_NAME|ENTITY_NAME|RELATIONSHIP_DESCRIPTION)\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\{\{[^{}]{1,80}\}\}|<\/?(?:subject|topic|proposition|claim|description|name)>/u;
const SCHEMA_PLACEHOLDER_FIELDS = Object.freeze({
    entities: ['name', 'description'],
    facts: ['subject', 'predicate', 'value'],
    states: ['subject', 'attribute', 'value', 'previous'],
    relationships: ['from', 'to', 'kind', 'status', 'dynamic'],
    events: ['title', 'summary', 'consequences'],
    threads: ['title', 'detail'],
    backgrounds: ['topic', 'summary'],
});

function discardSchemaPlaceholderRecords(result) {
    let discarded = 0;
    const warnings = [];
    for (const [category, fields] of Object.entries(SCHEMA_PLACEHOLDER_FIELDS)) {
        if (!Array.isArray(result?.[category])) continue;
        const kept = [];
        for (const item of result[category]) {
            if (!item || typeof item !== 'object') {
                kept.push(item);
                continue;
            }
            const field = fields.find(key => SCHEMA_PLACEHOLDER_TOKEN.test(String(item[key] ?? '')));
            if (!field) {
                kept.push(item);
                continue;
            }
            discarded++;
            if (category === 'entities' && field === 'description') {
                const copy = { ...item, description: '' };
                kept.push(copy);
            }
        }
        result[category] = kept;
    }
    if (discarded) warnings.push(`Schema placeholders: withheld ${discarded} malformed record(s) before persistence.`);
    return { discarded, warnings };
}

export function sanitizeReconciliationMetadata(result, world, messages = null) {
    const missingIdentityResolutions = !Array.isArray(result.identityResolutions);
    if (missingIdentityResolutions) result.identityResolutions = [];
    const schemaPlaceholderGate = discardSchemaPlaceholderRecords(result);
    const thirdPersonGate = sanitizeCanonicalThirdPersonProse(result);
    normalizeMixedOwnerPersonIdentities(result, world);
    const canonicalizedEntityVariants = canonicalizeConservativeEntityVariants(result, world);
    const normalizedIdentityReferences = normalizeIdentityResolutionReferences(result);
    const discardedIdentityResolutions = discardUnsupportedIdentityResolutions(result, world, messages);
    const normalizedEpistemicFacts = normalizeEpistemicFactShapes(result, world);
    const repairedTopicKnowledgeHolders = repairTopicKnowledgeAsHolder(result, world);
    const trimmedCrossHolderAttributedClauses = trimCrossHolderAttributedClauses(result, world);
    let discardedMalformedDesignations = discardMalformedEstablishedDesignationFacts(result);
    const normalizedAddresses = normalizeDirectionalAddressFacts(result, world);
    const repairedAddresses = repairReversedAddressFacts(result, world, messages);
    const recovered = recoverExplicitAddressFacts(result, world, messages);
    const discardedAddressValues = removeCrossDirectionAddressContamination(result, world, messages);
    const recoveredAliases = recoverExplicitEntityAliases(result, messages);
    const promotedDescriptiveAliases = promoteExplicitDescriptiveEntityAliases(result, world, messages);
    const recoveredBoundaries = recoverExplicitConcealmentBoundaries(result, world);
    const normalizedKnowledgePredicates = normalizeKnowledgePredicateTaxonomy(result, world);
    const normalizedRelationalKnowledge = normalizeRelationalKnowledgeTopics(result, world);
    let normalizedKnowledgeHolders = normalizeKnowledgeHolderContamination(result, world);
    const repairedSelfIdentificationKnowledge = repairReversedSelfIdentificationKnowledge(result, world);
    const recoveredKnowledge = recoverExplicitPriorKnowledge(result, world, messages);
    normalizedKnowledgeHolders += normalizeKnowledgeHolderContamination(result, world);
    const discardedMisownedQuestionKnowledge = discardMisownedQuestionKnowledgeFacts(result, world);
    const discardedMismatchedKnowledgeTopics = discardMismatchedKnowledgeTopicFacts(result, world);
    const repairedRecoveredSelfIdentificationKnowledge = repairReversedSelfIdentificationKnowledge(result, world);
    const recoveredIdentities = recoverExplicitNamedIdentityResolutions(result, world, messages);
    const recoveredEstablishedIdentities = recoverEstablishedDescriptiveIdentityResolutions(result, world);
    const canonicalizedIdentityReferences = canonicalizeResolvedIdentityReferences(result, world);
    const supersededIdentityBoundaries = supersedeResolvedDescriptiveIdentityBoundaries(result, world);
    const supersededSubjectIdentityUnknowns = supersedeResolvedSubjectIdentityUnknowns(result, world);
    const recoveredOocIdentityBoundaries = recoverExplicitOocIdentityBoundaries(result, world, messages);
    const normalizedIdentityEpistemicRiders = normalizeObjectiveIdentityEpistemicRiders(result, world);
    const knowledgeBoundaryGate = discardKnowledgeBlockedIdentityLeaks(result, world, messages);
    const discardedContradictedObjectFacts = discardContradictedObjectStateFacts(result, world, messages);
    const trimmedSupersededPhysicalRestraintFacts = trimSupersededPhysicalRestraintFacts(result, messages);
    const repairedRelationshipDescriptions = repairRelationshipPairDescriptionContamination(result, world);
    const recoveredIdentityRelationships = recoverIdentityResolutionRelationships(result, world);
    const recoveredRelationshipEntityDescriptions = recoverRelationshipBackedEntityDescriptions(result, world, messages);
    const recoveredFactRelationships = recoverExplicitFactRelationships(result, world, messages);
    const normalizedResolvedRelationalKnowledge = normalizeRelationalKnowledgeTopics(result, world);
    const normalizedResolvedKnowledgePredicates = normalizeKnowledgePredicateTaxonomy(result, world);
    const repairedKnowledgeMembershipOverclaims = sanitizeKnowledgeMembershipOverclaims(result, world);
    const reconciledHistoricalRelationships = reconcileHistoricalRelationshipLifecycles(result, world);
    const recoveredSceneCoverage = recoverSourceGroundedCoverageRecords(result, world, messages);
    const recoveredCommitments = recoverExplicitFutureCommitments(result, world, messages);
    const recoveredIdentityThreads = recoverExplicitIdentityBoundaryThreads(result, world);
    const recoveredCoverage = recoveredEstablishedIdentities + recoveredIdentityRelationships + recoveredFactRelationships + recoveredSceneCoverage + recoveredCommitments
        + recoveredIdentityThreads + recoveredOocIdentityBoundaries;
    // Recovery operates on model prose and can recreate a shape that an
    // earlier validation pass just rejected; validate recovered facts too.
    discardedMalformedDesignations += discardMalformedEstablishedDesignationFacts(result);
    const preservedResolvedThreads = preserveResolvedThreadHistory(result, world);
    const splitCompoundThreads = splitResolvedCompoundThreads(result, world);
    const modelResolvedThreads = new Set((result?.threads || []).filter(thread => normalized(thread?.status) === 'resolved'));
    const resolvedCompletedThreads = resolveCompletedIncomingThreads(result);
    const reopenedUnsupportedThreads = reopenUnsupportedResolvedThreads(result, world, messages, modelResolvedThreads);
    const reconciledIdentityThreads = reconcileResolvedIdentityThreads(result, world, messages);
    const reconciledThreads = reconcileExplicitlyResolvedThreads(result, world, messages);
    const reopenedInternallyUnresolvedThreads = reopenInternallyUnresolvedThreads(result);
    const normalizedRelationshipDescriptions = normalizeRelationshipDescriptions(result);
    const stateDurabilityGate = sanitizeStateDurability(result);
    const normalizedCompositeStateSubjects = normalizeCompositeStateSubjects(result, world);
    const repairedStateOwners = repairStableStateOwners(result, world);
    const reconciledStateTransitions = reconcileStatePreviousValues(result, world);
    const reconciledSceneParticipants = reconcileSceneParticipants(result, world, messages);
    const reconciledAddresses = reconcileGenericAddressDuplicates(result, world);
    const discardedUnsupportedAddresses = removeUnsupportedAddressValues(result, messages, world);
    const discardedPronounAddresses = removeUnsupportedPronounAddressValues(result, messages, world);
    const recoveredL1EpistemicBeats = ensureSceneCapsuleEpistemicCoverage(result);
    let ignored = schemaPlaceholderGate.discarded + thirdPersonGate.discarded + discardedAddressValues + discardedUnsupportedAddresses + discardedPronounAddresses
        + discardedIdentityResolutions
        + discardedMalformedDesignations
        + discardedMisownedQuestionKnowledge
        + discardedMismatchedKnowledgeTopics
        + knowledgeBoundaryGate.discarded
        + stateDurabilityGate.discarded
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
    const characterProfileGrounding = sanitizeStructuredCharacterProfiles(result, world, messages);
    const sourceAttributionConflicts = findSourceAttributionConflicts(result, world, messages);
    const localWarnings = [...new Set([
        ...relationshipEndpointConflicts.map(item => item.warning),
        ...schemaPlaceholderGate.warnings,
        ...thirdPersonGate.warnings,
        ...characterProfileGrounding.warnings,
        ...knowledgeBoundaryGate.warnings,
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
    return { ignored, recovered, recoveredAliases, recoveredBoundaries, recoveredL1EpistemicBeats, canonicalizedEntityVariants, normalizedKnowledgePredicates: normalizedKnowledgePredicates + normalizedResolvedKnowledgePredicates, normalizedRelationalKnowledge: normalizedRelationalKnowledge + normalizedResolvedRelationalKnowledge, repairedKnowledgeMembershipOverclaims, repairedSelfIdentificationKnowledge: repairedSelfIdentificationKnowledge + repairedRecoveredSelfIdentificationKnowledge, repairedTopicKnowledgeHolders, trimmedCrossHolderAttributedClauses, normalizedKnowledgeHolders, recoveredKnowledge, recoveredIdentities, recoveredEstablishedIdentities, supersededIdentityBoundaries, recoveredOocIdentityBoundaries, discardedKnowledgeBoundaryLeaks: knowledgeBoundaryGate.discarded, normalizedIdentityEpistemicRiders, normalizedIdentityReferences, discardedIdentityResolutions, discardedMalformedDesignations, discardedMisownedQuestionKnowledge, discardedMismatchedKnowledgeTopics, canonicalizedIdentityReferences, discardedContradictedObjectFacts, trimmedSupersededPhysicalRestraintFacts, repairedRelationshipDescriptions, recoveredRelationshipEntityDescriptions, recoveredIdentityRelationships, recoveredFactRelationships, reconciledHistoricalRelationships, recoveredCommitments, recoveredIdentityThreads, recoveredCoverage, preservedResolvedThreads, splitCompoundThreads, reopenedUnsupportedThreads: reopenedUnsupportedThreads + reopenedInternallyUnresolvedThreads, reconciledThreads: Math.max(0, resolvedCompletedThreads - reopenedUnsupportedThreads - reopenedInternallyUnresolvedThreads) + reconciledIdentityThreads + reconciledThreads.resolved, normalizedEpistemicFacts, normalizedRelationshipDescriptions, discardedSchemaPlaceholderRecords: schemaPlaceholderGate.discarded, discardedNonThirdPersonProseFields: thirdPersonGate.trimmed, discardedNonThirdPersonProseRecords: thirdPersonGate.discarded, discardedNonDurableStates: stateDurabilityGate.discarded, demotedSceneStates: stateDurabilityGate.demoted, normalizedCompositeStateSubjects, repairedStateOwners, reconciledStateTransitions, reconciledSceneParticipants, repairedAddresses, normalizedAddresses, discardedAddressValues, discardedUnsupportedAddresses, discardedPronounAddresses, reconciledAddresses, discardedCharacterProfileDetails: characterProfileGrounding.discarded, sourceAttributionConflicts, relationshipEndpointConflicts, localWarnings, diagnosticWarnings, warnings };
}
