import { parseJsonResponse } from './json-response.js';

function invalidTerms() {
    // Do not expose provider output, which can contain private conversation.
    return Object.assign(new Error('AI retrieval returned invalid search-term JSON; expected an array of strings in {"terms":[...]}.'),
        { code: 'CONTINUITY_INVALID_RETRIEVAL_OUTPUT' });
}

function normalizeTerms(values) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw invalidTerms();
    return [...new Set(values.map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean))]
        .slice(0, 20);
}

function recoverCompleteTerms(text) {
    // Recovery is only for a truncated terms response, never arbitrary prose,
    // nested objects, malformed drafts, or JSON contained in closed reasoning.
    while (true) {
        const opening = /^<(think|thinking|thought|reasoning)(?:\s[^>]*)?>/i.exec(text);
        if (!opening) break;
        const closing = new RegExp(`</${opening[1]}>`, 'i').exec(text.slice(opening[0].length));
        if (!closing) return [];
        text = text.slice(opening[0].length + closing.index + closing[0].length).trim();
    }
    const match = /^(?:```(?:json)?\s*)?\{\s*"terms"\s*:\s*\[/i.exec(text);
    if (!match) return [];
    const terms = [];
    let index = match.index + match[0].length;
    while (index < text.length) {
        while (/\s/.test(text[index] || '')) index++;
        if (index === text.length) break;
        if (text[index] !== '"') return [];
        const start = index++;
        let escaped = false;
        let complete = false;
        while (index < text.length) {
            const character = text[index++];
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') { complete = true; break; }
        }
        if (!complete) break;
        try { terms.push(JSON.parse(text.slice(start, index))); }
        catch { return []; }
        while (/\s/.test(text[index] || '')) index++;
        if (index === text.length) break;
        if (text[index] === ',') { index++; continue; }
        // A closed array with no object closure is also a truncated response.
        if (text[index] === ']' && !text.slice(index + 1).trim()) break;
        return [];
    }
    return normalizeTerms(terms);
}

export function parseExpandedTerms(raw) {
    const text = String(raw ?? '').trim();
    let parsed;
    try {
        parsed = parseJsonResponse(text);
    } catch {
        const recovered = recoverCompleteTerms(text);
        if (recovered.length) return recovered;
        throw invalidTerms();
    }
    // Some models omit the object wrapper but still return an unambiguous list.
    return normalizeTerms(Array.isArray(parsed) ? parsed : parsed?.terms);
}
