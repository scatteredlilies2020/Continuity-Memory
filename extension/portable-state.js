export const PORTABLE_SCHEMA_VERSION = 1;

export function portableSnapshotMatches(snapshot, world) {
    return snapshot?.schemaVersion === PORTABLE_SCHEMA_VERSION
        && snapshot.world?.id === world?.id
        && Number(snapshot.world?.revision) === Number(world?.revision);
}

export function clonePortableWorld(world, clone = globalThis.structuredClone) {
    if (typeof clone === 'function') return clone(world);
    return JSON.parse(JSON.stringify(world));
}

export function createPortableSnapshot(world, embeddedAt = new Date().toISOString()) {
    return {
        schemaVersion: PORTABLE_SCHEMA_VERSION,
        embeddedAt,
        world: clonePortableWorld(world),
    };
}
