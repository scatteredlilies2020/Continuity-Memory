// Presentation only: preserve stable IDs in storage, exports, and diagnostics.
// Resolve known source references to short, unambiguous message ranges in prompts.
export function compactPromptProvenance(prompt, world, chatKey) {
    const capsules = world?.capsules || [];
    const keys = [...new Set(capsules.map(item => item.chatKey).filter(Boolean))].sort();
    const labels = new Map(keys.map((key, index) => [key, key === chatKey ? 'this chat' : `chat ${index + 1}`]));
    if (chatKey) labels.set(chatKey, 'this chat');
    const replacements = new Map();
    for (const capsule of capsules) {
        const id = capsule.temporal?.anchorId || capsule.temporalAnchorId;
        if (id && Number.isInteger(capsule.from) && Number.isInteger(capsule.to)) {
            replacements.set(id, `${labels.get(capsule.chatKey) || 'source'} messages ${capsule.from}–${capsule.to}`);
        }
    }
    for (const [key, label] of labels) replacements.set(key, label);
    // Longest first prevents a shorter key corrupting another known identifier.
    const identifiers = [...replacements.keys()].sort((a, b) => b.length - a.length);
    if (!identifiers.length) return prompt;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = identifiers.map(id => escape(id) + (labels.has(id) ? '(?= messages [0-9])' : '(?![\\w-])'));
    return String(prompt).replace(new RegExp(patterns.join('|'), 'g'), value => replacements.get(value));
}
