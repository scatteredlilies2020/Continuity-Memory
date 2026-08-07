function messageIdentity(message, index = message?.index) {
    const numericIndex = Number(index);
    if (!Number.isFinite(numericIndex) || numericIndex < 0) return null;
    if (message?.is_system || Array.isArray(message?.extra?.tool_invocations)) return null;
    return {
        index: numericIndex,
        name: message.name || (message.is_user ? 'User' : 'Character'),
        text: String(message.mes || '').trim(),
    };
}

/**
 * Aligns the regex-processed generation chat with the original saved chat.
 * Prompt identities are used for token budgeting. Source identities are used
 * for extraction fingerprint verification, before prompt-only regexes alter
 * message text. Original indexes are preserved even when system messages were
 * filtered out of the generation chat.
 */
export function mapContextMessages(coreChat = [], sourceChat = []) {
    const originalMessages = (sourceChat || [])
        .map((message, index) => ({ message, index }))
        .filter(item => !item.message?.is_system);
    let originalCursor = 0;

    return (coreChat || []).map((message, position) => {
        const original = message?.is_system ? null : originalMessages[originalCursor++] || null;
        return {
            message,
            position,
            promptIdentity: messageIdentity(message),
            sourceIdentity: original ? messageIdentity(original.message, original.index) : null,
        };
    });
}
