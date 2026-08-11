function messageText(message) {
    return String(message?.mes ?? message?.text ?? '').trim();
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
    const formatted = (messages || []).map(message => `[message ${message.index}] [${message.name}]: ${message.text}`).join('\n\n');
    if (!attributionContext) return formatted;
    const context = `[message ${attributionContext.index}] [${attributionContext.name}]: ${attributionContext.text}`;
    return `ATTRIBUTION CONTEXT ONLY. Use it to identify speakers, but do not extract it as part of this range:\n${context}\n\nEXCERPT TO EXTRACT:\n${formatted}`;
}
