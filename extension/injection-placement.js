export function resolveInjectionPlacement(settings, promptTypes, promptRoles) {
    const managerSlot = PROMPT_MANAGER_SLOTS[settings?.injectionPosition];
    const position = managerSlot
        ? (managerSlot.after ? promptTypes.IN_PROMPT : promptTypes.BEFORE_PROMPT)
        : ['before-main', 'before-an'].includes(settings?.injectionPosition)
            ? promptTypes.BEFORE_PROMPT
            : ['after-main', 'after-an'].includes(settings?.injectionPosition)
                ? promptTypes.IN_PROMPT
                : promptTypes.IN_CHAT;
    const roles = {
        system: promptRoles.SYSTEM,
        user: promptRoles.USER,
        assistant: promptRoles.ASSISTANT,
    };
    return {
        position,
        depth: settings?.injectionPosition === 'at-depth' ? Math.min(100, Math.max(0, Number(settings?.injectionDepth) || 0)) : 0,
        role: roles[settings?.injectionRole] ?? promptRoles.USER,
    };
}

export const PROMPT_MANAGER_SLOTS = Object.freeze({
    'before-character-definitions': { anchor: 'charDescription', after: false },
    'after-character-definitions': { anchor: 'scenario', after: true },
    'before-example-messages': { anchor: 'dialogueExamples', after: false },
    'after-example-messages': { anchor: 'dialogueExamples', after: true },
    'before-chat-history': { anchor: 'chatHistory', after: false },
    'after-chat-history': { anchor: 'chatHistory', after: true },
    'before-jailbreak': { anchor: 'jailbreak', after: false },
    'after-jailbreak': { anchor: 'jailbreak', after: true },
});
