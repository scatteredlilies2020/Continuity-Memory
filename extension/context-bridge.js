function fastHash(value) {
    const source = String(value ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function contextIdentity(context = {}) {
    const chatId = String(context.getCurrentChatId?.() ?? context.chatId ?? '');
    const owner = context.groupId
        ? `group:${context.groupId}`
        : `character:${context.characterId ?? 'unknown'}`;
    const messages = (Array.isArray(context.chat) ? context.chat : [])
        .map((message, index) => ({
            index,
            name: String(message?.name || ''),
            text: String(message?.mes || ''),
            user: Boolean(message?.is_user),
            system: Boolean(message?.is_system),
        }))
        .filter(message => !message.system && message.text.trim());
    return {
        chatId,
        key: chatId ? `${owner}:chat:${chatId}` : '',
        signature: fastHash(JSON.stringify([messages.length, messages.slice(-12)])),
    };
}

export function createContinuityContextBridge(readContext) {
    let revision = 0;
    let snapshot = {
        chatId: '',
        key: '',
        signature: '',
        prompt: '',
        revision: 0,
        updatedAt: 0,
    };

    function publish(prompt = '') {
        const identity = contextIdentity(readContext?.() || {});
        snapshot = {
            ...identity,
            prompt: typeof prompt === 'string' ? prompt : '',
            revision: ++revision,
            updatedAt: Date.now(),
        };
    }

    const bridge = Object.freeze({
        version: 1,
        getContextSnapshot() {
            const current = contextIdentity(readContext?.() || {});
            const aligned = Boolean(
                snapshot.key
                && snapshot.key === current.key
                && snapshot.signature === current.signature,
            );
            const status = snapshot.prompt
                ? (aligned ? 'current' : 'stale')
                : 'unavailable';
            return {
                chatId: snapshot.chatId,
                prompt: snapshot.prompt,
                revision: snapshot.revision,
                updatedAt: snapshot.updatedAt,
                status,
            };
        },
    });

    return { bridge, publish };
}
