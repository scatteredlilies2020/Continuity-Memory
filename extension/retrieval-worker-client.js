import { buildMemoryPrompt } from './retrieval.js?v=0.14.0-standalone.259';

let nextRequestId = 0;

function workerSupported() {
    return typeof globalThis.Worker === 'function' && typeof globalThis.document !== 'undefined';
}

export function buildMemoryPromptResponsive(...args) {
    if (!workerSupported()) return Promise.resolve(buildMemoryPrompt(...args));

    return new Promise((resolve, reject) => {
        const worker = new globalThis.Worker(
            new URL('./retrieval-worker.js?v=0.14.0-standalone.259', import.meta.url),
            { type: 'module', name: 'continuity-memory-retrieval' },
        );
        const id = ++nextRequestId;
        const finish = callback => value => {
            worker.terminate();
            callback(value);
        };
        worker.addEventListener('message', finish(event => {
            if (event.data?.id !== id) return;
            if (event.data?.error) {
                const error = new Error(event.data.error.message || 'Continuity retrieval worker failed.');
                error.stack = event.data.error.stack || error.stack;
                reject(error);
                return;
            }
            resolve(event.data?.result);
        }), { once: true });
        worker.addEventListener('error', finish(event => {
            reject(new Error(event.message || 'Continuity retrieval worker failed to load.'));
        }), { once: true });
        try {
            worker.postMessage({ id, args });
        } catch (error) {
            worker.terminate();
            resolve(buildMemoryPrompt(...args));
        }
    });
}

