export function shouldGateRoleplayGeneration(settings, coreChat, type) {
    if (!settings?.enabled || !Array.isArray(coreChat) || type === 'quiet' || type === 'impersonate') return false;
    return coreChat.length > 0 || type === 'swipe' || type === 'regenerate';
}

export function roleplaySourceMessages(messages, type) {
    const active = Array.isArray(messages) ? messages.slice() : [];
    if (type === 'swipe') active.pop();
    return active;
}
