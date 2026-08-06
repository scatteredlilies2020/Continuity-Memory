export function shouldGateRoleplayGeneration(settings, coreChat, type) {
    if (!settings?.enabled || !Array.isArray(coreChat) || type === 'quiet' || type === 'impersonate') return false;
    return coreChat.length > 0 || type === 'swipe' || type === 'regenerate';
}

export function roleplaySourceMessages(messages, type) {
    const active = Array.isArray(messages) ? messages.slice() : [];
    if (type === 'swipe') active.pop();
    return active;
}

export function roleplayWaitNotification(state, eligiblePending = 0) {
    const queueLength = Math.max(0, Number(state?.queue?.length) || 0);
    const pending = Math.max(0, Number(eligiblePending) || 0);
    const processing = Boolean(state?.processing);
    const paused = Boolean(state?.paused);
    if (!processing && !paused && !queueLength && !pending) return '';

    const details = [];
    if (pending) details.push(`${pending} message${pending === 1 ? '' : 's'} awaiting L1 extraction`);
    if (processing && state?.progress?.from !== undefined && state?.progress?.to !== undefined) {
        details.push(`currently processing messages ${state.progress.from}–${state.progress.to}`);
    } else if (processing) {
        details.push('one memory task currently processing');
    }
    if (queueLength) details.push(`${queueLength} queued memory job${queueLength === 1 ? '' : 's'}`);
    if (paused) details.push('paused processing will resume');
    return `Continuity is finishing memory before roleplay${details.length ? `: ${details.join('; ')}` : ''}. Your reply will start automatically when it is ready.`;
}
