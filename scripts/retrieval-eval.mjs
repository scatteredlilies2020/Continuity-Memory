import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildMemoryPrompt } from '../extension/retrieval.js';

function argument(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

async function loadWorld(manifestPath) {
    const manifest = await readJson(manifestPath);
    const world = { ...manifest };
    delete world.shards;
    for (const [category, descriptors] of Object.entries(manifest.shards || {})) {
        const values = [];
        for (const descriptor of descriptors) {
            const shard = await readJson(resolve(dirname(manifestPath), descriptor.file));
            if (Array.isArray(shard.data)) values.push(...shard.data);
            else if (shard.data && typeof shard.data === 'object') Object.assign(values, shard.data);
        }
        if (category === 'scene' || category === 'continuation') world[category] = values[0] || null;
        else if (category === 'sources') world[category] = { ...values };
        else world[category] = values;
    }
    return world;
}

async function loadChat(chatPath) {
    const rows = (await readFile(chatPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return rows.filter(message => typeof message?.mes === 'string' && !message?.is_system);
}

const manifestPath = argument('manifest');
const chatPath = argument('chat');
const query = argument('query');
const expanded = JSON.parse(argument('expanded', '[]'));
const recentCount = Math.max(2, Number(argument('recent', '6')) || 6);
if (!manifestPath || !chatPath) throw new Error('--manifest and --chat are required.');

const world = await loadWorld(manifestPath);
const chat = await loadChat(chatPath);
const latestUser = query ? { name: 'User', is_user: true, mes: query } : null;
const recent = latestUser ? [...chat.slice(-(recentCount - 1)), latestUser] : chat.slice(-recentCount);
const chatKey = Object.keys(world.sources || {})[0] || '';
const result = buildMemoryPrompt(world, recent, 12800, chatKey, expanded);

console.log(JSON.stringify({
    query: latestUser?.mes || recent.at(-1)?.mes || '',
    expanded,
    estimatedTokens: result.estimatedTokens,
    diagnostics: result.retrievalDiagnostics,
}, null, 2));
