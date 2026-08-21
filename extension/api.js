import { getRequestHeaders } from '/script.js';
import { createFileStorageApi } from './file-storage.js?v=0.14.0-standalone.222';
import { migrateLegacyBeliefs } from './attributed-beliefs.js';

const BASE = '/api/plugins/continuity-memory';
const fileApi = createFileStorageApi({ requestHeaders: getRequestHeaders });
let backendPromise;

async function request(path, options = {}) {
    const response = await fetch(`${BASE}${path}`, {
        ...options,
        headers: options.body ? getRequestHeaders() : undefined,
    });
    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = { error: text || response.statusText };
    }
    if (!response.ok) {
        const error = new Error(payload.error || `${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}

const pluginApi = {
    health: () => request('/health'),
    listWorlds: () => request('/worlds'),
    getWorld: id => request(`/worlds/${encodeURIComponent(id)}`),
    createWorld: name => request('/worlds', { method: 'POST', body: JSON.stringify({ name }) }),
    saveWorld: world => request(`/worlds/${encodeURIComponent(world.id)}`, { method: 'PUT', body: JSON.stringify(world) }),
    deleteWorld: id => request(`/worlds/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({}) }),
    importWorld: world => request('/import', { method: 'POST', body: JSON.stringify({ world }) }),
    migrateWorld: world => request('/migrate-world', { method: 'POST', body: JSON.stringify({ world }) }),
    startExtractionJob: job => request('/extraction-jobs', { method: 'POST', body: JSON.stringify(job) }),
    getExtractionJob: id => request(`/extraction-jobs/${encodeURIComponent(id)}`),
    listExtractionJobs: ({ worldId = '', chatKey = '' } = {}) => request(`/extraction-jobs?worldId=${encodeURIComponent(worldId)}&chatKey=${encodeURIComponent(chatKey)}`),
    cancelExtractionJob: id => request(`/extraction-jobs/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({}) }),
};

async function getBackend() {
    if (!backendPromise) {
        backendPromise = (async () => {
            try {
                const health = await pluginApi.health();
                return { api: pluginApi, health };
            } catch (error) {
                if (error.status !== 404) console.warn('[Continuity] Server storage plugin unavailable; using SillyTavern file storage.', error);
                return { api: fileApi, health: null };
            }
        })();
    }
    return await backendPromise;
}

async function call(method, ...args) {
    const backend = await getBackend();
    if (method === 'health' && backend.health) return backend.health;
    if (backend.api === pluginApi && method === 'listWorlds') {
        const [current, legacy] = await Promise.all([pluginApi.listWorlds(), fileApi.listWorlds()]);
        const worlds = new Map(legacy.worlds.map(world => [world.id, world]));
        for (const world of current.worlds) worlds.set(world.id, world);
        return { ok: true, worlds: [...worlds.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))) };
    }
    if (backend.api === pluginApi && method === 'deleteWorld') {
        const result = await pluginApi.deleteWorld(...args);
        try { await fileApi.deleteWorld(...args); }
        catch (error) { if (error.status !== 404) console.warn('[Continuity] Could not remove the retired file-storage copy.', error); }
        return result;
    }
    let result;
    try {
        result = await backend.api[method](...args);
    } catch (error) {
        if (backend.api !== pluginApi || method !== 'getWorld' || error.status !== 404) throw error;
        const legacy = await fileApi.getWorld(...args);
        result = await pluginApi.migrateWorld(legacy.world);
        console.info(`[Continuity] Migrated world ${legacy.world.id} into detached server storage; the former file copy remains as a backup.`);
    }
    if (result?.world) migrateLegacyBeliefs(result.world);
    return result;
}

export const api = {
    health: () => call('health'),
    listWorlds: () => call('listWorlds'),
    getWorld: id => call('getWorld', id),
    createWorld: name => call('createWorld', name),
    saveWorld: world => call('saveWorld', world),
    deleteWorld: id => call('deleteWorld', id),
    importWorld: world => call('importWorld', world),
    startExtractionJob: job => call('startExtractionJob', job),
    getExtractionJob: id => call('getExtractionJob', id),
    listExtractionJobs: filter => call('listExtractionJobs', filter),
    cancelExtractionJob: id => call('cancelExtractionJob', id),
};
