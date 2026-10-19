// Local status/storage requests need a bounded browser wait, including body
// reads. Model generation belongs to detached jobs and has a progress watchdog.
export async function localRequest(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    let timer, onAbort;
    const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(new Error('Continuity server request timed out.')), timeoutMs);
    });
    try {
        return await Promise.race([(async () => {
            controller.signal.throwIfAborted();
            const response = await fetch(url, { ...options, signal: controller.signal });
            const text = await response.text();
            controller.signal.throwIfAborted();
            return { response, text };
        })(), cancelled]);
    } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        options.signal?.removeEventListener('abort', abort);
    }
}
