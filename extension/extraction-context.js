function messageText(message) {
    return String(message?.mes ?? message?.text ?? '').trim();
}

const META_LABEL = "(?:OOC|out[- ]of[- ]character|meta|canon(?:ical)?\\s+note|author(?:'s)?\\s+note|GM\\s+note|narrator\\s+note)";
const SETUP_LABEL = '(?:timeline|era|setting|scenario|scene|location|notes?)';
const NOTE_HEADER = new RegExp(`^[\\t ]*(?:#{1,6}[\\t ]+)?(?:\\*{1,2}|_{1,2})?[\\t ]*[\\[(]?(${META_LABEL}|${SETUP_LABEL})(?:\\*{1,2}|_{1,2})?[\\t ]*(?:[:—–-]|\\]|\\))[\\t ]*(?:\\*{1,2}|_{1,2})?[\\t ]*(.*)$`, 'iu');
const EXPLICIT_META_LABEL = new RegExp(`^${META_LABEL}$`, 'iu');
const INLINE_META = new RegExp(`[\\[(](?:${META_LABEL}|${SETUP_LABEL})[\\t ]*[:—–-][\\t ]*[^\\]\\)\\n]+[\\]\\)]|\\b${META_LABEL}[\\t ]*[:—–-][\\t ]*.+$`, 'giu');
const PROVENANCE_STOP_WORDS = new Set('about after again against also and are because been before being between both but can could did does doing down during each few for from further had has have having her here hers herself him himself his how into its itself just more most nor not now off once only other our ours ourselves out over own same she should some such than that the their theirs them themselves then there these they this those through too under until very was were what when where which while who whom why will with would you your yours yourself yourselves'.split(' '));
// Keep this list limited to verbs that actually attribute speech or knowledge
// to a character. Broad factual/administrative verbs such as "established",
// "identified", "confirmed", and "reported" also occur in neutral narration
// and can falsely turn an OOC-term overlap into a provenance violation.
const ATTRIBUTION_VERB = /\b(?:said|says|stated|asserted|claimed|revealed|disclosed|told|informed|admitted|announced|explained|mentioned|shared|communicated|declared|knew|knows|learned|realized|recognized|understood|discovered)\b/iu;
const SAFE_PROVENANCE = /\b(?:OOC|meta|author(?:'s)?[- ]level|authorial|narrative context|canon(?:ical)? note|GM note|narrator note)\b/iu;
const NEGATED_ATTRIBUTION = /\b(?:did not|does not|had not|has not|never|without)\s+(?:say|state|assert|claim|reveal|disclose|tell|inform|admit|announce|report|confirm|explain|mention|share|communicate|declare|identify|establish|know|learn|realize|recognize|understand|discover)\b/iu;

function words(value) {
    return String(value ?? '').toLocaleLowerCase().replace(/\b(?:pre|post)-/gu, '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
}

export function splitAuthoritativeUserMeta(message) {
    if (message?.isUser !== true) return null;
    const split = splitScenarioNotes(message);
    return split ? { inWorld: split.inWorld, meta: split.meta } : null;
}

// Role and position do not decide note authority. Keep source order and narrow
// boundaries so a note never absorbs the dialogue or narration following it.
export function splitScenarioNotes(message) {
    if (message?.is_system) return null;
    const lines = messageText(message).split(/\r?\n/u);
    const spans = [];
    const append = (type, text) => {
        if (spans.at(-1)?.type === type) spans.at(-1).text += `\n${text}`;
        else spans.push({ type, text });
    };
    let fence = null;
    let noteContinuation = false;
    for (const line of lines) {
        const marker = line.match(/^[\t ]*(`{3,}|~{3,})/u)?.[1];
        if (marker) {
            noteContinuation = false;
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
            append('inWorld', line);
            continue;
        }
        if (fence || /^[\t ]*(?:>|["“‘'`])/u.test(line)) {
            noteContinuation = false;
            append('inWorld', line);
            continue;
        }
        const header = NOTE_HEADER.exec(line);
        // A closed inline note at the start of a line must not absorb the
        // narration after its closing bracket. Let the inline splitter handle it.
        const boundedInlineHeader = /^[\t ]*[\[(][^\]\)]*[:—–-][^\]\)]*[\]\)]/u.test(line);
        if (header && !boundedInlineHeader) {
            // Retain setup labels (e.g. Timeline) as part of the evidence.
            const text = EXPLICIT_META_LABEL.test(header[1]) && header[2].trim() ? header[2] : line.trim();
            append('meta', text);
            noteContinuation = true;
            continue;
        }
        if (noteContinuation && line.trim() && /^(?:\t| {2,}|[\t ]*(?:[-+*]|\d+[.)])\s+)/u.test(line)) {
            append('meta', line);
            continue;
        }
        noteContinuation = false;
        let offset = 0;
        for (const match of line.matchAll(INLINE_META)) {
            // Inline quoted speech and code are not author notes.
            if (/["“”‘’`]/u.test(line.slice(0, match.index))) continue;
            append('inWorld', line.slice(offset, match.index));
            append('meta', match[0]);
            offset = match.index + match[0].length;
        }
        append('inWorld', line.slice(offset));
    }
    const nonempty = spans.map(span => ({ ...span, text: span.text.trim() })).filter(span => span.text);
    if (!nonempty.some(span => span.type === 'meta')) return null;
    return {
        spans: nonempty,
        meta: nonempty.filter(span => span.type === 'meta').map(span => span.text).join('\n'),
        inWorld: nonempty.filter(span => span.type === 'inWorld').map(span => span.text).join('\n'),
    };
}

export function authoritativeMetaBoundaries(messages) {
    const boundaries = [];
    for (const message of messages || []) {
        const split = splitScenarioNotes(message);
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
        const split = splitScenarioNotes(message);
        if (!split) return `[message ${message.index}] [${message.name}]: ${messageText(message)}`;
        const spans = split.spans.map(span => {
            const tag = span.type === 'meta' ? 'AUTHOR_OOC_META_SPAN' : 'IN_WORLD_SPAN';
            return `<${tag}>\n${span.text}\n</${tag}>`;
        }).join('\n');
        return `[message ${message.index}] [${message.name}] [PROVENANCE-SEGMENTED ${message.isUser ? 'USER ' : ''}MESSAGE]:\n${spans}\n[Each author span's continuity assertions are canon but it is not ${message.name}'s speech, action, disclosure, or knowledge. Extract durable constraints; exclude questions, hypotheticals, writing preferences, and in-world quoted notes. Explicit user corrections take precedence over conflicting assistant notes.]`;
    }).join('\n\n');
    if (!attributionContext) return formatted;
    const context = `[message ${attributionContext.index}] [${attributionContext.name}]: ${attributionContext.text}`;
    return `ATTRIBUTION CONTEXT ONLY. Use it to identify speakers, but do not extract it as part of this range:\n${context}\n\nEXCERPT TO EXTRACT:\n${formatted}`;
}
