export function parseExpandedTerms(raw) {
    let text = String(raw || '').replace(/<(think|thinking|thought|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.terms)) throw new Error('AI retrieval returned no terms array.');
    return [...new Set(parsed.terms.map(value => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean))]
        .slice(0, 20);
}
