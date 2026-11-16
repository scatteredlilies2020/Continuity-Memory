// Deliberately contains no keys, headers, or device-local settings.
export function portableEmbeddingDescriptor(value, collectionId) {
    if (value?.version !== 1 || value.collectionId !== collectionId || !Array.isArray(value.hashes)
        || value.hashes.some(hash => typeof hash !== 'number' || !Number.isFinite(hash))) {
        throw new Error('Invalid synced embedding descriptor; keep the original files and finish syncing.');
    }
    if (value.cleared === true && !value.hashes.length) return { version: 1, collectionId, cleared: true, hashes: [] };
    const { source, model } = value.provider || {};
    if (!['vllm', 'openrouter'].includes(source) || typeof model !== 'string' || !model.trim() || model.length > 300) {
        throw new Error('Invalid synced embedding model.');
    }
    // Endpoints can contain passwords/tokens or point at an untrusted server.
    // Keep connection URLs and credentials local; only the model travels.
    return { version: 1, collectionId, provider: { source, model }, hashes: [...new Set(value.hashes)] };
}

export function embeddingDescriptorFilename(collectionId) {
    if (!/^continuity_[a-zA-Z0-9_-]{1,149}$/.test(collectionId)) throw new Error('Invalid portable embedding collection.');
    return `continuity-embedding-${collectionId}.json`;
}
