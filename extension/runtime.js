import { cancelExtractionReview } from './extraction-review.js';

const listeners = new Set();
const stopHandlers = new Set();

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
    pendingExtractionReview: null,
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

export function onRuntimeStop(handler) {
    stopHandlers.add(handler);
    return () => stopHandlers.delete(handler);
}

function notifyStopHandlers(reason) {
    for (const handler of stopHandlers) {
        try { void handler(reason); } catch (error) { console.error('[Continuity] Runtime stop handler failed', error); }
    }
}

export function stopRuntime() {
    const reason = 'Processing stopped; the reviewed memory was not saved.';
    cancelExtractionReview(reason);
    notifyStopHandlers(reason);
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error('Processing stopped and the queue was cleared.'));
    updateRuntime({ paused: true, status: 'paused', progress: null });
}

export function pauseRuntime() {
    const reason = 'Processing paused; the reviewed memory was not saved.';
    cancelExtractionReview(reason);
    notifyStopHandlers(reason);
    runtime.generation++;
    updateRuntime({ paused: true, status: 'paused', progress: null });
}

export function resumeRuntime() {
    updateRuntime({ paused: false, status: runtime.processing ? 'processing' : 'idle' });
}

export function invalidateRuntimeWork(reason = 'Chat changed while memory processing was active.') {
    cancelExtractionReview(reason);
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error(reason));
    updateRuntime({ progress: null, retryStatus: reason });
    return { invalidated: runtime.processing || queued.length > 0, queued: queued.length };
}
