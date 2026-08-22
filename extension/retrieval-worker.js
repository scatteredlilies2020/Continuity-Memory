import { buildMemoryPrompt } from './retrieval.js?v=0.14.0-standalone.259';

globalThis.addEventListener('message', event => {
    const { id, args } = event.data || {};
    if (!id || !Array.isArray(args)) return;
    try {
        globalThis.postMessage({ id, result: buildMemoryPrompt(...args) });
    } catch (error) {
        globalThis.postMessage({
            id,
            error: {
                message: error?.message || String(error),
                stack: error?.stack || '',
            },
        });
    }
});

