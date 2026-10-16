import { asRoleplayBlockingError, roleplayBacklogPolicy } from './generation-policy.js?v=0.15.0-testing.30';

// Stop waiting for shared work without stopping the work itself. Extraction
// and index builds belong to CM's controls, independently of the RP Stop.
export function waitForGenerationTask(work, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return work();
        }).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel));
    });
}

function assertMemoryRunning(state, stopSequence, signal) {
    signal?.throwIfAborted();
    if (state.stopSequence !== stopSequence || state.paused) {
        throw asRoleplayBlockingError(new Error('Memory processing is paused or stopped. Resume it before retrying this reply.'));
    }
}

function waitForMemoryIdle({ readState, subscribe, stopSequence, signal }) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', cancel); };
        const cancel = () => { cleanup(); reject(signal.reason); };
        const inspect = () => {
            try {
                const state = readState();
                assertMemoryRunning(state, stopSequence, signal);
                if (state.processing || state.queue?.length) return;
                if (state.status === 'error' && state.lastError) throw new Error(state.lastError);
                cleanup();
                resolve();
            } catch (error) { cleanup(); reject(error); }
        };
        unsubscribe = subscribe(inspect);
        signal?.addEventListener('abort', cancel, { once: true });
        inspect();
    });
}

export async function ensureGenerationMemory({ sourceMessages, batchSize, currentWorld, getCoverage,
    readState, subscribe, extract, onWait = () => {}, signal }) {
    const stopSequence = readState().stopSequence;
    const backlog = () => {
        const coverage = getCoverage(currentWorld(), sourceMessages);
        return roleplayBacklogPolicy(coverage.extractable, batchSize, coverage.required);
    };
    let policy = backlog();
    // No model call, subscription, or queue wait below the existing threshold.
    while (policy.shouldCatchUp) {
        assertMemoryRunning(readState(), stopSequence, signal);
        onWait(policy);
        await waitForMemoryIdle({ readState, subscribe, stopSequence, signal });
        policy = backlog();
        if (!policy.shouldCatchUp) break;
        // A queued task may have claimed the lock as the idle event was sent.
        if (readState().processing || readState().queue?.length) continue;
        const before = policy.pending;
        await waitForGenerationTask(() => extract(sourceMessages), signal);
        assertMemoryRunning(readState(), stopSequence, signal);
        policy = backlog();
        if (policy.shouldCatchUp && policy.pending >= before) {
            throw asRoleplayBlockingError(new Error('Memory catch-up made no progress. The reply was cancelled; pending memory was preserved.'));
        }
    }
    return currentWorld();
}
