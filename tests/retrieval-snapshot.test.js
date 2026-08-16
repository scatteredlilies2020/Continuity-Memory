import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createRetrievalSnapshot,
    retrievalSnapshotDiagnostics,
    retrievalSnapshotPatch,
} from '../extension/retrieval-snapshot.js';

test('a next-reply preview cannot overwrite the last generation retrieval', () => {
    const state = {};
    const generation = createRetrievalSnapshot({
        phase: 'generation',
        assist: { mode: 'ai-expanded', phase: 'generation', terms: ['Rem and Samael'] },
        diagnostics: { query: { direct: ['fetch'] }, selections: [{ id: 'relationship-rem-samael' }] },
        prompt: '<continuity>generation memory</continuity>',
        tokens: 1200,
        budget: { mode: 'dynamic', tokens: 12800 },
        status: 'Generation memory ready.',
        capturedAt: '2026-08-16T13:13:46.000Z',
    });
    Object.assign(state, retrievalSnapshotPatch(generation));

    const preview = createRetrievalSnapshot({
        phase: 'preview',
        assist: { mode: 'ai-expanded', phase: 'preview', terms: ['cloak details from completed reply'] },
        diagnostics: { query: { direct: ['next'] }, selections: [{ id: 'different-preview-record' }] },
        prompt: '<continuity>next reply preview</continuity>',
        tokens: 800,
        budget: { mode: 'dynamic', tokens: 12800 },
        status: 'Preview ready.',
        capturedAt: '2026-08-16T13:14:24.000Z',
    });
    Object.assign(state, retrievalSnapshotPatch(preview));

    assert.equal(state.lastGenerationRetrieval.injection, '<continuity>generation memory</continuity>');
    assert.deepEqual(state.lastGenerationRetrieval.retrieval.selections, [{ id: 'relationship-rem-samael' }]);
    assert.equal(state.nextRetrievalPreview.injection, '<continuity>next reply preview</continuity>');
    assert.deepEqual(state.nextRetrievalPreview.retrieval.selections, [{ id: 'different-preview-record' }]);
});

test('diagnostic snapshots omit duplicated prompt text but retain retrieval evidence', () => {
    const snapshot = createRetrievalSnapshot({
        phase: 'generation',
        assist: { mode: 'local', phase: 'generation' },
        diagnostics: { selections: [{ id: 'fact-1' }] },
        prompt: 'large injected prompt',
        tokens: 42.4,
        status: 'Ready.',
        capturedAt: '2026-08-16T00:00:00.000Z',
    });
    const diagnostics = retrievalSnapshotDiagnostics(snapshot);

    assert.equal('injection' in diagnostics, false);
    assert.equal(diagnostics.injectionTokens, 42);
    assert.deepEqual(diagnostics.retrieval.selections, [{ id: 'fact-1' }]);
});
