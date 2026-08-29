const STOP_WORDS = new Set('a an the and that this with from into have has had was were are am can did does will shall may might must for but not never neither nor you your they them their she her him his its our out about just then than there here what when where who how why would could should been being also very more most some any all to of in on at as by or if it is be do we he me my up no so us during between through within without among around'.split(' '));
const IRREGULAR_NEGATIVE_BASES = new Map([
    ['ca', 'can'],
    ['wo', 'will'],
    ['sha', 'shall'],
    ['ai', 'am'],
]);
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LIFECYCLE_GUIDANCE = 'Facts are objective canon unless corrected; perspectives and reports are not. Entity rows describe only their entity. Relationship ↔ has no directional role; use its Description and established facts. Only Current state is current. Open matters are pending; other events and plans are past.';
const BM25_K1 = 1.2;
const RRF_OFFSET = 20;
const RETRIEVAL_FIELDS = {
    identity: { weight: 0.8, lengthWeight: 0.2 },
    anchor: { weight: 0.45, lengthWeight: 0.2 },
    heading: { weight: 2.2, lengthWeight: 0.3 },
    body: { weight: 1, lengthWeight: 0.75 },
};

import { isFreshActiveState, latestSourceInRawTail, latestSourceRange, sourcedWhollyInRawTail } from './state-lifecycle.js';
import { anchoredRelativeText, anchoredStoryTime } from './temporal-anchors.js';
import { retrievalMessageText } from './retrieval-query.js';
import { formatEntityProfile } from './entity-profile.js';
import { renderChronicleFrontier } from './chronicle.js';

function plain(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function ledgerTitleKey(value) {
    return plain(value).replace(/[’‘]/gu, "'").toLocaleLowerCase();
}

function recordFreshness(item, chatKey = '') {
    const source = latestSourceRange(item, chatKey);
    const updated = Date.parse(item?.updatedAt || item?.createdAt || '') || 0;
    return [Number(source?.to ?? -1), Number(source?.from ?? -1), updated];
}

function compareRecordFreshness(left, right, chatKey = '') {
    const a = recordFreshness(left, chatKey);
    const b = recordFreshness(right, chatKey);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function newestRecordsBy(items, identity, chatKey = '') {
    const latest = new Map();
    for (const item of items || []) {
        const key = identity(item);
        if (!key) continue;
        const existing = latest.get(key);
        if (!existing || compareRecordFreshness(item, existing, chatKey) >= 0) latest.set(key, item);
    }
    return [...latest.values()];
}

function isKnowledgeBoundaryFact(item) {
    const category = plain(item?.category).toLocaleLowerCase();
    if (category === 'knowledge boundary' || category === 'knowledge gap') return true;
    if (category !== 'knowledge') return false;
    return /\b(?:does not know|doesn't know|did not know|didn't know|has not learned|hasn't learned|was not told|wasn't told|has not been told|hasn't been told|is unaware|remains unaware|no knowledge of)\b/iu.test(plain(item?.value));
}

function isEstablishedKnowledgeFact(item) {
    return !isKnowledgeBoundaryFact(item) && /^knowledge of\s+\S/iu.test(plain(item?.predicate));
}

function boundaryHolderIsInContext(item, query) {
    const holderTerms = [...terms(item?.subject, true)];
    const context = new Set([...(query?.focus || []), ...(query?.context || []), ...(query?.identityFocus || [])]);
    return holderTerms.length > 0 && holderTerms.every(holder => [...context]
        .some(term => queryTermVariants(term, true).includes(holder)));
}

function englishMorphologyToken(value) {
    if (!/^[a-z]+$/u.test(value) || value.length < 5) return '';
    const rules = [
        [/ization$/u, 'ize'], [/ational$/u, 'ate'], [/fulness$/u, 'ful'], [/ousness$/u, 'ous'],
        [/iveness$/u, 'ive'], [/tional$/u, 'tion'], [/biliti$/u, 'ble'], [/aliti$/u, 'al'],
        [/iviti$/u, 'ive'], [/ements?$/u, ''], [/ments?$/u, ''], [/ances?$/u, ''],
        [/ences?$/u, ''], [/ness$/u, ''], [/ingly$/u, ''], [/edly$/u, ''], [/ing$/u, ''],
        [/ed$/u, ''], [/al$/u, ''], [/e$/u, ''], [/s$/u, ''],
    ];
    for (const [pattern, replacement] of rules) {
        if (!pattern.test(value)) continue;
        const stem = value.replace(pattern, replacement);
        return stem.length >= 4 && stem !== value ? `~${stem}` : '';
    }
    return '';
}

function queryTermVariants(term, includeMorphology = false) {
    const morphology = includeMorphology && !term.startsWith('~') ? englishMorphologyToken(term) : '';
    return morphology ? [term, morphology] : [term];
}

function fieldHasQueryTerm(field, term, includeMorphology = false) {
    return queryTermVariants(term, includeMorphology).some(variant => field.unique.has(variant));
}

function statsHasQueryTerm(stats, term, includeMorphology = false) {
    return Object.values(stats.fields).some(field => fieldHasQueryTerm(field, term, includeMorphology));
}

function englishLexicalForms(rawToken) {
    const raw = String(rawToken || '')
        .replace(/[’‘]/gu, "'")
        .replace(/[‐‑‒–—]/gu, '-');
    let normalized = raw.toLocaleLowerCase();
    if (normalized.includes("'")) {
        let previous = '';
        while (previous !== normalized) {
            previous = normalized;
            normalized = normalized.replace(/'(?:s|ll|re|ve|d|m)$/u, '');
        }
        const negative = normalized.match(/^(.+)n't$/u);
        if (negative) normalized = IRREGULAR_NEGATIVE_BASES.get(negative[1]) || negative[1];
    }
    const bases = normalized.includes("'") ? normalized.split("'") : [normalized];
    const forms = [];
    for (const base of bases.filter(Boolean)) {
        forms.push(base);
        if (base.includes('-')) forms.push(...base.split('-').filter(Boolean));
    }
    return [...new Set(forms)].map(value => ({
        value,
        upperCaseIdentifier: raw === raw.toLocaleUpperCase() && raw !== raw.toLocaleLowerCase(),
    }));
}

function tokenList(value, includeMorphology = false) {
    const source = plain(value);
    const found = [];
    for (const run of source.match(CJK_RUN) || []) {
        const characters = [...run.toLocaleLowerCase()];
        if (characters.length <= 4) found.push(characters.join(''));
        if (characters.length > 1) {
            for (let index = 0; index < characters.length - 1; index++) found.push(characters.slice(index, index + 2).join(''));
        }
        if (characters.length > 2) {
            for (let index = 0; index < characters.length - 2; index++) found.push(characters.slice(index, index + 3).join(''));
        }
    }
    const nonCjk = source.replace(CJK_RUN, ' ')
        .replace(/[’‘]/gu, "'")
        .replace(/[‐‑‒–—]/gu, '-');
    for (const token of nonCjk.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []) {
        for (const { value: normalized, upperCaseIdentifier } of englishLexicalForms(token)) {
            const length = [...normalized].length;
            if (length >= 3 && !STOP_WORDS.has(normalized)) {
                found.push(normalized);
                const morphology = includeMorphology ? englishMorphologyToken(normalized) : '';
                if (morphology) found.push(morphology);
            } else if (length === 2 && (!STOP_WORDS.has(normalized) || upperCaseIdentifier)) found.push(normalized);
        }
        // Single Latin letters and digits produce excessive substring matches
        // (for example, the article "A" matching nearly every memory row).
    }
    if (found.length <= 4096) return found;
    return [...found.slice(0, 2048), ...found.slice(-2048)];
}

function terms(value, includeMorphology = false) {
    return new Set(tokenList(value, includeMorphology));
}

function estimatedTokens(value) {
    let ascii = 0;
    let wide = 0;
    for (const character of String(value ?? '')) {
        if (character.codePointAt(0) > 0x7f) wide++;
        else ascii++;
    }
    return Math.ceil(wide + ascii / 4);
}

function searchable(item) {
    return plain(Object.entries(item || {})
        .filter(([key]) => !['id', 'sources', 'createdAt', 'updatedAt'].includes(key))
        .map(([, value]) => Array.isArray(value) ? value.join(' ') : value)
        .join(' '));
}

function textValues(value) {
    if (Array.isArray(value)) return value.flatMap(textValues);
    if (value && typeof value === 'object') return Object.values(value).flatMap(textValues);
    if (typeof value === 'string' || typeof value === 'number') return [value];
    return [];
}

function retrievalFieldText(item) {
    const identityKeys = new Set(['name', 'subject', 'from', 'to', 'aliases']);
    const headingKeys = new Set(['title', 'topic', 'predicate', 'attribute', 'kind', 'type', 'category']);
    const ignoredKeys = new Set(['id', 'sources', 'createdAt', 'updatedAt', 'chatKey', 'from', 'to', 'importance', 'revision', 'capsuleIds', 'arcIds']);
    const identity = [
        item?.name,
        item?.subject,
        item?.from,
        item?.to,
        isAddressFact(item) ? addressFactAddressee(item) : '',
        ...(item?.aliases || []),
    ].filter(Boolean).join(' ');
    const anchor = (item?.participants || []).filter(Boolean).join(' ');
    const heading = [...headingKeys].flatMap(key => textValues(item?.[key])).join(' ');
    const body = Object.entries(item || {})
        .filter(([key]) => key !== 'participants' && !identityKeys.has(key) && !headingKeys.has(key) && !ignoredKeys.has(key))
        .flatMap(([, value]) => textValues(value))
        .join(' ');
    return { identity, anchor, heading, body };
}

function retrievalFieldStats(item) {
    const text = retrievalFieldText(item);
    const fields = {};
    const all = new Set();
    for (const field of Object.keys(RETRIEVAL_FIELDS)) {
        const tokens = tokenList(text[field], true);
        const counts = new Map();
        for (const token of tokens) {
            counts.set(token, (counts.get(token) || 0) + 1);
            all.add(token);
        }
        fields[field] = { tokens, counts, unique: new Set(tokens) };
    }
    return { fields, all };
}

function capsulePassageStats(item, profile) {
    const cached = profile.passageStats?.get(item);
    if (cached) return cached;
    const passages = [item?.opening, ...(item?.beats || []), item?.closing]
        .map(plain)
        .filter(Boolean);
    const windows = passages.flatMap((passage, index) => [
        passage,
        index + 1 < passages.length ? `${passage} ${passages[index + 1]}` : '',
    ]).filter(Boolean);
    const localizedWindows = [...windows, plain(item?.emotionalArc)].filter(Boolean);
    const stats = (localizedWindows.length ? localizedWindows : [plain(item?.title)])
        .filter(Boolean)
        .map(passage => retrievalFieldStats({
            title: item?.title,
            participants: item?.participants,
            passage,
        }));
    const result = stats.length ? stats : [profile.recordStats.get(item) || retrievalFieldStats(item)];
    profile.passageStats?.set(item, result);
    return result;
}

function searchableTerms(item) {
    return retrievalFieldStats(item).all;
}

function identityTerms(item) {
    return terms(retrievalFieldText(item).identity);
}

function headingTerms(item) {
    return terms(retrievalFieldText(item).heading);
}

function identitySideMatches(source, value, includeMorphology = false) {
    const side = [...terms(value)];
    return side.length > 0 && side.some(nameTerm => [...source]
        .some(term => queryTermVariants(term, includeMorphology).includes(nameTerm)));
}

function pairedIdentityMatch(item, source, includeMorphology = false) {
    const sides = isAddressFact(item)
        ? [item?.subject, addressFactAddressee(item)]
        : [item?.from, item?.to];
    return sides.every(side => plain(side))
        && sides.every(side => identitySideMatches(source, side, includeMorphology));
}

function containsTokenSequence(source, sequence) {
    if (!sequence.length || sequence.length > source.length) return false;
    return source.some((_, start) => sequence.every((term, offset) => source[start + offset] === term));
}

function resolvedIdentityTerms(world, values) {
    const source = (values || []).flatMap(value => tokenList(value));
    const resolved = new Set();
    for (const entity of world?.entities || []) {
        const variants = [entity?.name, ...(entity?.aliases || [])]
            .map(value => tokenList(value))
            .filter(value => value.length);
        if (!variants.some(variant => containsTokenSequence(source, variant))) continue;
        for (const term of terms(entity?.name, true)) resolved.add(term);
    }
    return resolved;
}

function retrievalRecords(world) {
    return [world?.scene]
        .concat(...[
            'entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras',
            'threads', 'backgrounds', 'corrections',
        ].map(category => world?.[category] || []))
        .filter(Boolean);
}

const RETRIEVAL_CORPUS_CACHE = new WeakMap();

function retrievalCorpusRevision(world) {
    return Number(world?.revision ?? -1);
}

function createRetrievalCorpus(world) {
    return {
        revision: retrievalCorpusRevision(world),
        records: retrievalRecords(world),
        recordStats: new Map(),
        documentFrequency: new Map(),
        identityVocabulary: new Set(),
        totalFieldLengths: Object.fromEntries(Object.keys(RETRIEVAL_FIELDS).map(field => [field, 0])),
        averageFieldLengths: null,
        passageStats: new Map(),
    };
}

function addRetrievalCorpusRecord(corpus, item) {
    const stats = retrievalFieldStats(item);
    corpus.recordStats.set(item, stats);
    for (const term of stats.fields.identity.unique) corpus.identityVocabulary.add(term);
    for (const term of stats.fields.anchor.unique) corpus.identityVocabulary.add(term);
    for (const field of Object.keys(RETRIEVAL_FIELDS)) corpus.totalFieldLengths[field] += stats.fields[field].tokens.length;
    for (const term of stats.all) corpus.documentFrequency.set(term, (corpus.documentFrequency.get(term) || 0) + 1);
}

function finalizeRetrievalCorpus(world, corpus) {
    const documentCount = Math.max(1, corpus.records.length);
    corpus.averageFieldLengths = Object.fromEntries(Object.keys(RETRIEVAL_FIELDS)
        .map(field => [field, Math.max(1, corpus.totalFieldLengths[field] / documentCount)]));
    RETRIEVAL_CORPUS_CACHE.set(world, corpus);
    return corpus;
}

function cachedRetrievalCorpus(world) {
    const cached = RETRIEVAL_CORPUS_CACHE.get(world);
    return cached?.revision === retrievalCorpusRevision(world) ? cached : null;
}

function retrievalCorpus(world) {
    const cached = cachedRetrievalCorpus(world);
    if (cached) return cached;
    const corpus = createRetrievalCorpus(world);
    for (const item of corpus.records) addRetrievalCorpusRecord(corpus, item);
    return finalizeRetrievalCorpus(world, corpus);
}

export async function prepareRetrievalCorpus(world, yieldControl = null, isCurrent = () => true) {
    migrateLegacyBeliefs(world);
    if (!world || cachedRetrievalCorpus(world)) return Boolean(world);
    const corpus = createRetrievalCorpus(world);
    for (let index = 0; index < corpus.records.length; index++) {
        if (!isCurrent()) return false;
        addRetrievalCorpusRecord(corpus, corpus.records[index]);
        if (yieldControl && index > 0 && index % 24 === 0) await yieldControl();
    }
    for (let index = 0; index < (world.capsules || []).length; index++) {
        if (!isCurrent()) return false;
        capsulePassageStats(world.capsules[index], corpus);
        if (yieldControl && index > 0 && index % 4 === 0) await yieldControl();
    }
    if (!isCurrent()) return false;
    finalizeRetrievalCorpus(world, corpus);
    return true;
}

function retrievalProfile(world, recentMessages, expandedTerms) {
    const recent = recentMessages || [];
    const latestUser = recent.slice().reverse().find(message => message?.is_user === true)
        || recent[recent.length - 1]
        || {};
    const directText = retrievalMessageText(latestUser);
    const direct = terms(directText, true);
    const speaker = terms(latestUser?.name, true);
    const expandedGroups = (expandedTerms || [])
        .map(value => terms(value))
        .filter(group => group.size);
    const expanded = new Set(expandedGroups.flatMap(group => [...group]));
    const context = terms(recent
        .filter(message => message !== latestUser)
        .map(retrievalMessageText)
        .join(' '));
    const corpus = retrievalCorpus(world);
    const { recordStats, documentFrequency, identityVocabulary } = corpus;
    const identityFocus = new Set([...direct, ...resolvedIdentityTerms(world, [latestUser?.name, directText])]);
    for (const term of speaker) {
        if (queryTermVariants(term, true).some(variant => identityVocabulary.has(variant))) identityFocus.add(term);
    }
    const focus = new Set([...direct, ...expanded]);
    const documentCount = Math.max(1, corpus.records.length);
    const averageFieldLengths = corpus.averageFieldLengths;
    return {
        direct,
        expanded,
        expandedGroups,
        context,
        focus,
        identityFocus,
        documentCount,
        documentFrequency,
        averageFieldLengths,
        recordStats,
        passageStats: corpus.passageStats,
        identityVocabulary,
    };
}

function recency(item) {
    const time = Date.parse(item.updatedAt || item.createdAt || 0);
    if (!Number.isFinite(time)) return 0;
    const days = Math.max(0, (Date.now() - time) / 86400000);
    return Math.max(0, 2 - Math.log10(days + 1));
}

function semanticRank(semanticRanks, category, item) {
    if (!(semanticRanks instanceof Map) || !item?.id) return 0;
    return Number(semanticRanks.get(embeddingRecordKey(category, item.id))) || 0;
}

function inverseDocumentFrequency(profile, term) {
    const documents = Math.max(1, Number(profile.documentCount) || 1);
    const frequency = Math.max(0, Number(profile.documentFrequency?.get(term)) || 0);
    return Math.log(1 + (documents - frequency + 0.5) / (frequency + 0.5));
}

function queryDocumentFrequency(profile, term, includeMorphology = false) {
    const variants = queryTermVariants(term, includeMorphology);
    const exact = Number(profile.documentFrequency?.get(variants[0])) || 0;
    if (exact) return exact;
    return variants.slice(1).reduce((sum, variant) => sum + (Number(profile.documentFrequency?.get(variant)) || 0), 0);
}

function repeatedEvidenceMultiplier(repetition) {
    const count = Math.max(1, Number(repetition) || 1);
    return 1 / Math.sqrt(1 + 0.75 * (count - 1));
}

function bm25fTermScore(stats, profile, term) {
    let weightedFrequency = 0;
    for (const [field, settings] of Object.entries(RETRIEVAL_FIELDS)) {
        const fieldStats = stats.fields[field];
        const frequency = fieldStats.counts.get(term) || 0;
        if (!frequency) continue;
        const averageLength = Math.max(1, profile.averageFieldLengths[field] || 1);
        const normalizedLength = (1 - settings.lengthWeight)
            + settings.lengthWeight * (fieldStats.tokens.length / averageLength);
        weightedFrequency += settings.weight * frequency / Math.max(0.1, normalizedLength);
    }
    if (!weightedFrequency) return 0;
    const morphologyWeight = term.startsWith('~') ? 0.35 : 1;
    return morphologyWeight * inverseDocumentFrequency(profile, term)
        * ((BM25_K1 + 1) * weightedFrequency / (BM25_K1 + weightedFrequency));
}

function queryScore(stats, profile, queryTerms, includeMorphology = false) {
    return [...queryTerms].reduce((score, term) => {
        const variants = queryTermVariants(term, includeMorphology);
        const exact = bm25fTermScore(stats, profile, variants[0]);
        const matched = exact || variants.slice(1).reduce((sum, variant) => sum + bm25fTermScore(stats, profile, variant), 0);
        return score + matched;
    }, 0);
}

function expandedQueryScore(stats, profile) {
    const scores = profile.expandedGroups
        .map(group => {
            const matched = [...group].filter(term => statsHasQueryTerm(stats, term, true));
            const base = queryScore(stats, profile, group, true);
            const coherence = matched.length >= 2
                ? matched.reduce((sum, term) => sum + inverseDocumentFrequency(profile, term), 0)
                    * Math.min(0.3, 0.1 * (matched.length - 1))
                : 0;
            return base + coherence;
        })
        .filter(score => score > 0)
        .sort((left, right) => right - left);
    if (!scores.length) return 0;
    return scores[0] + scores.slice(1).reduce((sum, score) => sum + score * 0.2, 0);
}

function matchingFields(stats, source, includeMorphology = false) {
    const matches = {};
    for (const field of Object.keys(RETRIEVAL_FIELDS)) {
        const fieldMatches = [...source].filter(term => fieldHasQueryTerm(stats.fields[field], term, includeMorphology));
        if (fieldMatches.length) matches[field] = fieldMatches;
    }
    return matches;
}

function orderedPairWithin(tokens, orderedTerms, window = 8) {
    for (let left = 0; left < orderedTerms.length - 1; left++) {
        for (let right = left + 1; right < orderedTerms.length; right++) {
            const first = orderedTerms[left];
            const second = orderedTerms[right];
            for (let index = 0; index < tokens.length; index++) {
                if (tokens[index] !== first) continue;
                const end = Math.min(tokens.length, index + window + 1);
                if (tokens.slice(index + 1, end).includes(second)) return true;
            }
        }
    }
    return false;
}

function orderedCoverageWithin(tokens, orderedTerms, required, window = 10, includeMorphology = false) {
    if (required <= 0) return true;
    for (let queryStart = 0; queryStart < orderedTerms.length; queryStart++) {
        for (let tokenStart = 0; tokenStart < tokens.length; tokenStart++) {
            if (!queryTermVariants(orderedTerms[queryStart], includeMorphology).includes(tokens[tokenStart])) continue;
            let matches = 1;
            let lastQuery = queryStart;
            const end = Math.min(tokens.length, tokenStart + window + 1);
            for (let tokenIndex = tokenStart + 1; tokenIndex < end; tokenIndex++) {
                const nextQuery = orderedTerms.findIndex((term, index) => index > lastQuery
                    && queryTermVariants(term, includeMorphology).includes(tokens[tokenIndex]));
                if (nextQuery < 0) continue;
                matches++;
                lastQuery = nextQuery;
                if (matches >= required) return true;
            }
        }
    }
    return false;
}

function coherentConceptMatch(stats, profile, groups) {
    return groups.some(group => {
        const ordered = [...group];
        const identityMatches = ordered.filter(term => fieldHasQueryTerm(stats.fields.identity, term, true));
        const globalIdentityTerms = ordered.filter(term => queryTermVariants(term, true)
            .some(variant => profile.identityVocabulary.has(variant)));
        const structuredIdentityMatches = ordered.filter(term => fieldHasQueryTerm(stats.fields.identity, term, true)
            || fieldHasQueryTerm(stats.fields.anchor, term, true));
        const anchored = new Set([...identityMatches, ...globalIdentityTerms]);
        const independentHeading = ordered.filter(term => fieldHasQueryTerm(stats.fields.heading, term, true) && !anchored.has(term));
        const independentBody = ordered.filter(term => fieldHasQueryTerm(stats.fields.body, term, true) && !anchored.has(term));
        const independentContent = new Set([...independentHeading, ...independentBody]);
        const requiredCoverage = Math.max(2, Math.ceil(ordered.length * 0.6), globalIdentityTerms.length >= 2 ? 3 : 0);
        const requiredContent = globalIdentityTerms.length >= 2 && ordered.length > 3 ? 2 : 1;
        const identityPairRequired = globalIdentityTerms.length >= 2;
        const structuredIdentityCount = new Set(structuredIdentityMatches).size;
        const fieldKeepsIdentityPair = field => !identityPairRequired
            || structuredIdentityMatches.length >= 2
            || globalIdentityTerms.filter(term => fieldHasQueryTerm(field, term, true)).length >= 2;
        return (independentHeading.length >= requiredContent
                && fieldKeepsIdentityPair(stats.fields.heading)
                && orderedCoverageWithin(stats.fields.heading.tokens, ordered, requiredCoverage, 10, true))
            || (independentBody.length >= requiredContent
                && fieldKeepsIdentityPair(stats.fields.body)
                && orderedCoverageWithin(stats.fields.body.tokens, ordered, requiredCoverage, 10, true))
            || (structuredIdentityCount >= 1 && independentContent.size >= 3)
            || independentContent.size >= 4;
    });
}

function compactConceptMatch(stats, profile, groups) {
    const phraseOrRareMatch = groups.some(group => {
        if (group.size > 2) return false;
        const ordered = [...group];
        if (ordered.length === 1) {
            const [term] = ordered;
            const rareLimit = Math.max(4, Math.ceil(profile.documentCount * 0.005));
            const frequency = queryDocumentFrequency(profile, term, true);
            return !queryTermVariants(term, true).some(variant => profile.identityVocabulary.has(variant))
                && (fieldHasQueryTerm(stats.fields.heading, term, true) || fieldHasQueryTerm(stats.fields.body, term, true))
                && frequency > 0
                && frequency <= rareLimit
                && inverseDocumentFrequency(profile, term) > 0;
        }
        if (orderedCoverageWithin(stats.fields.heading.tokens, ordered, 2, 10, true)) return true;
        const anchorCount = ordered.filter(term => profile.identityVocabulary.has(term)).length;
        if (anchorCount === ordered.length) return false;
        return orderedCoverageWithin(stats.fields.body.tokens, ordered, 2, 10, true)
            || (ordered.some(term => fieldHasQueryTerm(stats.fields.identity, term, true))
                && ordered.some(term => !profile.identityVocabulary.has(term)
                    && (fieldHasQueryTerm(stats.fields.heading, term, true) || fieldHasQueryTerm(stats.fields.body, term, true))));
    });
    if (phraseOrRareMatch) return true;

    const singletonTerms = groups.filter(group => group.size === 1).flatMap(group => [...group]);
    const structuredIdentityMatches = singletonTerms.filter(term => queryTermVariants(term, true)
        .some(variant => profile.identityVocabulary.has(variant))
        && (fieldHasQueryTerm(stats.fields.identity, term, true) || fieldHasQueryTerm(stats.fields.anchor, term, true)));
    const contentMatches = singletonTerms.filter(term => !queryTermVariants(term, true)
        .some(variant => profile.identityVocabulary.has(variant))
        && (fieldHasQueryTerm(stats.fields.heading, term, true) || fieldHasQueryTerm(stats.fields.body, term, true)));
    return (structuredIdentityMatches.length >= 2 && contentMatches.length >= 1)
        || (structuredIdentityMatches.length >= 1 && contentMatches.length >= 2)
        || contentMatches.length >= 3;
}

function directConceptMatch(stats, profile, category = '') {
    const ordered = [...profile.direct];
    const concepts = ordered.filter(term => !profile.identityVocabulary.has(term));
    const surfaceConcepts = concepts.filter(term => !term.startsWith('~'));
    const matchedHeading = concepts.filter(term => stats.fields.heading.unique.has(term));
    const matchedBody = concepts.filter(term => stats.fields.body.unique.has(term));
    const matchedSurfaceHeading = surfaceConcepts.filter(term => stats.fields.heading.unique.has(term));
    const matchedSurfaceBody = surfaceConcepts.filter(term => stats.fields.body.unique.has(term));
    const allSurfaceHeadingMatches = ordered.filter(term => !term.startsWith('~')
        && stats.fields.heading.unique.has(term));
    const identityMatch = ordered.some(term => stats.fields.identity.unique.has(term));
    const anchorMatch = ordered.some(term => stats.fields.anchor.unique.has(term));
    const anchoredContentMatch = matchedHeading.length > 0
        || orderedPairWithin(stats.fields.body.tokens, matchedSurfaceBody)
        || matchedBody.some(term => term.startsWith('~'))
        || [...matchedHeading, ...matchedBody].some(term => (profile.documentFrequency.get(term) || 0) <= 3);
    if (category === 'state' && identityMatch && (matchedHeading.length || matchedBody.length)) return true;
    if ((identityMatch || anchorMatch) && anchoredContentMatch) return true;
    if (surfaceConcepts.length <= 1 && matchedHeading.length) return true;
    if (orderedPairWithin(stats.fields.heading.tokens, allSurfaceHeadingMatches)) return true;
    if (surfaceConcepts.length <= 2 && (matchedHeading.length || matchedBody.length)) return true;
    const maximumSingleMatchFrequency = surfaceConcepts.length <= 1 ? 3 : 1;
    if ([...matchedHeading, ...matchedBody].some(term => (profile.documentFrequency.get(term) || 0) <= maximumSingleMatchFrequency
        && inverseDocumentFrequency(profile, term) >= 1.25)) return true;
    return orderedPairWithin(stats.fields.heading.tokens, matchedSurfaceHeading)
        || orderedPairWithin(stats.fields.body.tokens, matchedSurfaceBody);
}

function rank(items, query, extra = () => 0, category = '', semanticRanks = new Map()) {
    const profile = query?.focus instanceof Set
        ? query
        : {
            direct: query,
            expanded: new Set(),
            expandedGroups: [],
            context: new Set(),
            focus: query,
            identityFocus: query,
            documentCount: 1,
            documentFrequency: new Map([...query].map(term => [term, 1])),
            averageFieldLengths: Object.fromEntries(Object.keys(RETRIEVAL_FIELDS).map(field => [field, 1])),
            recordStats: new Map(),
            passageStats: new Map(),
            identityVocabulary: new Set(),
        };
    const prepared = (items || []).map((item, index) => {
        const stats = profile.recordStats.get(item) || retrievalFieldStats(item);
        const matchingTerms = (source, includeMorphology = false) => [...source]
            .filter(term => statsHasQueryTerm(stats, term, includeMorphology));
        const directMatches = matchingTerms(profile.direct);
        const expandedMatches = matchingTerms(profile.expanded, true);
        const contextMatches = matchingTerms(profile.context);
        const focusMatches = new Set([...directMatches, ...expandedMatches]);
        const directFields = matchingFields(stats, profile.direct);
        const directIdentityFields = matchingFields(stats, profile.identityFocus || profile.direct);
        const expandedFields = matchingFields(stats, profile.expanded, true);
        const directMatch = directConceptMatch(stats, profile, category);
        const coherentMatch = coherentConceptMatch(stats, profile, profile.expandedGroups);
        const compactMatch = compactConceptMatch(stats, profile, profile.expandedGroups);
        const localizedPassages = category === 'capsule' ? capsulePassageStats(item, profile) : [];
        const passageDirectMatch = category === 'capsule'
            ? localizedPassages.some(passage => directConceptMatch(passage, profile, category))
            : directMatch;
        const passageExpandedMatch = category === 'capsule'
            ? localizedPassages.some(passage => coherentConceptMatch(passage, profile, profile.expandedGroups)
                || compactConceptMatch(passage, profile, profile.expandedGroups))
            : coherentMatch || compactMatch;
        const directIdentityMatches = new Set(directIdentityFields.identity || []);
        const directPairedIdentityMatch = pairedIdentityMatch(item, profile.identityFocus || profile.direct);
        const expandedPairedIdentityMatch = profile.expandedGroups
            .some(group => pairedIdentityMatch(item, group, true));
        const expandedRelationshipMatch = profile.expandedGroups.some(group => {
            const paired = pairedIdentityMatch(item, group, true);
            if (!paired) return false;
            const content = [...group].filter(term => !queryTermVariants(term, true)
                .some(variant => profile.identityVocabulary.has(variant)));
            return content.length === 0 || content.some(term => fieldHasQueryTerm(stats.fields.heading, term, true)
                || fieldHasQueryTerm(stats.fields.body, term, true));
        });
        const canonicalIdentityName = [...terms(item?.name)];
        const aliasIdentityNames = (item?.aliases || [])
            .map(value => [...terms(value)])
            .filter(nameTerms => nameTerms.length);
        const expandedEntityMatch = profile.expandedGroups.some(group => {
            const identityMatchCount = [...group]
                .filter(term => fieldHasQueryTerm(stats.fields.identity, term, true)).length;
            const coversName = nameTerms => nameTerms.length > 0 && nameTerms
                .every(nameTerm => [...group].some(term => queryTermVariants(term, true).includes(nameTerm)));
            const coversCanonicalName = coversName(canonicalIdentityName);
            const coveredAlias = aliasIdentityNames.find(coversName);
            const conciseAliasMention = coveredAlias && group.size <= coveredAlias.length + 1;
            return group.size === 1
                ? identityMatchCount === 1
                : identityMatchCount >= 2 || coversCanonicalName || conciseAliasMention;
        });
        const directIdentityCentral = (category === 'entity' && directIdentityMatches.size > 0)
            || (category === 'relationship' && directPairedIdentityMatch)
            || (isAddressFact(item) && directPairedIdentityMatch);
        const expandedIdentityCentral = (category === 'entity' && expandedEntityMatch)
            || (category === 'relationship' && expandedRelationshipMatch)
            || (isAddressFact(item) && expandedPairedIdentityMatch);
        const matches = focusMatches.size;
        const directScore = queryScore(stats, profile, profile.direct);
        const expandedScore = expandedQueryScore(stats, profile);
        const addressDirectContentMatch = isAddressFact(item) && (directFields.body || []).length > 0;
        const addressExpandedContentMatch = isAddressFact(item) && (expandedFields.body || []).length > 0;
        const directEligible = isAddressFact(item)
            ? directPairedIdentityMatch || (directMatch && addressDirectContentMatch)
            : passageDirectMatch || directIdentityCentral;
        const expandedEligible = isAddressFact(item)
            ? (coherentMatch || compactMatch) && addressExpandedContentMatch
            : passageExpandedMatch || expandedIdentityCentral;
        const eligible = directEligible || expandedEligible;
        const directContentMatches = directMatches.filter(term => !queryTermVariants(term, true)
            .some(variant => profile.identityVocabulary.has(variant)));
        const weakDirectEvidenceKey = directEligible
            && !directIdentityCentral
            && !expandedEligible
            && directContentMatches.length === 1
            && queryDocumentFrequency(profile, directContentMatches[0], true) > 3
            ? directContentMatches[0]
            : '';
        const metadataScore = (Number(item.importance) || 3) + recency(item) + extra(item);
        const localScore = Math.max(directScore, expandedScore)
            + Math.min(1.5, contextMatches.length * 0.15)
            + metadataScore * 0.01
            - index * 0.000001;
        return {
            item,
            matches,
            matchedTerms: [...focusMatches],
            directMatches,
            expandedMatches,
            contextMatches,
            matchedFields: {
                direct: directFields,
                aiExpanded: expandedFields,
            },
            eligible,
            directEligible,
            expandedEligible,
            passageLocalized: category === 'capsule',
            weakDirectEvidenceKey,
            directDiminishingMultiplier: 1,
            directScore,
            expandedScore,
            localScore,
            semanticRank: semanticRank(semanticRanks, category, item),
        };
    });
    const sourceRanks = (scoreKey, eligibilityKey) => new Map(prepared
        .filter(result => result[eligibilityKey] && result[scoreKey] > 0)
        .sort((left, right) => right[scoreKey] - left[scoreKey] || right.localScore - left.localScore)
        .map((result, index) => [result.item, index + 1]));
    const directRanks = sourceRanks('directScore', 'directEligible');
    const expandedRanks = sourceRanks('expandedScore', 'expandedEligible');
    const repeatedDirectEvidence = new Map();
    const directOrder = prepared
        .filter(result => result.directEligible && result.directScore > 0)
        .sort((left, right) => right.directScore - left.directScore || right.localScore - left.localScore);
    for (const result of directOrder) {
        if (!result.weakDirectEvidenceKey) continue;
        const repetition = (repeatedDirectEvidence.get(result.weakDirectEvidenceKey) || 0) + 1;
        repeatedDirectEvidence.set(result.weakDirectEvidenceKey, repetition);
        result.directDiminishingMultiplier = repeatedEvidenceMultiplier(repetition);
    }
    for (const result of prepared) {
        result.directRank = directRanks.get(result.item) || 0;
        result.expandedRank = expandedRanks.get(result.item) || 0;
        const directRrf = result.directRank
            ? result.directDiminishingMultiplier / (RRF_OFFSET + result.directRank)
            : 0;
        const expandedRrf = result.expandedRank ? 1 / (RRF_OFFSET + result.expandedRank) : 0;
        const semanticRrf = result.semanticRank > 0 ? 1 / (RRF_OFFSET + result.semanticRank) : 0;
        result.score = (directRrf + expandedRrf + semanticRrf) * 1000 + result.localScore * 0.01;
    }
    return prepared.sort((a, b) => b.score - a.score);
}

function matching(items, query, extra = () => 0, category = '', semanticRanks = new Map()) {
    return rank(items, query, extra, category, semanticRanks)
        .filter(result => result.eligible || result.semanticRank > 0);
}

function limitRelationshipPairs(results, maximumPerPair = 1) {
    const counts = new Map();
    return results.filter(result => {
        const item = result?.item || result;
        const key = [plain(item?.from).toLocaleLowerCase(), plain(item?.to).toLocaleLowerCase()]
            .sort()
            .join('\u0000');
        const count = counts.get(key) || 0;
        if (!key || count >= maximumPerPair) return false;
        counts.set(key, count + 1);
        return true;
    });
}

function memorySourceRanges(item) {
    const ranges = Array.isArray(item?.sources) ? item.sources : [];
    if (ranges.length) return ranges;
    if (item?.chatKey && Number.isFinite(Number(item?.from)) && Number.isFinite(Number(item?.to))) {
        return [{ chatKey: item.chatKey, from: Number(item.from), to: Number(item.to) }];
    }
    return [];
}

function sharesSourceRange(left, right) {
    return memorySourceRanges(left).some(first => overlapsSourceRange(right, first));
}

function overlapsSourceRange(item, range) {
    return memorySourceRanges(item).some(source =>
        source.chatKey === range?.chatKey
        && Number(source.from) <= Number(range?.to)
        && Number(range?.from) <= Number(source.to));
}

function referencedMemoryIds(item) {
    return new Set([
        ...(item?.capsuleIds || []),
        ...(item?.arcIds || []),
        item?.temporal?.referenceId,
        item?.temporalAnchorId,
    ].filter(Boolean));
}

function supportIdentityReferences(stats, profile) {
    return new Set([...stats.all].filter(term => !term.startsWith('~') && profile.identityVocabulary.has(term)));
}

function supportConceptTerms(stats, profile) {
    const frequencyLimit = Math.max(6, Math.ceil(profile.documentCount * 0.04));
    const bodyTokens = stats.fields.body.tokens;
    // Long summaries can contain an entire arc's vocabulary. Sample both ends
    // so they contribute distinctive anchors without becoming universal links.
    return new Set([...stats.fields.heading.unique, ...bodyTokens.slice(0, 96), ...bodyTokens.slice(-32)]
        .filter(term => !term.startsWith('~'))
        .filter(term => !profile.identityVocabulary.has(term))
        .filter(term => {
            const frequency = Number(profile.documentFrequency.get(term)) || 0;
            return frequency > 0 && frequency <= frequencyLimit && inverseDocumentFrequency(profile, term) >= 1.25;
        }));
}

function supportMetadata(item, profile) {
    const cached = profile.supportMetadata?.get(item);
    if (cached) return cached;
    const stats = profile.recordStats.get(item) || retrievalFieldStats(item);
    const metadata = {
        stats,
        identities: supportIdentityReferences(stats, profile),
        concepts: supportConceptTerms(stats, profile),
        references: referencedMemoryIds(item),
    };
    if (!profile.supportMetadata) profile.supportMetadata = new Map();
    profile.supportMetadata.set(item, metadata);
    return metadata;
}

function supportConnection(seed, candidate, profile) {
    const seedMetadata = supportMetadata(seed, profile);
    const candidateStats = profile.recordStats.get(candidate) || retrievalFieldStats(candidate);
    const seedIdentities = seedMetadata.identities;
    const seedConcepts = seedMetadata.concepts;
    const sharedIdentities = [...seedIdentities].filter(term => candidateStats.all.has(term));
    const sharedConcepts = [...seedConcepts].filter(term =>
        candidateStats.fields.heading.unique.has(term) || candidateStats.fields.body.unique.has(term));
    const contextFrequencyLimit = Math.max(4, Math.ceil(profile.documentCount * 0.02));
    const sharedContext = [...profile.context]
        .filter(term => !term.startsWith('~') && !profile.identityVocabulary.has(term))
        .filter(term => {
            const frequency = Number(profile.documentFrequency.get(term)) || 0;
            return frequency > 0 && frequency <= contextFrequencyLimit && inverseDocumentFrequency(profile, term) >= 1.25;
        })
        .filter(term => candidateStats.fields.heading.unique.has(term) || candidateStats.fields.body.unique.has(term));
    const sourceLinked = sharesSourceRange(seed, candidate);
    const seedReferences = seedMetadata.references;
    const candidateReferences = referencedMemoryIds(candidate);
    const hierarchyLinked = seedReferences.has(candidate?.id)
        || candidateReferences.has(seed?.id)
        || [...seedReferences].some(id => candidateReferences.has(id));
    const contextBridged = sharedIdentities.length >= 2 && sharedContext.length >= 1;
    const qualifies = (sharedIdentities.length >= 2 && sharedConcepts.length >= 1)
        || (sharedIdentities.length >= 1 && sharedConcepts.length >= 2)
        || sharedConcepts.length >= 3
        || contextBridged
        || ((sourceLinked || hierarchyLinked) && (sharedIdentities.length >= 1 || sharedConcepts.length >= 1));
    if (!qualifies) return null;
    const conceptScore = sharedConcepts.reduce((sum, term) => sum + inverseDocumentFrequency(profile, term), 0);
    const contextScore = sharedContext.reduce((sum, term) => sum + inverseDocumentFrequency(profile, term), 0);
    return {
        score: conceptScore
            + contextScore * 0.75
            + sharedIdentities.length * 1.5
            + (sourceLinked ? 12 : 0)
            + (hierarchyLinked ? 10 : 0),
        matchedTerms: [...new Set([...sharedIdentities, ...sharedConcepts, ...sharedContext])],
        sharedIdentities,
        sharedConcepts,
        sharedContext,
        sourceLinked,
        hierarchyLinked,
        contextBridged,
    };
}

function queryEvidenceConfidence(selection, profile) {
    const item = selection?.item;
    const result = selection?.result || {};
    const stats = profile.recordStats.get(item) || retrievalFieldStats(item);
    const isIdentityTerm = term => queryTermVariants(term, true)
        .some(variant => profile.identityVocabulary.has(variant));
    const contentMatch = term => fieldHasQueryTerm(stats.fields.heading, term, true)
        || fieldHasQueryTerm(stats.fields.body, term, true);
    const identityMatch = term => fieldHasQueryTerm(stats.fields.identity, term, true)
        || fieldHasQueryTerm(stats.fields.anchor, term, true);
    const evidenceQuality = source => {
        const surface = [...source].filter(term => !term.startsWith('~'));
        const concepts = surface.filter(term => !isIdentityTerm(term));
        if (!concepts.length) return 0;
        const identities = surface.filter(isIdentityTerm);
        const totalWeight = concepts.reduce((sum, term) => sum + inverseDocumentFrequency(profile, term), 0);
        const matched = concepts.filter(contentMatch);
        const matchedWeight = matched.reduce((sum, term) => sum + inverseDocumentFrequency(profile, term), 0);
        const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
        const evidenceMass = 1 - Math.exp(-matchedWeight / 4);
        const identityCoverage = identities.length
            ? identities.filter(identityMatch).length / identities.length
            : 0;
        return Math.min(1, coverage * 0.65 + evidenceMass * 0.25 + identityCoverage * 0.1);
    };
    const direct = evidenceQuality(profile.direct);
    const expanded = Math.max(0, ...profile.expandedGroups.map(evidenceQuality));
    const semantic = result.semanticRank > 0 ? 1 / Math.sqrt(result.semanticRank) : 0;
    return Math.min(1, Math.max(direct, expanded, semantic));
}

function retainSupportForSeed(seedSelection, ranked, profile, depthScale = 1) {
    if (!ranked.length) return [];
    const seedConfidence = queryEvidenceConfidence(seedSelection, profile);
    const indirectRelationship = seedSelection.category === 'relationship'
        && !seedSelection.result?.directEligible
        && !(seedSelection.result?.semanticRank > 0);
    // An AI-expanded relationship can be useful even when the user's short
    // prompt does not name it. Let it recover a little surrounding history,
    // but require every supporting record to independently match the expanded
    // query or a rare bridge from recent context. A shared source alone is not
    // enough. This avoids turning an AI-assigned importance value into a hard
    // retrieval decision.
    const eligibleRanked = indirectRelationship
        ? ranked.filter(result => queryEvidenceConfidence({ item: result.item, result }, profile) >= 0.2
            || result.connection.contextBridged)
        : ranked;
    if (!eligibleRanked.length) return [];
    // A weak primary may remain useful on its own, but it should not unlock a
    // large historical neighborhood. Stronger query evidence earns a wider,
    // still finite supporting envelope.
    const evidenceQuota = seedConfidence > 0 ? 1 + Math.round(seedConfidence * 6 * depthScale) : 0;
    const generalQuota = indirectRelationship ? Math.min(2, evidenceQuota) : evidenceQuota;
    const sourceQuota = indirectRelationship ? 0 : Math.min(
        Math.ceil(generalQuota / 2),
        Math.max(0, Math.round(seedConfidence * 3.5 * depthScale)),
    );
    if (!generalQuota && !sourceQuota) return [];

    const byId = new Map();
    const sourcePreferred = memorySourceRanges(seedSelection.item)
        .flatMap(range => eligibleRanked.filter(result => overlapsSourceRange(result.item, range)).slice(0, 2));
    for (const result of sourcePreferred) {
        if (byId.size >= sourceQuota || byId.has(result.item.id)) continue;
        byId.set(result.item.id, {
            ...result,
            seedConfidence,
            supportMarginalScore: seedConfidence,
            supportRank: ranked.indexOf(result) + 1,
        });
    }

    const bestPriority = Math.max(0.0001, eligibleRanked[0].priority);
    for (let index = 0; index < eligibleRanked.length && byId.size < generalQuota; index++) {
        const result = eligibleRanked[index];
        if (byId.has(result.item.id)) continue;
        const connectionStrength = 1 - Math.exp(-result.connection.score / 10);
        const queryRelevance = queryEvidenceConfidence({ item: result.item, result }, profile);
        const relativePriority = Math.min(1, result.priority / bestPriority);
        const depthDecay = 1 / Math.sqrt(1 + index * 0.3);
        const marginal = seedConfidence
            * (connectionStrength * 0.55 + queryRelevance * 0.2 + relativePriority * 0.25)
            * depthDecay;
        if (marginal < 0.14 || relativePriority < 0.25) continue;
        byId.set(result.item.id, {
            ...result,
            seedConfidence,
            supportMarginalScore: marginal,
            supportRank: index + 1,
        });
    }
    return [...byId.values()];
}

function line(label, value) {
    const body = plain(value);
    return body ? `- ${label}: ${body}` : '';
}

function recordSourceRanges(item) {
    const direct = item?.chatKey && Number.isFinite(Number(item.from)) && Number.isFinite(Number(item.to))
        ? [{ chatKey: item.chatKey, from: Number(item.from), to: Number(item.to) }]
        : [];
    return [...direct, ...(item?.sources || [])]
        .filter(source => source?.chatKey
            && Number.isFinite(Number(source.from))
            && Number.isFinite(Number(source.to)))
        .map(source => ({ chatKey: source.chatKey, from: Number(source.from), to: Number(source.to) }));
}

const STORY_MONTHS = new Map([
    ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
    ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
]);
const STORY_MONTH_PATTERN = [...STORY_MONTHS.keys()].join('|');

function storyTimeMinutes(value) {
    const match = String(value || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
    if (match) {
        let hour = Number(match[1]) % 12;
        if (match[3].toLocaleLowerCase() === 'pm') hour += 12;
        return hour * 60 + Number(match[2] || 0);
    }
    const periods = [['dawn', 360], ['morning', 540], ['noon', 720], ['afternoon', 900], ['evening', 1080], ['night', 1200]];
    return periods.find(([period]) => new RegExp(`\\b${period}\\b`, 'i').test(value))?.[1] || 0;
}

function storyDateKey(item) {
    // Parse only date forms Continuity already stores; ambiguous prose stays on
    // the source-order fallback instead of pretending to know its story time.
    const source = plain(item?.storyTime).toLocaleLowerCase().replace(/[—–]/g, '-');
    if (!source) return null;
    const frame = plain(item?.temporal?.frame || 'main narrative').toLocaleLowerCase();
    const minutes = storyTimeMinutes(source);
    const key = (year, month = 1, day = 1) => year * 372 * 1440 + month * 31 * 1440 + day * 1440 + minutes;
    let match = source.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[1]), Number(match[2]), Number(match[3])) };
    match = source.match(/\b(\d{1,2})([./])(\d{1,2})\2(\d{4}|xxxx)\b/i);
    if (match) {
        const dotted = match[2] === '.';
        const month = Number(match[dotted ? 3 : 1]);
        const day = Number(match[dotted ? 1 : 3]);
        if (match[4].toLocaleLowerCase() === 'xxxx') return { family: `${frame}|yearless-calendar`, value: key(0, month, day) };
        return { family: `${frame}|calendar`, value: key(Number(match[4]), month, day) };
    }
    match = source.match(new RegExp(`\\b(\\d{1,2})\\s+(${STORY_MONTH_PATTERN})\\s*-\\s*(?:early|mid|late)?\\s*(${STORY_MONTH_PATTERN})\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[4]), STORY_MONTHS.get(match[2]), Number(match[1])) };
    match = source.match(new RegExp(`\\b(\\d{1,2})(?:\\s*-\\s*\\d{1,2})?\\s+(${STORY_MONTH_PATTERN})\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[3]), STORY_MONTHS.get(match[2]), Number(match[1])) };
    match = source.match(new RegExp(`\\b(?:early|mid|late)?\\s*(${STORY_MONTH_PATTERN})\\s*-\\s*(?:early|mid|late)?\\s*(${STORY_MONTH_PATTERN})\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[3]), STORY_MONTHS.get(match[1])) };
    match = source.match(new RegExp(`\\b(${STORY_MONTH_PATTERN})(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,)?\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[3]), STORY_MONTHS.get(match[1]), Number(match[2] || 1)) };
    match = source.match(/\b(?:rp\s*)?day\s+(\d+)\b/i);
    if (match) return { family: `${frame}|numbered-day`, value: Number(match[1]) * 1440 + minutes };
    match = source.match(/\b(spring|summer|autumn|fall|winter)\s+(\d{4})\b/i);
    if (match) {
        const seasonMonth = { spring: 3, summer: 6, autumn: 9, fall: 9, winter: 12 }[match[1]];
        return { family: `${frame}|calendar`, value: key(Number(match[2]), seasonMonth) };
    }
    match = source.match(new RegExp(`\\b(\\d{1,2})\\s+(${STORY_MONTH_PATTERN})\\b`, 'i'));
    if (match) return { family: `${frame}|yearless-calendar`, value: key(0, STORY_MONTHS.get(match[2]), Number(match[1])) };
    match = source.match(/\b(\d{4})\b/);
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[1])) };
    return null;
}

function eventSourcePosition(item, chatKey) {
    const ranges = recordSourceRanges(item);
    const preferred = chatKey ? ranges.filter(source => source.chatKey === chatKey) : ranges;
    const candidates = preferred.length ? preferred : ranges;
    const first = candidates.sort((a, b) => a.from - b.from || a.to - b.to || a.chatKey.localeCompare(b.chatKey))[0];
    return first ? [first.chatKey === chatKey ? 0 : 1, first.from, first.to, first.chatKey] : [2, 0, 0, ''];
}

function addTemporalRelation(graph, subject, reference, relation) {
    if (!subject || !reference || subject === reference) return;
    const edge = (from, to) => {
        if (!graph.has(from)) graph.set(from, new Set());
        if (!graph.has(to)) graph.set(to, new Set());
        graph.get(from).add(to);
    };
    if (relation === 'after') edge(reference, subject);
    else if (relation === 'before') edge(subject, reference);
    else if (relation === 'same-period' || relation === 'overlaps') {
        edge(reference, subject);
        edge(subject, reference);
    }
}

function orderUndatedEventsByRelations(entries, capsules) {
    if (entries.length < 2) return entries;
    const graph = new Map();
    for (const capsule of capsules || []) {
        addTemporalRelation(
            graph,
            plain(capsule?.temporal?.anchorId),
            plain(capsule?.temporal?.referenceId),
            capsule?.temporal?.relation,
        );
    }
    const eventNodes = entries.map((entry, index) => `selected-event:${index}`);
    entries.forEach((entry, index) => addTemporalRelation(
        graph,
        eventNodes[index],
        plain(entry.item?.temporal?.referenceId),
        entry.item?.temporal?.relation,
    ));
    const reachable = eventNodes.map(start => {
        const found = new Set();
        const pending = [start];
        while (pending.length) {
            const current = pending.pop();
            for (const next of graph.get(current) || []) {
                if (found.has(next)) continue;
                found.add(next);
                pending.push(next);
            }
        }
        return found;
    });
    const edges = entries.map(() => new Set());
    const indegree = entries.map(() => 0);
    for (let left = 0; left < entries.length; left++) {
        for (let right = left + 1; right < entries.length; right++) {
            const leftBefore = reachable[left].has(eventNodes[right]);
            const rightBefore = reachable[right].has(eventNodes[left]);
            if (leftBefore === rightBefore) continue;
            const [from, to] = leftBefore ? [left, right] : [right, left];
            edges[from].add(to);
            indegree[to]++;
        }
    }
    const remaining = new Set(entries.map((_, index) => index));
    const result = [];
    while (remaining.size) {
        const next = [...remaining]
            .filter(index => indegree[index] === 0)
            .sort((a, b) => entries[a].sourceIndex - entries[b].sourceIndex)[0];
        if (next === undefined) return entries;
        remaining.delete(next);
        result.push(entries[next]);
        for (const target of edges[next]) indegree[target]--;
    }
    return result;
}

export function orderEventsChronologically(items, chatKey = '', capsules = []) {
    const ordered = (items || []).map((item, selectionIndex) => ({ item, selectionIndex, date: storyDateKey(item) }))
        .sort((left, right) => {
            const a = eventSourcePosition(left.item, chatKey);
            const b = eventSourcePosition(right.item, chatKey);
            return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3])
                || String(left.item.createdAt || '').localeCompare(String(right.item.createdAt || ''))
                || String(left.item.id || '').localeCompare(String(right.item.id || ''))
                || left.selectionIndex - right.selectionIndex;
        });
    ordered.forEach((entry, sourceIndex) => { entry.sourceIndex = sourceIndex; });
    // The extractor already records each event relative to its containing L1,
    // and each L1 relative to the previous anchor. Use that partial order for
    // undated events; unknown, detached, and contradictory relations retain
    // their source-message order.
    const undatedSlots = ordered.map((entry, index) => entry.date ? null : index).filter(index => index !== null);
    const temporallyOrdered = orderUndatedEventsByRelations(undatedSlots.map(index => ordered[index]), capsules);
    undatedSlots.forEach((slot, index) => { ordered[slot] = temporallyOrdered[index]; });
    // Dated records reorder only the slots occupied by comparable dated records.
    // This keeps undated events anchored to their reliable source-message order.
    const families = new Map();
    for (let index = 0; index < ordered.length; index++) {
        const date = ordered[index].date;
        if (!date) continue;
        const entries = families.get(date.family) || [];
        entries.push({ index, record: ordered[index] });
        families.set(date.family, entries);
    }
    for (const entries of families.values()) {
        const records = entries.map(entry => entry.record)
            .sort((a, b) => a.date.value - b.date.value || a.sourceIndex - b.sourceIndex);
        entries.forEach((entry, index) => { ordered[entry.index] = records[index]; });
    }
    return ordered.map(entry => entry.item);
}

function sourcedFromInvalidExtraction(item, invalidRanges) {
    // Reviewed corrections remain authoritative even when their historical
    // source range is awaiting repair.
    if (item?.correctionId || !invalidRanges.length) return false;
    return recordSourceRanges(item).some(source => invalidRanges.some(invalid =>
        source.chatKey === invalid.chatKey
        && source.from <= invalid.to
        && source.to >= invalid.from));
}

function addFairSections(parts, sections, budget) {
    const populated = sections
        .map(section => ({ ...section, rows: section.rows.filter(Boolean) }))
        .filter(section => section.rows.length > 0);
    if (!populated.length) return;

    // The recall allowance is a soft packing target, not a text-cutting
    // boundary. Give every populated section one complete representative first;
    // this may cross the target when that is the only way to preserve both the
    // category and its record. Then spend any remaining allowance on complete
    // rows in fair rounds. A row is always atomic: it is included whole or left
    // for a later retrieval.
    const closingSize = estimatedTokens('</continuity>');
    const available = budget - estimatedTokens(parts.value) - closingSize;
    const selected = populated.map(section => [section.rows[0]]);
    const mandatorySize = populated.reduce((total, section) => total
        + estimatedTokens(`\n${section.title}:\n`)
        + estimatedTokens(`${section.rows[0]}\n`), 0);
    let remaining = available - mandatorySize;

    if (remaining > 0) {
        const nextRows = populated.map(() => 1);
        const blocked = populated.map(() => false);
        let added = true;
        while (remaining > 0 && added) {
            added = false;
            for (let index = 0; index < populated.length; index++) {
                if (blocked[index]) continue;
                const row = populated[index].rows[nextRows[index]];
                if (!row) {
                    blocked[index] = true;
                    continue;
                }
                const rowSize = estimatedTokens(`${row}\n`);
                if (rowSize > remaining) {
                    // Preserve ranking within a section: do not skip a larger,
                    // better-ranked row to admit one of its lower-ranked rows.
                    blocked[index] = true;
                    continue;
                }
                selected[index].push(row);
                nextRows[index]++;
                remaining -= rowSize;
                added = true;
            }
        }
    }

    for (let index = 0; index < populated.length; index++) {
        parts.value += `\n${populated[index].title}:\n${selected[index].map(row => `${row}\n`).join('')}`;
    }
}

export function buildMemoryPrompt(world, recentMessages, budgetTokens = 2500, chatKey = '', expandedTerms = [], injectionInstruction = DEFAULT_INJECTION_INSTRUCTION, semanticRanks = new Map(), options = {}) {
    migrateLegacyBeliefs(world);
    if (!world) return { prompt: '', estimatedTokens: 0 };
    const semanticAnchors = [...terms(embeddingAnchorText(world, semanticRanks))];
    const queryTerms = retrievalProfile(world, recentMessages, [...(expandedTerms || []), ...semanticAnchors]);
    const retrievalDiagnostics = {
        query: {
            direct: [...queryTerms.direct],
            aiExpanded: [...queryTerms.expanded],
            aiExpandedGroups: queryTerms.expandedGroups.map(group => [...group]),
        },
        selections: [],
    };
    const selectedMemoryRecords = [];
    const diagnosticLabel = item => plain(
        item?.title
        || item?.name
        || item?.topic
        || (item?.predicate ? `${item?.subject || ''} — ${item.predicate}` : '')
        || (item?.attribute ? `${item?.subject || ''} — ${item.attribute}` : '')
        || (item?.from || item?.to ? `${item?.from || '?'} ↔ ${item?.to || '?'}${item?.kind ? ` (${item.kind})` : ''}` : '')
        || item?.subject
        || item?.id,
    );
    const recordSelections = (section, category, results, reason = '') => {
        for (const result of results) {
            const item = result?.item || result;
            if (item?.id) selectedMemoryRecords.push({ section, category, item, result, reason });
            retrievalDiagnostics.selections.push({
                section,
                category,
                id: item?.id || null,
                label: diagnosticLabel(item),
                matchedTerms: result?.matchedTerms || [],
                directMatches: result?.directMatches || [],
                aiExpandedMatches: result?.expandedMatches || [],
                contextMatches: result?.contextMatches || [],
                matchedFields: result?.matchedFields || {},
                directScore: Number.isFinite(result?.directScore) ? Number(result.directScore.toFixed(4)) : null,
                aiExpandedScore: Number.isFinite(result?.expandedScore) ? Number(result.expandedScore.toFixed(4)) : null,
                directRank: result?.directRank || 0,
                directDiminishingMultiplier: Number.isFinite(result?.directDiminishingMultiplier)
                    ? Number(result.directDiminishingMultiplier.toFixed(4))
                    : 1,
                aiExpandedRank: result?.expandedRank || 0,
                score: Number.isFinite(result?.score) ? Number(result.score.toFixed(4)) : null,
                semanticRank: result?.semanticRank || 0,
                supportSeedConfidence: Number.isFinite(result?.seedConfidence)
                    ? Number(result.seedConfidence.toFixed(4))
                    : null,
                supportMarginalScore: Number.isFinite(result?.supportMarginalScore)
                    ? Number(result.supportMarginalScore.toFixed(4))
                    : null,
                supportRank: result?.supportRank || 0,
                sourceLinked: Boolean(result?.connection?.sourceLinked),
                hierarchyLinked: Boolean(result?.connection?.hierarchyLinked),
                passageLocalized: Boolean(result?.passageLocalized),
                reason,
            });
        }
        return results;
    };
    const takeMatches = (section, category, items, limit, extra = () => 0) => recordSelections(
        section,
        category,
        matching(items, queryTerms, extra, category, semanticRanks).slice(0, limit),
    );
    const budget = Math.max(128, Number(budgetTokens));
    const guidance = String(injectionInstruction ?? DEFAULT_INJECTION_INSTRUCTION).trim();
    const parts = { value: `<continuity>\n${guidance}${guidance ? '\n' : ''}${LIFECYCLE_GUIDANCE}\n` };
    const sections = [];
    const seenRows = new Set();
    const addSection = (title, rows) => sections.push({
        title,
        rows: rows.filter(row => {
            const key = plain(row).toLocaleLowerCase();
            if (!key || seenRows.has(key)) return false;
            seenRows.add(key);
            return true;
        }),
    });
    const rawTailRange = options.rawTailRange || null;
    const invalidSourceRanges = Array.isArray(options.invalidSourceRanges) ? options.invalidSourceRanges : [];
    const latestIsRaw = item => latestSourceInRawTail(item, chatKey, rawTailRange);
    const whollyRaw = item => sourcedWhollyInRawTail(item, chatKey, rawTailRange);
    const sourceIsCurrent = item => !sourcedFromInvalidExtraction(item, invalidSourceRanges);
    const availableFacts = (world.facts || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item));
    const storedSceneIsCurrentFocus = Boolean(world.scene && options.includeSceneCheckpoint !== false
        && sourceIsCurrent(world.scene) && !latestIsRaw(world.scene));
    const currentFocusText = [
        ...(storedSceneIsCurrentFocus ? world.scene?.participants || [] : []),
        storedSceneIsCurrentFocus ? world.scene?.activity : '',
        ...((recentMessages || []).slice(-4).map(message => retrievalMessageText(message))),
    ].map(plain).filter(Boolean).join(' ').toLocaleLowerCase();
    const explicitlyFocused = value => {
        const needle = plain(value).toLocaleLowerCase();
        return Boolean(needle && currentFocusText.includes(needle));
    };

    let storyBlock = '';
    const chronicleKeys = [...new Set([world.continuation?.inheritedChatKey, chatKey].filter(Boolean))]
        .filter(key => (world.chronicle || []).some(item => item.chatKey === key));
    const hasChronicle = chronicleKeys.length > 0;
    if (options.includeStorySoFar !== false) {
        const configuredChronicleTokens = Number(options.storySoFarTokens);
        const chronicleTokensPerKey = Number.isFinite(configuredChronicleTokens)
            ? Math.max(1, Math.floor(configuredChronicleTokens / Math.max(1, chronicleKeys.length)))
            : undefined;
        const story = hasChronicle
            ? chronicleKeys.map(key => renderChronicleFrontier(
                world,
                key,
                item => sourceIsCurrent(item) && !whollyRaw(item),
                chronicleTokensPerKey,
            )).filter(Boolean).join('\n\n')
            : plain(world.storySoFar?.[chatKey]?.text);
        const storyHeader = hasChronicle ? '\nRecursive Chronicle layers (complete active frontier):\n' : '\nStory so far:\n';
        // Story generation owns its configured allowance. Never prefix-clip the
        // saved continuity spine here: doing so preferentially removed the final
        // boundaryState and openMatters sections, even when a larger Story budget
        // had been explicitly configured.
        if (story) storyBlock = `${storyHeader}${story}\n`;
    }

    if (storedSceneIsCurrentFocus) {
        addSection('Checkpoint', [
            line('Location', world.scene.location),
            line('Time', anchoredRelativeText(world.scene.time, world.scene)),
            line('Participants', (world.scene.participants || []).join(', ')),
            line('Activity', world.scene.activity),
            line('Tone', world.scene.mood),
        ]);
    }

    const addressForms = takeMatches('Addresses', 'fact', availableFacts.filter(isAddressFact), 12, () => 12)
        .map(({ item }) => `${plain(item.subject)}→${plain(addressFactAddressee(item))}: ${plain(item.value)}`);
    addSection('Addresses', addressForms.length ? [`- ${addressForms.join(' | ')}`] : []);

    const correctionRecords = world.corrections || [];
    const recentCorrections = correctionRecords.slice(-2);
    const recentCorrectionIds = new Set(recentCorrections.map(item => item.id));
    const relevantCorrections = takeMatches('User corrections', 'correction', correctionRecords.filter(item => !recentCorrectionIds.has(item.id)), 6, () => 6)
        .map(({ item }) => item);
    recordSelections('User corrections', 'correction', recentCorrections, 'latest correction');
    const selectedCorrections = [...relevantCorrections, ...recentCorrections]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    addSection('User corrections', selectedCorrections.map(item =>
        `- ${plain(item.summary || item.instruction)}`));

    const knowledgeBoundaryResults = recordSelections('Knowledge boundaries — hard constraints', 'fact', rank(
        availableFacts.filter(isKnowledgeBoundaryFact),
        queryTerms,
        () => 20,
        'fact',
        semanticRanks,
    ).filter(result => result.eligible || result.semanticRank > 0 || boundaryHolderIsInContext(result.item, queryTerms)).slice(0, 12));
    addSection('Knowledge boundaries — hard constraints', knowledgeBoundaryResults.map(({ item }) =>
        `- ${plain(item.subject)} — ${plain(item.predicate)}: ${plain(item.value)} [HARD LIMIT: world truth elsewhere does not grant this character knowledge.]`));

    const sceneParticipants = new Set((storedSceneIsCurrentFocus ? world.scene?.participants || [] : [])
        .map(value => plain(value).toLocaleLowerCase()));
    const establishedKnowledge = availableFacts
        .filter(isEstablishedKnowledgeFact)
        .filter(item => sceneParticipants.has(plain(item.subject).toLocaleLowerCase()))
        .filter(item => explicitlyFocused(plain(item.predicate).replace(/^knowledge of\s+/iu, '')))
        .sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0)
            || compareRecordFreshness(right, left, chatKey))
        .slice(0, 8)
        .map(item => ({ item }));
    recordSelections('Established character knowledge', 'fact', establishedKnowledge, 'current participant and topic');
    addSection('Established character knowledge', establishedKnowledge.map(({ item }) =>
        `- ${plain(item.subject)} — ${plain(item.predicate)}: ${anchoredRelativeText(item.value, item)}`));

    const capsules = world.capsules || [];
    const chronological = capsules.filter(item => sourceIsCurrent(item) && !whollyRaw(item)).slice().sort((a, b) => {
        if (a.chatKey === b.chatKey) return Number(a.from ?? 0) - Number(b.from ?? 0);
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
    const currentChronology = chatKey ? chronological.filter(item => item.chatKey === chatKey) : chronological;
    const latest = hasChronicle ? [] : currentChronology.slice(-3);
    const latestIds = new Set(latest.map(item => item.id));
    const relevant = takeMatches('Recent continuity', 'capsule', (hasChronicle ? [] : chronological).filter(item => !latestIds.has(item.id)), 2)
        .map(({ item }) => item);
    recordSelections('Recent continuity', 'capsule', latest, 'latest L1');
    const selectedCapsules = [...relevant, ...latest]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || Number(a.from ?? 0) - Number(b.from ?? 0));
    const capsuleRows = selectedCapsules.map(item => {
        const storyTime = anchoredStoryTime(item);
        const storyTimeAnchored = storyTime !== plain(item.storyTime);
        const sequence = [item.opening, ...(item.beats || []), item.closing].map(plain).filter(Boolean).join(' → ');
        const emotion = plain(item.emotionalArc);
        const body = `${plain(item.title)}: ${sequence}${emotion ? ` Overall movement: ${emotion}` : ''}`;
        return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`;
    });
    addSection('Recent continuity', capsuleRows);

    const openThreadItems = newestRecordsBy(
        (world.threads || []).filter(item => sourceIsCurrent(item) && item.status === 'open'),
        item => ledgerTitleKey(item.title),
        chatKey,
    );
    const rankedOpenThreads = rank(openThreadItems.filter(item => !latestIsRaw(item)), queryTerms, () => 4, 'thread', semanticRanks);
    const activeThreadResults = recordSelections('Open matters', 'thread', rankedOpenThreads
        .filter(result => result.eligible || result.semanticRank > 0)
        .slice(0, 10));
    const activeThreadIds = new Set(activeThreadResults.map(({ item }) => item.id));
    const activeThreads = activeThreadResults
        .map(({ item }) => `- OPEN — ${anchoredRelativeText(plain(item.detail) || plain(item.title), item)}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`);
    addSection('Open matters', activeThreads);

    const backgrounds = takeMatches('Background', 'background', (world.backgrounds || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), 12, item => item.status === 'active' ? 1 : 0)
        .map(({ item }) => {
            const qualifiers = [item.status, item.certainty].map(plain).filter(Boolean).join(', ');
            return `- ${anchoredRelativeText(`${item.topic}${qualifiers ? ` [${qualifiers}]` : ''}: ${item.summary}`, item)}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`;
        });
    addSection('Background', backgrounds);

    const entityPool = (world.entities || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item));
    const matchedEntities = takeMatches('Entities', 'entity', entityPool, 12);
    const matchedEntityIds = new Set(matchedEntities.map(({ item }) => item.id));
    const focusedEntities = entityPool
        .filter(item => !matchedEntityIds.has(item.id))
        .filter(item => [item.name, ...(item.aliases || [])].some(explicitlyFocused))
        .sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0)
            || compareRecordFreshness(right, left, chatKey))
        .slice(0, Math.max(0, 12 - matchedEntities.length))
        .map(item => ({ item }));
    recordSelections('Entities', 'entity', focusedEntities, 'explicit current mention');
    const entities = [...matchedEntities, ...focusedEntities]
        .map(({ item }) => {
            const identityFacts = availableFacts
                .filter(fact => !isAttributedBeliefFact(fact) && !isAddressFact(fact) && !isKnowledgeBoundaryFact(fact)
                    && plain(fact.subject).toLocaleLowerCase() === plain(item.name).toLocaleLowerCase()
                    && fact.persistence === 'persistent'
                    && Number(fact.importance || 0) >= 4)
                .sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0))
                .slice(0, 2)
                .map(fact => `${plain(fact.predicate)}: ${plain(fact.value)}`);
            const canon = identityFacts.length ? `; established canon: ${identityFacts.join(' | ')}` : '';
            const description = formatEntityProfile(item) || plain(item.description);
            return `- ${item.name}${item.type ? ` (${item.type})` : ''}: ${description}${canon}${item.aliases?.length ? `; aliases: ${item.aliases.join(', ')}` : ''}`;
        });
    addSection('Entities', entities);

    const states = takeMatches('Current state', 'state', (world.states || []).filter(item => sourceIsCurrent(item) && isFreshActiveState(world, item, chatKey) && !latestIsRaw(item)), 16, item => item.value ? 2 : 0)
        .map(({ item }) => `- ${item.subject} — ${item.attribute}: ${anchoredRelativeText(item.value, item)}`);
    addSection('Current state', states);

    const relationshipMatches = limitRelationshipPairs(matching(
        (world.relationships || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)),
        queryTerms,
        () => 0,
        'relationship',
        semanticRanks,
    ), 1).slice(0, 12);
    const relationships = recordSelections('Relationships', 'relationship', relationshipMatches)
        .map(({ item }) => {
            const description = plain(item.dynamic);
            const type = plain(item.kind);
            const status = plain(item.status);
            const body = [description ? `Description: ${description}` : '', type ? `Type: ${type}.` : '', status ? `Status: ${status}.` : '']
                .filter(Boolean).join(' ');
            return `- ${item.from} ↔ ${item.to}: ${anchoredRelativeText(body, item)}`;
        });
    addSection('Relationships', relationships);

    const perspectives = takeMatches('Character perspectives (not established facts)', 'fact', availableFacts.filter(isAttributedBeliefFact), 16, item => item.persistence === 'persistent' ? 2 : 0)
        .map(({ item }) => `- ${item.subject} — ${item.predicate}: ${anchoredRelativeText(item.value, item)} [subjective; not an established fact]`);
    addSection('Character perspectives (not established facts)', perspectives);

    const facts = takeMatches('Facts', 'fact', availableFacts.filter(item => !isAttributedBeliefFact(item) && !isAddressFact(item) && !isKnowledgeBoundaryFact(item) && !isEstablishedKnowledgeFact(item)), 18, item => item.persistence === 'persistent' ? 2 : 0)
        .map(({ item }) => {
            const qualifier = item.persistence && item.persistence !== 'persistent' ? ` [${item.persistence}]` : '';
            return `- ${item.subject} — ${item.predicate}${qualifier}: ${anchoredRelativeText(item.value, item)}`;
        });
    addSection('Facts', facts);

    const currentEventItems = (world.events || []).filter(item => sourceIsCurrent(item));
    const availableEvents = currentEventItems.filter(item => !whollyRaw(item));
    const selectedEvents = takeMatches('Past events', 'event', availableEvents, 12)
        .map(({ item }) => item);
    const events = orderEventsChronologically(selectedEvents, chatKey, world.capsules || [])
        .map(item => {
            const storyTime = anchoredStoryTime(item);
            const storyTimeAnchored = storyTime !== plain(item.storyTime);
            const detail = `${item.summary}${item.consequences ? ` Consequence: ${item.consequences}` : ''}`;
            const body = `${item.title}: ${detail}`;
            return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`;
        });
    addSection('Past events', events);

    const selectedEventIds = new Set(selectedEvents.map(item => item.id));
    const compactEvents = orderEventsChronologically(
        newestRecordsBy(
            currentEventItems.filter(item => !selectedEventIds.has(item.id)),
            item => ledgerTitleKey(item.title),
            chatKey,
        ).sort((left, right) => compareRecordFreshness(right, left, chatKey)).slice(0, 12),
        chatKey,
        world.capsules || [],
    );
    const compactThreads = openThreadItems
        .filter(item => !activeThreadIds.has(item.id))
        .sort((left, right) => compareRecordFreshness(right, left, chatKey))
        .slice(0, 12);
    addSection('Compact continuity ledger', [
        compactEvents.length ? `- Event ledger (latest): ${compactEvents.map(item => plain(item.title)).join(' → ')}` : '',
        compactThreads.length ? `- Open-thread ledger (latest): ${compactThreads.map(item => whollyRaw(item) ? plain(item.title) : plain(item.detail) || plain(item.title)).join('; ')}` : '',
    ]);

    const selectedIds = new Set(selectedMemoryRecords.map(selection => selection.item.id));
    const supportCandidates = [
        ...((world.entities || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)).map(item => ({ category: 'entity', item }))),
        ...(availableFacts.map(item => ({
            category: isAddressFact(item) ? 'address' : (isAttributedBeliefFact(item) ? 'perspective' : 'fact'),
            item,
        }))),
        ...((world.states || []).filter(item => sourceIsCurrent(item) && isFreshActiveState(world, item, chatKey) && !latestIsRaw(item)).map(item => ({ category: 'state', item }))),
        ...((world.relationships || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)).map(item => ({ category: 'relationship', item }))),
        ...((world.events || []).filter(item => sourceIsCurrent(item) && !whollyRaw(item)).map(item => ({ category: 'event', item }))),
        ...((hasChronicle ? [] : chronological).map(item => ({ category: 'capsule', item }))),
        ...((world.threads || []).filter(item => sourceIsCurrent(item) && item.status === 'open' && !latestIsRaw(item)).map(item => ({ category: 'thread', item }))),
        ...((world.backgrounds || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)).map(item => ({ category: 'background', item }))),
    ].filter(candidate => candidate.item?.id && !selectedIds.has(candidate.item.id));
    const supportRelevanceByItem = new Map();
    const supportLimit = Math.max(12, Math.ceil(budget / 80));
    // Automatic/default budgets are the tuning baseline. Larger or smaller
    // user budgets adjust depth gradually instead of switching policies.
    const supportDepthScale = Math.min(1.5, Math.max(0.75, Math.sqrt(budget / 10000)));
    const primarySupportSeeds = selectedMemoryRecords
        .filter(selection => selection.category !== 'entity' && selection.reason !== 'latest L1')
        // L1 records already carry their own condensed history. Expanding
        // them again tends to recover a whole old interval instead of useful
        // prerequisites for the current query.
        .filter(selection => selection.category !== 'capsule')
        // Open matters remain visible as primaries on a permissive match, but
        // only strong/direct thread evidence may unlock their wider history.
        .filter(selection => selection.category !== 'thread'
            || selection.result?.directEligible
            || selection.result?.semanticRank > 0
            || queryEvidenceConfidence(selection, queryTerms) >= 0.75)
        .filter((selection, index, all) => all.findIndex(other => other.item.id === selection.item.id) === index)
        .map(selection => selection);
    const rankSupportWave = supportFrontier => {
        const wave = [];
        for (const candidate of supportCandidates) {
            if (selectedIds.has(candidate.item.id)) continue;
            let best = null;
            for (const seed of supportFrontier) {
                const connection = supportConnection(seed, candidate.item, queryTerms);
                if (!connection || (best && connection.score <= best.connection.score)) continue;
                best = { seed, connection };
            }
            if (!best) continue;
            let relevance = supportRelevanceByItem.get(candidate.item);
            if (!relevance) {
                const stats = queryTerms.recordStats.get(candidate.item) || retrievalFieldStats(candidate.item);
                relevance = {
                    direct: queryScore(stats, queryTerms, queryTerms.direct),
                    expanded: expandedQueryScore(stats, queryTerms),
                };
                supportRelevanceByItem.set(candidate.item, relevance);
            }
            const directRelevance = relevance.direct;
            const expandedRelevance = relevance.expanded;
            const activeBoost = ['active', 'open'].includes(String(candidate.item.status || '').toLocaleLowerCase()) ? 1.5 : 0;
            const priority = best.connection.score
                + Math.min(6, Math.log1p(Math.max(directRelevance, expandedRelevance)) * 1.5)
                + activeBoost
                + (Number(candidate.item.importance) || 3) * 0.1
                + recency(candidate.item) * 0.1;
            wave.push({
                ...candidate,
                seed: best.seed,
                connection: best.connection,
                priority,
                score: priority,
                directScore: directRelevance,
                expandedScore: expandedRelevance,
                matchedTerms: best.connection.matchedTerms,
            });
        }
        wave.sort((left, right) => right.priority - left.priority
            || String(right.item.updatedAt || '').localeCompare(String(left.item.updatedAt || '')));
        return wave;
    };
    const directSupportLimit = supportLimit;
    const rankedSupportBySeed = primarySupportSeeds.map(selection => retainSupportForSeed(
        selection,
        rankSupportWave([selection.item]).slice(0, supportLimit),
        queryTerms,
        supportDepthScale,
    ));
    const directSupport = [];
    const directSupportById = new Map();
    const sourceSupportLimit = Math.ceil(supportLimit * 0.5);
    const sourceSupportBySeed = primarySupportSeeds.map((selection, seedIndex) => memorySourceRanges(selection.item)
        .flatMap(range => rankedSupportBySeed[seedIndex]
            .filter(result => overlapsSourceRange(result.item, range))
            .slice(0, 2))
        .filter(Boolean));
    const maximumSourceDepth = Math.max(0, ...sourceSupportBySeed.map(ranking => ranking.length));
    for (let sourceIndex = 0; sourceIndex < maximumSourceDepth && directSupport.length < sourceSupportLimit; sourceIndex++) {
        const tier = sourceSupportBySeed
            .map(ranking => ranking[sourceIndex])
            .filter(Boolean)
            .sort((left, right) => right.priority - left.priority
                || String(right.item.updatedAt || '').localeCompare(String(left.item.updatedAt || '')));
        for (const result of tier) {
            if (directSupportById.has(result.item.id)) continue;
            directSupportById.set(result.item.id, result);
            directSupport.push(result);
            if (directSupport.length >= sourceSupportLimit) break;
        }
    }
    for (let rankIndex = 0; rankIndex < supportLimit && directSupport.length < directSupportLimit; rankIndex++) {
        const tier = rankedSupportBySeed
            .map(ranking => ranking[rankIndex])
            .filter(Boolean)
            .sort((left, right) => right.priority - left.priority
                || String(right.item.updatedAt || '').localeCompare(String(left.item.updatedAt || '')));
        for (const result of tier) {
            if (directSupportById.has(result.item.id)) continue;
            directSupportById.set(result.item.id, result);
            directSupport.push(result);
            if (directSupport.length >= directSupportLimit) break;
        }
    }
    const prioritizedClosureRecords = directSupport
        .filter((result, index, all) => all.findIndex(other => other.item.id === result.item.id) === index)
        .slice(0, supportLimit);
    const supportRow = ({ category, item }) => {
        if (category === 'entity') return `- [entity] ${item.name}${item.type ? ` (${item.type})` : ''}: ${formatEntityProfile(item) || plain(item.description)}${item.aliases?.length ? `; aliases: ${item.aliases.join(', ')}` : ''}`;
        if (category === 'address') return `- [address] ${plain(item.subject)}→${plain(addressFactAddressee(item))}: ${plain(item.value)}`;
        if (category === 'perspective') return `- [perspective; subjective] ${item.subject} — ${item.predicate}: ${anchoredRelativeText(item.value, item)}`;
        if (category === 'fact') return `- [fact] ${item.subject} — ${item.predicate}: ${anchoredRelativeText(item.value, item)}`;
        if (category === 'state') return `- [state] ${item.subject} — ${item.attribute}: ${anchoredRelativeText(item.value, item)}`;
        if (category === 'relationship') {
            const description = plain(item.dynamic);
            const type = plain(item.kind);
            const status = plain(item.status);
            const body = [description ? `Description: ${description}` : '', type ? `Type: ${type}.` : '', status ? `Status: ${status}.` : '']
                .filter(Boolean).join(' ');
            return `- [relationship] ${item.from} ↔ ${item.to}: ${anchoredRelativeText(body, item)}`;
        }
        if (category === 'thread') return `- [open matter] ${anchoredRelativeText(`${item.title}: ${item.detail}`, item)}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`;
        if (category === 'background') return `- [background] ${anchoredRelativeText(`${item.topic}: ${item.summary}`, item)}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`;
        if (category === 'event') {
            const storyTime = anchoredStoryTime(item);
            const detail = `${item.summary}${item.consequences ? ` Consequence: ${item.consequences}` : ''}`;
            return `- [event] ${storyTime ? `[${storyTime}] ` : ''}${anchoredRelativeText(`${item.title}: ${detail}`, item)}`;
        }
        if (category === 'capsule') {
            const storyTime = anchoredStoryTime(item);
            const sequence = [item.opening, ...(item.beats || []), item.closing].map(plain).filter(Boolean).join(' → ');
            return `- [L1] ${storyTime ? `[${storyTime}] ` : ''}${anchoredRelativeText(`${item.title}: ${sequence}${item.emotionalArc ? ` Overall movement: ${plain(item.emotionalArc)}` : ''}`, item)}`;
        }
        return '';
    };
    for (const result of prioritizedClosureRecords) {
        recordSelections(
            'Supporting continuity',
            result.category,
            [result],
            `supports ${diagnosticLabel(result.seed)}`,
        );
    }
    addSection('Supporting continuity', prioritizedClosureRecords.map(supportRow));

    addFairSections(parts, sections, budget);
    if (storyBlock) parts.value += storyBlock;
    parts.value += '</continuity>';
    return { prompt: parts.value, estimatedTokens: estimatedTokens(parts.value), retrievalDiagnostics };
}
import { DEFAULT_INJECTION_INSTRUCTION } from './prompts.js?v=0.15.0-testing.2';
import { embeddingAnchorText, embeddingRecordKey } from './embedding-index.js';
import { isAttributedBeliefFact, migrateLegacyBeliefs } from './attributed-beliefs.js';
import { addressFactAddressee, isAddressFact } from './reconciliation-policy.js';
