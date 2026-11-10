import { asRoleplayBlockingError, roleplayBacklogPolicy } from './generation-policy.js?v=0.15.0-testing.30&catchup-gate=3';

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

function waitForMemoryProgress({ readState, subscribe, stopSequence, signal, ready, work }) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        let waitedForActiveWork = false;
        let workPending = Boolean(work);
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            unsubscribe();
            signal?.removeEventListener('abort', cancel);
            if (error) reject(error); else resolve();
        };
        const cancel = () => finish(signal.reason);
        const inspect = () => {
            if (settled) return;
            try {
                const state = readState();
                assertMemoryRunning(state, stopSequence, signal);
                // Saved chunks can satisfy the gate while the same job is
                // still extracting, building Chronicle, or draining its queue.
                if (ready()) { finish(); return; }
                if (workPending || state.processing || state.queue?.length) {
                    waitedForActiveWork = true;
                    return;
                }
                // An earlier failed reply must not poison every later attempt.
                // Only propagate a failure from the task we actually waited on.
                if (waitedForActiveWork && state.status === 'error' && state.lastError) throw new Error(state.lastError);
                finish();
            } catch (error) { finish(error); }
        };
        signal?.addEventListener('abort', cancel, { once: true });
        unsubscribe = subscribe(inspect);
        if (settled) unsubscribe();
        inspect();
        if (work) Promise.resolve().then(() => {
            if (settled) return;
            signal?.throwIfAborted();
            return work();
        }).then(() => {
            workPending = false;
            inspect();
        }, error => finish(error));
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
    const waitOptions = { readState, subscribe, stopSequence, signal, ready: () => !backlog().shouldCatchUp };
    // No model call, subscription, or queue wait below the existing threshold.
    while (policy.shouldCatchUp) {
        assertMemoryRunning(readState(), stopSequence, signal);
        onWait(policy);
        await waitForMemoryProgress(waitOptions);
        policy = backlog();
        if (!policy.shouldCatchUp) break;
        // A queued task may have claimed the lock as the idle event was sent.
        if (readState().processing || readState().queue?.length) continue;
        const before = policy.pending;
        // Observe coverage as well as task completion. The shared extraction
        // continues independently once this reply has enough completed memory.
        await waitForMemoryProgress({ ...waitOptions, work: () => extract(sourceMessages) });
        assertMemoryRunning(readState(), stopSequence, signal);
        policy = backlog();
        if (policy.shouldCatchUp && policy.pending >= before) {
            throw asRoleplayBlockingError(new Error('Memory catch-up made no progress. The reply was cancelled; pending memory was preserved.'));
        }
    }
    return currentWorld();
}

// Source repair is not ordinary extraction backlog: even one deleted turn can
// invalidate a saved suffix. Finish it before selecting or reducing RP history.
export async function ensureGenerationSourceSync({ readState, subscribe, sync, signal, onWait = () => {} }) {
    const stopSequence = readState().stopSequence;
    onWait();
    while (true) {
        assertMemoryRunning(readState(), stopSequence, signal);
        await waitForMemoryProgress({ readState, subscribe, stopSequence, signal,
            ready: () => !readState().processing });
        const result = await waitForGenerationTask(sync, signal);
        assertMemoryRunning(readState(), stopSequence, signal);
        if (!result?.deferred) return result;
        if (!readState().processing) throw asRoleplayBlockingError(new Error('Source repair was deferred without active work. Retry the reply after memory repair.'));
    }
}
