const RETRIEVAL_NOISE_BLOCKS = [
    /<stat\b[^>]*>[\s\S]*?<\/stat>/gi,
    /<background_updates\b[^>]*>[\s\S]*?<\/background_updates>/gi,
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    /<!--[\s\S]*?-->/g,
];

// Work in the browser and in server-side previews without executing markup.
// Keep displayed table contents and paragraph boundaries, not CSS or attributes.
export function retrievalMessageText(message) {
    let text = String(message?.mes ?? '');
    for (const pattern of RETRIEVAL_NOISE_BLOCKS) text = text.replace(pattern, ' ');
    text = text.replace(/<\/?(?:p|div|tr|li|h[1-6]|br|table|blockquote)\b[^>]*>/gi, '\n')
        .replace(/<\/?[a-z][^>]*>/gi, ' ')
        .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#(?:x[0-9a-f]+|[0-9]+));/gi, entity => {
            const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
            const key = entity.slice(1, -1).toLowerCase();
            if (key in named) return named[key];
            const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
            return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
        });
    return text.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function recentRetrievalQuery(messages, messageLimit = 6) {
    const limit = Math.min(50, Math.max(2, Number(messageLimit) || 6));
    return (messages || []).filter(message => !message?.is_system)
        .slice(-limit)
        .map(message => `${message.name || ''}: ${retrievalMessageText(message)}`)
        .join('\n');
}
