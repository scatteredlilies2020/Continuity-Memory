function messageText(message) {
    return String(message?.mes ?? message?.text ?? '').trim();
}

const AUTHORITATIVE_USER_META = /(?:^|[\s[(])(?:OOC|out[- ]of[- ]character|meta|canon(?:ical)?\s+note|author(?:'s)?\s+note|GM\s+note|narrator\s+note)\s*(?:[:—–-]|\)|\])/iu;
const PROVENANCE_STOP_WORDS = new Set('about after again against also and are because been before being between both but can could did does doing down during each few for from further had has have having her here hers herself him himself his how into its itself just more most nor not now off once only other our ours ourselves out over own same she should some such than that the their theirs them themselves then there these they this those through too under until very was were what when where which while who whom why will with would you your yours yourself yourselves'.split(' '));
const ATTRIBUTION_VERB = /\b(?:said|says|stated|asserted|claimed|revealed|disclosed|told|informed|admitted|announced|reported|confirmed|explained|mentioned|shared|communicated|declared|identified|established|knew|knows|learned|realized|recognized|understood|discovered)\b/iu;
const SAFE_PROVENANCE = /\b(?:OOC|meta|author(?:'s)?[- ]level|authorial|narrative context|canon(?:ical)? note|GM note|narrator note)\b/iu;
const NEGATED_ATTRIBUTION = /\b(?:did not|does not|had not|has not|never|without)\s+(?:say|state|assert|claim|reveal|disclose|tell|inform|admit|announce|report|confirm|explain|mention|share|communicate|declare|identify|establish|know|learn|realize|recognize|understand|discover)\b/iu;

function words(value) {
    return String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
}

export function splitAuthoritativeUserMeta(message) {
    if (message?.isUser !== true) return null;
    const source = messageText(message);
    const match = AUTHORITATIVE_USER_META.exec(source);
    if (!match) return null;
    const labelOffset = match.index + (match[0].match(/^[\s[(]+/u)?.[0].length || 0);
    const contentOffset = match.index + match[0].length;
    return {
        inWorld: source.slice(0, labelOffset).trim(),
        meta: source.slice(contentOffset).trim(),
    };
}

export function authoritativeMetaBoundaries(messages) {
    const boundaries = [];
    for (const message of messages || []) {
        const split = splitAuthoritativeUserMeta(message);
        if (!split?.meta) continue;
        const speaker = String(message?.name || '').trim();
        const inWorldTerms = new Set(words(split.inWorld));
        const speakerTerms = new Set(words(speaker));
        const terms = [...new Set(words(split.meta).filter(term => term.length >= 3
            && !PROVENANCE_STOP_WORDS.has(term)
            && !inWorldTerms.has(term)
            && !speakerTerms.has(term)))];
        boundaries.push({
            messageIndex: Number(message?.index),
            speaker,
            terms: terms.slice(0, 48),
        });
    }
    return boundaries;
}

function resultStrings(value, output = []) {
    if (typeof value === 'string') output.push(value);
    else if (Array.isArray(value)) value.forEach(item => resultStrings(item, output));
    else if (value && typeof value === 'object') Object.values(value).forEach(item => resultStrings(item, output));
    return output;
}

export function authoritativeMetaProvenanceConflicts(result, boundaries) {
    const sentences = resultStrings(result).flatMap(value => String(value).split(/(?<=[.!?;])\s+|\n+/u)).filter(Boolean);
    const conflicts = [];
    for (const boundary of boundaries || []) {
        const speaker = String(boundary?.speaker || '').trim();
        for (const sentence of sentences) {
            if (!ATTRIBUTION_VERB.test(sentence)) continue;
            if (SAFE_PROVENANCE.test(sentence) || NEGATED_ATTRIBUTION.test(sentence)) continue;
            const sentenceTerms = new Set(words(sentence));
            const overlap = (boundary.terms || []).filter(term => sentenceTerms.has(term));
            if (!overlap.length) continue;
            conflicts.push({ messageIndex: boundary.messageIndex, speaker, sentence: sentence.trim(), terms: overlap });
        }
    }
    return conflicts;
}

export function assertAuthoritativeMetaProvenance(result, boundaries) {
    const conflicts = authoritativeMetaProvenanceConflicts(result, boundaries);
    if (!conflicts.length) return result;
    const first = conflicts[0];
    throw new Error(`OOC provenance violation: generated memory attributes author-only canon as character speech or knowledge${first.speaker ? ` (source persona: ${first.speaker})` : ''}: “${first.sentence.slice(0, 220)}”`);
}

export function isAuthoritativeUserMetaMessage(message) {
    return splitAuthoritativeUserMeta(message) !== null;
}

export function precedingUserAttributionContext(chat, messages) {
    const firstIndex = Number(messages?.[0]?.index);
    if (!Number.isInteger(firstIndex) || firstIndex <= 0 || chat?.[firstIndex]?.is_user) return null;
    for (let index = firstIndex - 1; index >= 0; index--) {
        const message = chat?.[index];
        const text = messageText(message);
        if (!message || message.is_system || !text) continue;
        if (!message.is_user) return null;
        return {
            index,
            name: message.name || 'User',
            text,
            isUser: true,
        };
    }
    return null;
}

export function formatExtractionMessages(messages, attributionContext = null) {
    const formatted = (messages || []).map(message => {
        const split = splitAuthoritativeUserMeta(message);
        if (!split) return `[message ${message.index}] [${message.name}]: ${message.text}`;
        const inWorld = split.inWorld ? `<IN_WORLD_SPAN>\n${split.inWorld}\n</IN_WORLD_SPAN>\n` : '';
        return `[message ${message.index}] [${message.name}] [PROVENANCE-SEGMENTED USER MESSAGE]:\n${inWorld}<AUTHOR_OOC_META_SPAN>\n${split.meta}\n</AUTHOR_OOC_META_SPAN>\n[The author span is canon but is not ${message.name}'s speech, action, disclosure, or knowledge.]`;
    }).join('\n\n');
    if (!attributionContext) return formatted;
    const context = `[message ${attributionContext.index}] [${attributionContext.name}]: ${attributionContext.text}`;
    return `ATTRIBUTION CONTEXT ONLY. Use it to identify speakers, but do not extract it as part of this range:\n${context}\n\nEXCERPT TO EXTRACT:\n${formatted}`;
}
