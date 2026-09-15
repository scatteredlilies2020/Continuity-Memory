// A provider failure must never prevent roleplay. This bounds the complete
// lookup (including index inspection), forwards cancellation where supported,
// and never applies a result that arrives after the deadline.
export async function resolveRetrievalAssist({ mode, phase, world, messages, query, expand, timeoutMs = 10000 }) {
    const assist = { mode: 'local', phase, executed: true, terms: [], fallback: false, reason: 'local', semanticMatches: 0 };
    const ai = mode === 'ai-expanded';
    if (!ai && mode !== 'embedding-hybrid') return { ranks: new Map(), terms: [], assist };
    const label = ai ? 'AI retrieval' : 'Embedding lookup';
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out; local recall used for this prompt.`);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    try {
        const result = await Promise.race([
            Promise.resolve().then(() => ai ? expand(messages, { signal: controller.signal }) : query(world, messages, { signal: controller.signal })),
            timeout,
        ]);
        if (ai) return { ranks: new Map(), terms: result, assist: { ...assist, mode, terms: result, reason: result.length ? 'ai-and-local' : 'no-ai-terms' } };
        const ranks = result;
        return { ranks, terms: [], assist: { ...assist, mode: 'embedding-hybrid', reason: ranks.size ? 'semantic-and-local' : 'no-semantic-matches', semanticMatches: ranks.size } };
    } catch (error) {
        return { ranks: new Map(), terms: [], assist: { ...assist, requestedMode: mode, fallback: true, reason: `${ai ? 'ai' : 'embedding'}-${controller.signal.aborted ? 'timeout' : 'unavailable'}`, error: String(error?.message || error) } };
    } finally {
        clearTimeout(timer);
    }
}
