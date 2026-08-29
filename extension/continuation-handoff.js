import { migrateLegacyBeliefs } from './attributed-beliefs.js';

export const CONTINUATION_PACKAGE_KIND = 'continuity-arc-handoff';
export const CONTINUATION_PACKAGE_VERSION = 1;

const INHERITED_COLLECTIONS = Object.freeze([
    'entities', 'facts', 'states', 'relationships', 'events',
    'capsules', 'arcs', 'eras', 'chronicle', 'threads', 'backgrounds', 'corrections',
]);

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function clean(value, fallback = '') {
    return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
}

function inheritedChatKey(worldId) {
    const safe = clean(worldId, 'memory').toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 60);
    return `continuation:${safe || 'memory'}`;
}

function remapSource(source, chatKey) {
    if (!source || typeof source !== 'object') return null;
    if (!Number.isFinite(Number(source.from)) || !Number.isFinite(Number(source.to))) {
        return source.kind === 'correction' ? clone(source) : null;
    }
    return {
        ...clone(source),
        chatKey,
        from: Number(source.from),
        to: Number(source.to),
        inherited: true,
    };
}

function remapRecord(record, chatKey) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
    const next = clone(record);
    if (next.chatKey && Number.isFinite(Number(next.from)) && Number.isFinite(Number(next.to))) {
        next.chatKey = chatKey;
        next.inherited = true;
    }
    if (Array.isArray(next.sources)) {
        next.sources = next.sources.map(source => remapSource(source, chatKey)).filter(Boolean);
    }
    return next;
}

export function isContinuationPackage(value) {
    return Boolean(value
        && value.kind === CONTINUATION_PACKAGE_KIND
        && Number(value.version) === CONTINUATION_PACKAGE_VERSION
        && value.world
        && typeof value.world === 'object'
        && !Array.isArray(value.world));
}

export function createContinuationPackage(world, exportedAt = new Date().toISOString()) {
    if (!world || typeof world !== 'object' || Array.isArray(world) || !world.id) {
        throw new Error('Open a valid Continuity memory before creating a continuation arc.');
    }
    return {
        kind: CONTINUATION_PACKAGE_KIND,
        version: CONTINUATION_PACKAGE_VERSION,
        exportedAt,
        source: {
            worldId: clean(world.id),
            name: clean(world.name, 'Continuity Memory'),
            revision: Math.max(0, Number(world.revision) || 0),
        },
        instructions: 'Open the destination chat, then choose Start continuation arc in Continuity Memory and select this file.',
        world: clone(world),
    };
}

export function prepareContinuationWorld(value, { chatKey, attachedAt = new Date().toISOString(), name = '' } = {}) {
    if (!isContinuationPackage(value)) throw new Error('This is not a supported Continuity continuation-arc file.');
    if (!clean(chatKey)) throw new Error('Open the destination chat before starting a continuation arc.');
    const source = clone(value.world);
    migrateLegacyBeliefs(source);
    if (!source.id || !source.name) throw new Error('The continuation file does not contain a valid source memory.');

    const world = clone(source);
    const inheritedKey = inheritedChatKey(source.id);
    for (const collection of INHERITED_COLLECTIONS) {
        world[collection] = (Array.isArray(source[collection]) ? source[collection] : [])
            .map(record => remapRecord(record, inheritedKey));
    }
    world.scene = source.scene ? remapRecord(source.scene, inheritedKey) : null;
    world.extractions = [];
    world.sources = {};
    const inheritedStory = Object.values(source.storySoFar || {})
        .filter(item => item && typeof item === 'object' && clean(item.text))
        .sort((left, right) => Number(left.to ?? -1) - Number(right.to ?? -1)
            || String(left.updatedAt || '').localeCompare(String(right.updatedAt || '')))
        .at(-1);
    world.storySoFar = inheritedStory ? { [clean(chatKey)]: clone(inheritedStory) } : {};
    world.name = clean(name, `${clean(source.name, 'Continuity Memory')} · Continuation`).slice(0, 120);
    world.revision = -1;
    world.continuation = {
        version: CONTINUATION_PACKAGE_VERSION,
        originWorldId: clean(source.id),
        originName: clean(source.name, 'Continuity Memory'),
        exportedAt: clean(value.exportedAt),
        attachedAt,
        attachedChatKey: clean(chatKey),
        inheritedChatKey: inheritedKey,
    };
    return world;
}
