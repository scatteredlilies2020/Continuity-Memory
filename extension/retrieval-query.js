const RETRIEVAL_NOISE_BLOCKS = [
    /<stat\b[^>]*>[\s\S]*?<\/stat>/gi,
    /<background_updates\b[^>]*>[\s\S]*?<\/background_updates>/gi,
];

export function retrievalMessageText(message) {
    let text = String(message?.mes ?? '');
    for (const pattern of RETRIEVAL_NOISE_BLOCKS) text = text.replace(pattern, ' ');
    return text.replace(/\s+/g, ' ').trim();
}

export function recentRetrievalQuery(messages, messageLimit = 6) {
    const limit = Math.min(50, Math.max(2, Number(messageLimit) || 6));
    return (messages || [])
        .slice(-limit)
        .map(message => `${message.name || ''}: ${retrievalMessageText(message)}`)
        .join('\n');
}
