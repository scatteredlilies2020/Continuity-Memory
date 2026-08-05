export function canReduceContext(settings, coreChat, type) {
    if (!settings?.enabled || !settings?.contextReductionEnabled) return false;
    if (!Array.isArray(coreChat) || !coreChat.length) return false;
    return type !== 'quiet' && type !== 'impersonate';
}
