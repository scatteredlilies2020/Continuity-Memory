// Run with SillyTavern stopped. Read-only unless --write is supplied.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveIndexedEmbeddingProvider } from '../extension/embedding-provider.js';
import { embeddingDescriptorFilename, portableEmbeddingDescriptor } from '../extension/embedding-portability.js';
import { registerNativeVectorRoutes } from '../plugin/native-vector-store.js';
import { fingerprint } from '../plugin/vector-store.js';
import { readStorageJson } from '../plugin/storage-json.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const target = args.find(arg => !arg.startsWith('--'));
if (!target || args.some(arg => arg.startsWith('--') && arg !== '--write')) {
    console.error('Usage: node scripts/migrate-embedding-cache.mjs <SillyTavern user data directory> [--write]');
    process.exitCode = 1;
} else {
    const root = path.resolve(target);
    const settings = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).extension_settings?.continuityMemory || {};
    const directories = { root, vectors: path.join(root, 'vectors'), files: path.join(root, 'user', 'files') };
    const routes = new Map();
    registerNativeVectorRoutes({ post(route, handler) { routes.set(route, handler); } }, {
        embedTexts: async () => { throw new Error('Migration must never request embeddings'); },
    });
    const oldRoot = path.join(root, 'continuity-memory', 'vectors');
    let collections = [];
    try { collections = await fs.readdir(oldRoot, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let processed = 0, vectors = 0;
    for (const entry of collections) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^continuity_[a-zA-Z0-9_-]{1,149}$/.test(entry.name)) continue;
        const collectionId = entry.name;
        let saved;
        try { saved = portableEmbeddingDescriptor(JSON.parse(await fs.readFile(path.join(directories.files, embeddingDescriptorFilename(collectionId)), 'utf8')), collectionId); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const provider = resolveIndexedEmbeddingProvider(settings, saved?.provider).body;
        const file = path.join(oldRoot, collectionId, `${fingerprint({ source: provider.source, model: provider.model, apiUrl: provider.apiUrl })}.json`);
        let cache;
        try { cache = await readStorageJson(file); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!cache.items?.length && !saved?.hashes.length) continue;
        let count = cache.items.length;
        if (write) {
            let status = 200, result;
            await routes.get('/vectors/native/list')({ body: { ...provider, collectionId }, user: { directories } }, {
                status(code) { status = code; return this; }, json(value) { result = value; return this; },
            });
            if (status !== 200) throw new Error(`Migration stopped for ${collectionId}: ${result?.error || status}`);
            count = result.length;
        }
        processed++;
        vectors += count;
        console.log(`${write ? 'Verified native cache' : 'Candidate'}: ${collectionId} (${count} vectors)`);
    }
    console.log(`${write ? 'Verified' : 'Dry run:'} ${processed} collections, ${vectors} vectors. Original detached caches retained. No embedding requests.`);
}
