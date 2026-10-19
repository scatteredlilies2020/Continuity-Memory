import { isTransientApiError } from './errors.js';

// A connection outage leaves the same operation pending. Validated results
// belong outside this callback so retrying storage never buys another response.
export async function retryConnection(operation, {
    signal, wait = delay => waitForConnection(delay, signal), onRetry = () => {},
    retryDelayMs = 2000, maxRetryDelayMs = 60000, maxAttempts = Infinity,
    retryable = isTransientApiError,
} = {}) {
    for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        try {
            const result = await operation();
            signal?.throwIfAborted();
            return result;
        } catch (error) {
            signal?.throwIfAborted();
            if (!retryable(error) || attempt >= maxAttempts) throw error;
            const delay = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(10, attempt - 1));
            onRetry(error, delay, attempt);
            await wait(delay);
        }
    }
}

export function waitForConnection(delay, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', cancel);
        const cancel = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
    });
}
