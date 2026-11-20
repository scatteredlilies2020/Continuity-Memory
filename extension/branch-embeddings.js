import { buildEmbeddingDocuments } from './embedding-index.js?v=0.15.0-testing.30&historical-recall=1';
import { embeddingCollectionId } from './embedding-portability.js?branch-vectors=1';
import { vectorStorageError } from './vector-storage-client.js?portable-vectors=1&cache-status=1';

export async function inheritBranchEmbeddings(parentWorldId, branch, headers, fetchFn = fetch) {
    if (!parentWorldId || !branch?.id || parentWorldId === branch.id) return;
    const items = buildEmbeddingDocuments(structuredClone(branch)).map(({ hash, text, index }) => ({ hash, text, index }));
    if (!items.length) return;
    const response = await fetchFn('/api/plugins/continuity-memory/vectors/native/fork', {
        method: 'POST', headers, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ parentCollectionId: embeddingCollectionId(parentWorldId),
            collectionId: embeddingCollectionId(branch.id), items }),
    });
    // No provider calls or emulated cache copy with an older/missing plugin.
    if (!response.ok && response.status !== 404) throw await vectorStorageError('inherit branch cache', response);
}
