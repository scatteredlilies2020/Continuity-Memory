function identity(value) {
    return value === undefined || value === null ? '' : String(value);
}

/**
 * Metadata saves rewrite the complete SillyTavern JSONL chat. Refuse to save
 * while a chat is still loading, has changed, or has no messages.
 *
 * @param {object} expected Context captured before changing chat metadata.
 * @param {object} current Fresh context immediately before the save.
 * @returns {boolean} Whether saving can safely target the captured chat.
 */
export function canSafelySaveChatMetadata(expected, current) {
    if (!expected || !current) return false;
    if (!identity(expected.chatId) || identity(expected.chatId) !== identity(current.chatId)) return false;
    if (identity(expected.groupId) !== identity(current.groupId)) return false;
    if (identity(expected.characterId) !== identity(current.characterId)) return false;
    if (expected.chatMetadata !== current.chatMetadata) return false;
    if (!Array.isArray(current.chat) || current.chat.length === 0) return false;
    return true;
}
