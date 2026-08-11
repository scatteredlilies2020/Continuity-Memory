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

function isGenericAddressFact(item) {
    const category = normalized(item?.category);
    const predicate = normalized(item?.predicate);
    return /^(?:social address|forms? of address)$/u.test(category)
        && /^(?:uses?|used) (?:the )?(?:address|address form|form of address|nickname)$/u.test(predicate);
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
    const entities = world?.entities || [];
    const matches = entities.filter(entity => [entity?.name, ...(entity?.aliases || [])]
        .some(name => normalized(name) === requested));
    if (matches.length === 1) return normalized(matches[0].name);
    if (!matches.length && !requested.includes(' ')) {
        const shortMatches = entities.filter(entity => normalized(String(entity?.name || '').split(/\s+/u)[0]) === requested);
        if (shortMatches.length === 1) return normalized(shortMatches[0].name);
    }
    return normalized(value);
}

function canonicalAddressDisplayName(world, value) {
    const requested = normalized(value);
    const matches = (world?.entities || []).filter(entity => [entity?.name, ...(entity?.aliases || [])]
        .some(name => normalized(name) === requested));
    return String(matches.length === 1 ? matches[0].name : value || '').replace(/\s+/g, ' ').trim();
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

const COVERAGE_CUE = /\b(?:agrees?|appoints?|assigned|becomes?|called|calls?|decides?|discovers?|injured|intends?|learns?|loses?|named|plans?|promises?|receives?|remains?|reveals?|suffers?|vows?|wounded)\b/iu;
const COVERAGE_STOP_WORDS = new Set('a an and are as at be been being but by for from had has have he her hers him his i in into is it its of on or our she that the their them they this to was were will with you your'.split(' '));

function coverageTerms(value) {
    return new Set((String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [])
        .filter(term => term.length > 1 && !COVERAGE_STOP_WORDS.has(term)));
}

function coverageOverlap(left, right) {
    const rightTerms = coverageTerms(right);
    let matches = 0;
    for (const term of coverageTerms(left)) if (rightTerms.has(term)) matches++;
    return matches;
}

export function findCoverageWarnings(result, messages) {
    if (!Array.isArray(result?.sceneCapsule?.beats) || !Array.isArray(messages) || !messages.length) return [];
    const source = messages.map(message => String(message?.text ?? message?.mes ?? '')).join('\n');
    const records = ['facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']
        .flatMap(key => Array.isArray(result?.[key]) ? result[key] : [])
        .map(item => JSON.stringify(item));
    const warnings = [];
    for (const raw of result.sceneCapsule.beats) {
        const beat = String(raw || '').replace(/\s+/g, ' ').trim();
        const terms = coverageTerms(beat);
        if (!beat || !COVERAGE_CUE.test(beat) || terms.size < 3) continue;
        const threshold = terms.size >= 5 ? 3 : 2;
        const sourced = coverageOverlap(beat, source) >= threshold;
        const covered = records.some(record => coverageOverlap(beat, record) >= threshold);
        if (sourced && !covered) warnings.push(`Potential durable detail remains only in L1: ${beat}`);
        if (warnings.length >= 8) break;
    }
    return warnings;
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

function directlyVoicesFirstPersonSpeech(text, form) {
    const formPattern = escaped(form);
    if (!formPattern) return false;
    const quoted = new RegExp(`[“\"][^”\"\n\r]{0,240}${formPattern}[^”\"\n\r]{0,240}[”\"]`, 'iu').test(text);
    const firstPersonSpeech = /\bI\b[^\n\r]{0,100}\b(?:say|said|ask|asked|reply|replied|shout|shouted|yell|yelled|call|called)\b|\b(?:say|said|ask|asked|reply|replied|shout|shouted|yell|yelled|call|called)\b[^\n\r]{0,100}\bI\b/iu.test(text);
    const firstPersonActionAfterQuote = new RegExp(`[“"][^”"\n\r]{0,240}${formPattern}[^”"\n\r]{0,240}[”"]\\s{0,20}\\bI\\b`, 'iu').test(text);
    return quoted && (firstPersonSpeech || firstPersonActionAfterQuote);
}

function hasAddressSpeechEvidence(messages, world, speaker, form) {
    const canonicalSpeaker = canonicalAddressName(world, speaker);
    const speakerNames = addressNameVariants(world, speaker);
    return (messages || []).some(message => {
        const text = String(message?.text ?? message?.mes ?? '');
        if (!containsAddressForm(text, form)) return false;
        const authoredDirectly = canonicalAddressName(world, message?.name) === canonicalSpeaker
            && directlyVoicesFirstPersonSpeech(text, form);
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
        const authoredDirectly = canonicalAddressName(world, message?.name) === canonicalSpeaker
            && directlyVoicesFirstPersonSpeech(text, form);
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
            if (reverseEvidence && !forwardEvidence) reversed.push(form);
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
            result.facts.push({
                targetId: stored?.id || '',
                subject: addressee,
                predicate: `calls ${speaker}`,
                value: mergeAddressValues(...reversed),
                category: 'form of address',
                importance: Number(item.importance || 2),
                persistence: ['temporary', 'recurring', 'persistent'].includes(item.persistence) ? item.persistence : 'recurring',
            });
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
    let changed = reconcileGenericAddressDuplicates(world, world);
    changed += removeInvalidAddressFacts(world);
    const correctedAddressSelectors = new Set((world?.corrections || [])
        .flatMap(correction => correction?.operations || [])
        .filter(operation => operation?.category === 'facts' && ['update', 'delete'].includes(operation?.action))
        .map(operation => String(operation?.beforeSelector || ''))
        .filter(Boolean));
    for (const extraction of world?.extractions || []) {
        changed += reconcileGenericAddressDuplicates(extraction?.result, world);
        changed += removeInvalidAddressFacts(extraction?.result);
        if (!Array.isArray(extraction?.result?.facts) || !correctedAddressSelectors.size) continue;
        const retained = extraction.result.facts.filter(item => !isAddressFact(item)
            || !correctedAddressSelectors.has(addressFactIdentity(item)));
        changed += extraction.result.facts.length - retained.length;
        extraction.result.facts = retained;
    }
    return changed;
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
    const repairedAddresses = repairReversedAddressFacts(result, world, messages);
    const recovered = recoverExplicitAddressFacts(result, world, messages);
    const discardedAddressValues = removeCrossDirectionAddressContamination(result, world, messages);
    const recoveredAliases = recoverExplicitEntityAliases(result, messages);
    const reconciledAddresses = reconcileGenericAddressDuplicates(result, world);
    let ignored = discardedAddressValues + removeInvalidAddressFacts(result);
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
    const warnings = findCoverageWarnings(result, messages);
    if (result?.sceneCapsule && typeof result.sceneCapsule === 'object') result.sceneCapsule.coverageWarnings = warnings;
    return { ignored, recovered, recoveredAliases, repairedAddresses, discardedAddressValues, reconciledAddresses, warnings };
}
