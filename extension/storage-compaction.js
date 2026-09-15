// Physical storage compaction. Chronicle parents replace covered detail in the
// active shards; immutable archive shards retain exact originals for replay,
// corrections, branch repair and detailed retrieval. No new facts are inferred.
export const ARCHIVE_CATEGORIES = ['chronicle', 'capsules', 'extractions'];
export const ARCHIVE_SHARDS = ARCHIVE_CATEGORIES.map(key => `archive-${key}`);
export const COMPACT_STORAGE_VERSION = 3;

export function compactWorldStorage(world) {
    const active = { ...world };
    const nodes = world.chronicle || [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const covered = new Set();
    for (const parent of nodes) {
        if (!String(parent.text || parent.summary || '').trim() || !(parent.level > 0) || !Array.isArray(parent.childIds) || !parent.childIds.length
            || !Number.isFinite(parent.from) || !Number.isFinite(parent.to)) continue;
        const children = parent.childIds.map(id => byId.get(id));
        if (children.some(child => !child || child.chatKey !== parent.chatKey || child.level !== parent.level - 1
            || !Number.isFinite(child.from) || !Number.isFinite(child.to) || child.from > child.to
            || child.from < parent.from || child.to > parent.to)) continue;
        for (const child of children) covered.add(child.id);
    }
    // Avoid a new archive for tiny histories; normal promotion uses ten nodes.
    if (covered.size < 8) return { world: active, compaction: null };
    const capsuleIds = new Set(nodes.filter(node => node.level === 0 && covered.has(node.id)).flatMap(node => node.capsuleIds || []));
    const capsuleRanges = new Set((world.capsules || []).filter(item => capsuleIds.has(item.id))
        .map(item => JSON.stringify([item.chatKey, item.from, item.to])));
    const selectors = {
        chronicle: item => covered.has(item.id),
        capsules: item => capsuleIds.has(item.id),
        extractions: item => capsuleRanges.has(JSON.stringify([item.chatKey, item.from, item.to])),
    };
    const categories = {};
    for (const key of ARCHIVE_CATEGORIES) {
        const original = world[key] || [];
        const retained = [], archived = [];
        original.forEach((record, position) => {
            if (selectors[key](record)) archived.push({ position, record });
            else retained.push(record);
        });
        active[key] = retained;
        active[`archive-${key}`] = archived;
        categories[key] = { original: original.length, active: retained.length, archived: archived.length };
    }
    return { world: active, compaction: { version: 1, categories } };
}

export function restoreWorldStorage(world, compaction) {
    if (!compaction || compaction.version !== 1 || !compaction.categories) throw new Error('Invalid storage compaction manifest');
    for (const key of ARCHIVE_CATEGORIES) {
        const counts = compaction.categories[key];
        const active = world[key], archive = world[`archive-${key}`];
        if (!counts || !Array.isArray(active) || !Array.isArray(archive)
            || !Number.isSafeInteger(counts.original) || counts.original < 0
            || active.length !== counts.active || archive.length !== counts.archived
            || counts.original !== active.length + archive.length) throw new Error(`Incomplete storage archive (${key})`);
        const restored = new Array(counts.original);
        const positions = new Set();
        for (const entry of archive) {
            if (!Number.isSafeInteger(entry?.position) || entry.position < 0 || entry.position >= restored.length
                || positions.has(entry.position) || !entry.record || typeof entry.record !== 'object' || Array.isArray(entry.record)) throw new Error(`Invalid storage archive entry (${key})`);
            positions.add(entry.position);
            restored[entry.position] = entry.record;
        }
        let cursor = 0;
        for (let position = 0; position < restored.length; position++) {
            if (!positions.has(position)) restored[position] = active[cursor++];
        }
        world[key] = restored;
        delete world[`archive-${key}`];
    }
    return world;
}
