import { getRequestHeaders } from '/script.js';
import { createFileStorageApi } from './file-storage.js?v=0.14.0-standalone.60';

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
    return await backend.api[method](...args);
}

export const api = {
    health: () => call('health'),
    listWorlds: () => call('listWorlds'),
    getWorld: id => call('getWorld', id),
    createWorld: name => call('createWorld', name),
    saveWorld: world => call('saveWorld', world),
    deleteWorld: id => call('deleteWorld', id),
    importWorld: world => call('importWorld', world),
};
