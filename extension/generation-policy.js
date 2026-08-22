import { completeL1MessageCount, resolveL1GroupSize } from './l1-policy.js';

export const ROLEPLAY_BLOCKED_CODE = 'CONTINUITY_ROLEPLAY_BLOCKED';

export function shouldGateRoleplayGeneration(settings, coreChat, type) {
    if (!settings?.enabled || !Array.isArray(coreChat) || type === 'quiet' || type === 'impersonate') return false;
    return coreChat.length > 0 || type === 'swipe' || type === 'regenerate';
}

export function roleplayBacklogPolicy(pendingMessages, groupSize, requiredMessages = 0) {
    const size = resolveL1GroupSize(groupSize);
    const pending = Math.max(0, Math.round(Number(pendingMessages) || 0));
    const eligible = completeL1MessageCount(pending, size);
    const required = Math.max(0, Math.round(Number(requiredMessages) || 0));
    const hardLimit = size * 2;
    return {
        pending,
        eligible,
        required,
        blocking: required || eligible,
        backgroundThreshold: size,
        hardLimit,
        shouldCatchUp: required > 0 || pending >= hardLimit,
    };
}

export function roleplayStoryBacklogPolicy(pendingMessages, batchSize, repairRequired = false) {
    const size = Math.max(2, Math.round(Number(batchSize) || 8));
    const pending = Math.max(0, Math.round(Number(pendingMessages) || 0));
    const eligible = Math.floor(pending / size) * size;
    const hardLimit = size * 2;
    return {
        pending,
        eligible,
        repairRequired: Boolean(repairRequired),
        blocking: repairRequired ? Math.max(1, pending) : eligible,
        backgroundThreshold: size,
        hardLimit,
        shouldCatchUp: Boolean(repairRequired) || pending >= hardLimit,
    };
}

export function asRoleplayBlockingError(error, prefix = '') {
    const source = error instanceof Error ? error : new Error(String(error || 'Continuity safety preparation failed.'));
    if (source.code === ROLEPLAY_BLOCKED_CODE && !prefix) return source;
    const message = [prefix, source.message].filter(Boolean).join(' ');
    const blocked = new Error(message, { cause: source });
    blocked.code = ROLEPLAY_BLOCKED_CODE;
    return blocked;
}

export function isRoleplayBlockingError(error) {
    return error?.code === ROLEPLAY_BLOCKED_CODE;
}

export function roleplaySourceMessages(messages, type) {
    const active = Array.isArray(messages) ? messages.slice() : [];
    if (type === 'swipe') active.pop();
    return active;
}

export function sourceMutationPolicy(protectedTail = false) {
    return {
        invalidateActiveWork: !protectedTail,
        repairSuffix: !protectedTail,
    };
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
