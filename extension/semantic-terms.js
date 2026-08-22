function normalizeTerms(values) {
    return [...new Set(values.map(value => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean))]
        .slice(0, 20);
}

function recoverCompleteTerms(text) {
    const match = /"terms"\s*:\s*\[/i.exec(text);
    if (!match) return [];
    const terms = [];
    let index = match.index + match[0].length;
    while (index < text.length) {
        while (/[\s,]/.test(text[index] || '')) index++;
        if (text[index] === ']') break;
        if (text[index] !== '"') break;
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
        catch { break; }
    }
    return normalizeTerms(terms);
}

export function parseExpandedTerms(raw) {
    let text = String(raw || '').replace(/<(think|thinking|thought|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        const recovered = recoverCompleteTerms(text);
        if (recovered.length) return recovered;
        throw error;
    }
    if (!Array.isArray(parsed.terms)) throw new Error('AI retrieval returned no terms array.');
    return normalizeTerms(parsed.terms);
}
