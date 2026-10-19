// Browsing can use a completed query cache, but cannot dispatch a provider
// lookup or wake an incomplete embedding build. The reply owns live retrieval.
export function previewRetrieval({ mode, world, messages, peekEmbedding }) {
    let ranks = null;
    if (mode === 'embedding-hybrid') {
        try { ranks = peekEmbedding?.(world, messages); } catch { /* use local recall */ }
    }
    return { ranks: ranks || new Map(), terms: [], assist: {
        mode: ranks ? 'embedding-hybrid' : 'local', requestedMode: mode, phase: 'preview',
        executed: Boolean(ranks), fallback: false, terms: [], semanticMatches: ranks?.size || 0,
        reason: ranks ? 'cached-semantic-and-local' : 'saved-memory-preview',
    } };
}
