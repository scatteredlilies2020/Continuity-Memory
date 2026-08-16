export function createRetrievalSnapshot({
    phase,
    assist,
    diagnostics,
    prompt,
    tokens,
    budget,
    status,
    capturedAt = new Date().toISOString(),
}) {
    return {
        phase: phase === 'generation' ? 'generation' : 'preview',
        capturedAt,
        assist: assist || null,
        retrieval: diagnostics || null,
        injection: String(prompt || ''),
        injectionTokens: Math.max(0, Math.round(Number(tokens) || 0)),
        injectionBudget: budget || null,
        injectionStatus: String(status || ''),
    };
}

export function retrievalSnapshotPatch(snapshot) {
    if (!snapshot) return {};
    return snapshot.phase === 'generation'
        ? { lastGenerationRetrieval: snapshot }
        : { nextRetrievalPreview: snapshot };
}

export function retrievalSnapshotDiagnostics(snapshot) {
    if (!snapshot) return null;
    const { injection: _injection, ...diagnostics } = snapshot;
    return diagnostics;
}
