export function resolveDeletedChatBinding(chatWorlds, chatId, ownerKind) {
    const id = String(chatId || '');
    if (!id) return { binding: null, ambiguous: false };
    const ownerPrefix = ownerKind === 'group' ? 'group:' : 'character:';
    const suffix = `:chat:${id}`;
    const matches = Object.entries(chatWorlds || {})
        .filter(([chatKey, worldId]) => chatKey.startsWith(ownerPrefix) && chatKey.endsWith(suffix) && worldId);
    if (matches.length !== 1) return { binding: null, ambiguous: matches.length > 1 };
    const [[chatKey, worldId]] = matches;
    const sharedElsewhere = Object.entries(chatWorlds || {})
        .some(([otherKey, otherWorldId]) => otherKey !== chatKey && otherWorldId === worldId);
    return { binding: { chatKey, worldId, sharedElsewhere }, ambiguous: false };
}

export function resolveRenamedChatBinding(chatWorlds, eventData) {
    const oldFileName = String(eventData?.oldFileName || '').replace(/\.jsonl$/i, '');
    const newFileName = String(eventData?.newFileName || '').replace(/\.jsonl$/i, '');
    if (!oldFileName || !newFileName) return { binding: null, ambiguous: false };
    const oldSuffix = `:chat:${oldFileName}`;
    const hasGroupId = eventData?.groupId !== undefined && eventData.groupId !== null && eventData.groupId !== '';
    const exactGroupPrefix = hasGroupId ? `group:${eventData.groupId}:chat:` : null;
    const matches = Object.entries(chatWorlds || {}).filter(([chatKey, worldId]) => {
        if (!worldId || !chatKey.endsWith(oldSuffix)) return false;
        return exactGroupPrefix ? chatKey.startsWith(exactGroupPrefix) : chatKey.startsWith('character:');
    });
    if (matches.length !== 1) return { binding: null, ambiguous: matches.length > 1 };
    const [[oldChatKey, worldId]] = matches;
    const owner = oldChatKey.slice(0, -oldSuffix.length);
    return { binding: { oldChatKey, newChatKey: `${owner}:chat:${newFileName}`, worldId }, ambiguous: false };
}

export function resolveMissingWorldBinding(worlds, boundWorldId, { characterName, chatId } = {}) {
    const stored = Array.isArray(worlds) ? worlds : [];
    if (!boundWorldId || stored.some(world => world?.id === boundWorldId)) {
        return { world: null, ambiguous: false };
    }
    const expectedName = `${String(characterName || 'Chat')} · ${String(chatId || 'Memory')}`;
    const matches = stored.filter(world => world?.id && world.name === expectedName);
    return {
        world: matches.length === 1 ? matches[0] : null,
        ambiguous: matches.length > 1,
    };
}
