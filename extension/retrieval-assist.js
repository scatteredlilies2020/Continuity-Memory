import { errorChainText, isTransientApiError } from './errors.js?v=0.15.0-testing.30';

export const GENERATION_RETRIEVAL_TIMEOUT_MS = 30000;

// Check elapsed time as well as the abort signal: a suspended browser may
// deliver a completed request before its overdue timeout callback.
export function checkRetrievalDeadline(signal, deadline = Infinity) {
    signal?.throwIfAborted();
    if (Date.now() >= (typeof deadline === 'function' ? deadline() : deadline)) throw new DOMException('Retrieval deadline exceeded.', 'TimeoutError');
}

// Preparation and response waiting have separate budgets. Start the response
// clock at the transport's dispatch callback, once, including any AI retries.
export async function resolveRetrievalAssist({ mode, phase, world, messages, query, expand, signal,
    timeoutMs = phase === 'generation' ? GENERATION_RETRIEVAL_TIMEOUT_MS : 10000, preparationTimeoutMs = timeoutMs }) {
    const assist = { mode: 'local', phase, executed: true, terms: [], fallback: false, reason: 'local', semanticMatches: 0 };
    const ai = mode === 'ai-expanded';
    if (!ai && mode !== 'embedding-hybrid') return { ranks: new Map(), terms: [], assist };
    const label = ai ? 'AI retrieval' : 'Embedding lookup';
    const controller = new AbortController();
    const startedAt = Date.now();
    let deadline = startedAt + preparationTimeoutMs;
    let dispatchedAt = null;
    let finished = false;
    let timer;
    let timedOut = false;
    let rejectInterrupt;
    const interrupted = new Promise((_, reject) => { rejectInterrupt = reject; });
    const expire = () => {
        if (finished) return;
        timedOut = true;
        const error = new Error(`${label} timed out; local recall used for this prompt.`);
        controller.abort(error);
        rejectInterrupt(error);
    };
    const onDispatch = () => {
        if (finished) return;
        checkRetrievalDeadline(controller.signal, deadline);
        if (dispatchedAt !== null) return;
        dispatchedAt = Date.now();
        deadline = dispatchedAt + timeoutMs;
        clearTimeout(timer);
        timer = setTimeout(expire, timeoutMs);
    };
    const checkDeadline = () => { if (Date.now() >= deadline) expire(); };
    const cancel = () => {
        const error = signal.reason || new DOMException('Retrieval cancelled.', 'AbortError');
        controller.abort(error);
        rejectInterrupt(error);
    };
    timer = setTimeout(expire, preparationTimeoutMs);
    globalThis.document?.addEventListener('visibilitychange', checkDeadline);
    globalThis.addEventListener?.('pageshow', checkDeadline);
    globalThis.addEventListener?.('focus', checkDeadline);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const lookup = Promise.resolve().then(() => {
        checkRetrievalDeadline(controller.signal, deadline);
        const options = { signal: controller.signal, deadline: () => deadline, onDispatch };
        return ai ? expand(messages, options) : query(world, messages, options);
    });
    try {
        const result = await Promise.race([lookup, interrupted]);
        checkRetrievalDeadline(controller.signal, deadline);
        const timing = { dispatched: dispatchedAt !== null, preparationMs: (dispatchedAt ?? Date.now()) - startedAt,
            responseMs: dispatchedAt === null ? 0 : Date.now() - dispatchedAt };
        if (ai) return { ranks: new Map(), terms: result, assist: { ...assist, ...timing, mode, terms: result, reason: result.length ? 'ai-and-local' : 'no-ai-terms' } };
        const ranks = result;
        return { ranks, terms: [], assist: { ...assist, ...timing, mode: 'embedding-hybrid', reason: ranks.size ? 'semantic-and-local' : 'no-semantic-matches', semanticMatches: ranks.size } };
    } catch (error) {
        // Also reject a response delivered after the budget when the browser
        // has not yet run the timer. Cancel the underlying provider request.
        if (!signal?.aborted && Date.now() >= deadline) {
            timedOut = true;
            controller.abort(error);
        }
        const reason = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'unavailable';
        return { ranks: new Map(), terms: [], assist: { ...assist, requestedMode: mode, fallback: true, reason: `${ai ? 'ai' : 'embedding'}-${reason}`,
            ...(reason === 'timeout' ? { timeoutStage: dispatchedAt === null ? 'preparation' : 'response' } : {}),
            dispatched: dispatchedAt !== null, preparationMs: (dispatchedAt ?? Date.now()) - startedAt,
            responseMs: dispatchedAt === null ? 0 : Date.now() - dispatchedAt,
            retryable: reason === 'timeout' || isTransientApiError(error),
            ...(error?.code ? { code: error.code } : {}), error: errorChainText(error) || String(error) } };
    } finally {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        globalThis.document?.removeEventListener('visibilitychange', checkDeadline);
        globalThis.removeEventListener?.('pageshow', checkDeadline);
        globalThis.removeEventListener?.('focus', checkDeadline);
    }
}
