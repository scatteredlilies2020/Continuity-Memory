import { isFreshActiveState } from './state-lifecycle.js';

const INDEXED_CATEGORIES = Object.freeze([
    ['entity', 'entities', ['name', 'type', 'aliases', 'description']],
    ['fact', 'facts', ['subject', 'predicate', 'value', 'category', 'persistence']],
    ['state', 'states', ['subject', 'attribute', 'value', 'previous', 'scope']],
    ['relationship', 'relationships', ['from', 'to', 'kind', 'status', 'dynamic']],
    ['event', 'events', ['title', 'summary', 'participants', 'location', 'storyTime', 'consequences']],
    ['thread', 'threads', ['title', 'detail', 'status', 'participants']],
    ['background', 'backgrounds', ['topic', 'summary', 'status', 'certainty', 'participants']],
    ['capsule', 'capsules', ['title', 'storyTime', 'location', 'participants', 'opening', 'beats', 'emotionalArc', 'closing']],
    ['arc', 'arcs', ['title', 'storyTime', 'participants', 'summary', 'turningPoints', 'emotionalArc', 'closingState', 'openThreads']],
    ['era', 'eras', ['title', 'storyTime', 'participants', 'summary', 'turningPoints', 'emotionalArc', 'closingState', 'openThreads']],
    ['correction', 'corrections', ['instruction', 'summary']],
]);

function clean(value) {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean).join('; ');
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function label(field) {
    return field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, character => character.toUpperCase());
}

export function embeddingRecordKey(category, id) {
    return `${category}:${String(id || '')}`;
}

export function embeddingRecordText(category, item, fields) {
    const lines = [`Memory type: ${category}`];
    for (const field of fields) {
        const value = clean(item?.[field]);
        if (value) lines.push(`${label(field)}: ${value}`);
    }
    return lines.join('\n');
}

export function stableEmbeddingHash(value) {
    // FNV-1a produces the numeric keys expected by SillyTavern's vector API.
    let hash = 0x811c9dc5;
    for (const character of String(value ?? '')) {
        const code = character.codePointAt(0);
        hash ^= code;
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function buildEmbeddingDocuments(world) {
    const documents = [];
    const usedHashes = new Set();
    for (const [category, collection, fields] of INDEXED_CATEGORIES) {
        for (const item of world?.[collection] || []) {
            if (!item?.id) continue;
            if (category === 'thread' && item.status !== 'open') continue;
            if (category === 'state' && !isFreshActiveState(world, item)) continue;
            const key = embeddingRecordKey(category, item.id);
            const text = embeddingRecordText(category, item, fields);
            if (!text) continue;
            let salt = 0;
            let hash = stableEmbeddingHash(`${key}\n${text}`);
            while (usedHashes.has(hash)) hash = stableEmbeddingHash(`${key}\n${text}\ncollision:${++salt}`);
            usedHashes.add(hash);
            documents.push({ key, hash, text, index: documents.length });
        }
    }
    return documents;
}

export function buildEmbeddingQuery(messages, messageLimit = 4, characterLimit = 6000) {
    const limit = Math.min(12, Math.max(1, Number(messageLimit) || 4));
    const text = (messages || [])
        .filter(message => !message?.is_system)
        .slice(-limit)
        .map(message => `${clean(message.name || (message.is_user ? 'User' : 'Assistant'))}: ${clean(message.mes)}`)
        .filter(line => line.replace(/^[^:]+:\s*/, ''))
        .join('\n');
    return text.slice(-Math.max(1000, Number(characterLimit) || 6000));
}

export function semanticRanksFromResponse(response, documents) {
    const byHash = new Map((documents || []).map(document => [Number(document.hash), document.key]));
    const hasFilteredMetadata = Array.isArray(response?.metadata);
    const metadataHashes = hasFilteredMetadata
        ? response.metadata.map(item => Number(item?.hash)).filter(Number.isFinite)
        : [];
    const hashes = hasFilteredMetadata
        ? metadataHashes
        : (Array.isArray(response?.hashes) ? response.hashes.map(Number).filter(Number.isFinite) : []);
    const ranks = new Map();
    for (const hash of hashes) {
        const key = byHash.get(hash);
        if (key && !ranks.has(key)) ranks.set(key, ranks.size + 1);
    }
    return ranks;
}

export function embeddingAnchorText(world, semanticRanks) {
    if (!(semanticRanks instanceof Map) || !semanticRanks.size) return '';
    const values = [];
    const anchorFields = ['name', 'aliases', 'subject', 'from', 'to', 'participants', 'location', 'title'];
    for (const [category, collection] of INDEXED_CATEGORIES) {
        for (const item of world?.[collection] || []) {
            if (!semanticRanks.has(embeddingRecordKey(category, item?.id))) continue;
            for (const field of anchorFields) {
                const value = clean(item?.[field]);
                if (value) values.push(value);
            }
        }
    }
    return [...new Set(values)].join(' ');
}

export const EMBEDDING_INDEX_CATEGORIES = INDEXED_CATEGORIES.map(([category]) => category);
