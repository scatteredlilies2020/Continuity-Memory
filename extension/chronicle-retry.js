import { errorChainText, isTransientApiError } from './errors.js';

export function isRetryableChronicleError(error) {
    if (error?.status === 409) return true;
    if (isTransientApiError(error)) return true;
    return /(?:without a valid JSON object|summarizer returned no (?:JSON object|summary)|field ".+" is not an array|OOC provenance violation|returned no text|reached its output limit|output (?:was |is )?(?:truncated|incomplete)|Chronicle sources changed)/iu.test(errorChainText(error));
}

export function waitForChronicleRetry(delay, signal) {
    return new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal.reason); };
        const timer = setTimeout(finish, delay);
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
    });
}

export function chronicleRetryFeedback(error) {
    if (!error || error.status === 409 || /Chronicle sources changed/u.test(error.message) || isTransientApiError(error)) return '';
    return `\n\nThe previous parent failed validation: ${String(error.message).slice(0, 1200)}\nGenerate a corrected, complete JSON parent from the same sources. Preserve source attribution; author notes must not become character speech or knowledge. Use neutral narration for author-level context. Return all required fields and a nonempty summary.`;
}

export async function retryChroniclePromotion(attempt, {
    signal,
    wait = delay => waitForChronicleRetry(delay, signal),
    onRetry = () => {},
    retryDelayMs = 2000,
    maxRetryDelayMs = 60000,
} = {}) {
    let previousError = null;
    for (let failures = 0; ; failures++) {
        signal?.throwIfAborted();
        try {
            const result = await attempt(previousError);
            signal?.throwIfAborted();
            return result;
        } catch (error) {
            signal?.throwIfAborted();
            if (!isRetryableChronicleError(error)) throw error;
            // A transport failure must not erase correction feedback from the
            // last actual model response.
            if (!previousError || !isTransientApiError(error)) previousError = error;
            const delay = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** Math.min(10, failures)));
            onRetry(error, delay, failures + 1);
            await wait(delay);
        }
    }
}
