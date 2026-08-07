const listeners = new Set();

export const runtime = {
    status: 'idle',
    paused: false,
    queue: [],
    processing: false,
    generation: 0,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: '',
    lastRawResponse: '',
    lastValidation: '',
    lastInjection: '',
    lastInjectionTokens: 0,
    injectionStatus: 'Checking memory injection…',
    contextReduction: { mode: 'waiting', hiddenMessages: 0, hiddenTokens: 0, tailMessages: 0, tailTurns: 0, tailTokens: 0, tailBudget: 0, fixedPromptTokens: null, totalPromptTokens: null, safetyTokens: 0 },
    progress: null,
    world: null,
    health: null,
};

export function updateRuntime(patch) {
    Object.assign(runtime, patch);
    for (const listener of listeners) {
        try { listener(runtime); } catch (error) { console.error('[Continuity] Runtime listener failed', error); }
    }
}

export function onRuntimeChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function stopRuntime() {
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error('Processing stopped and the queue was cleared.'));
    updateRuntime({ paused: true, status: 'paused', progress: null });
}

export function pauseRuntime() {
    runtime.generation++;
    updateRuntime({ paused: true, status: 'paused', progress: null });
}

export function resumeRuntime() {
    updateRuntime({ paused: false, status: runtime.processing ? 'processing' : 'idle' });
}

export function invalidateRuntimeWork(reason = 'Chat changed while memory processing was active.') {
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error(reason));
    updateRuntime({ progress: null, retryStatus: reason });
    return { invalidated: runtime.processing || queued.length > 0, queued: queued.length };
}
