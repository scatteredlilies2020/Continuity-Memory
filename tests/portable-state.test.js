import assert from 'node:assert/strict';
import test from 'node:test';
import { clonePortableWorld, createPortableSnapshot, portableSnapshotIsNewer, portableSnapshotMatches } from '../extension/portable-state.js';

test('recognizes only the same portable world revision as current', () => {
    const world = { id: 'world-1', revision: 7 };
    const snapshot = createPortableSnapshot(world, '2026-08-05T00:00:00.000Z');
    assert.equal(portableSnapshotMatches(snapshot, world), true);
    assert.equal(portableSnapshotMatches(snapshot, { ...world, revision: 8 }), false);
    assert.equal(portableSnapshotMatches(snapshot, { ...world, id: 'world-2' }), false);
    assert.equal(portableSnapshotIsNewer(snapshot, { ...world, revision: 6 }), true);
    assert.equal(portableSnapshotIsNewer(snapshot, { ...world, revision: 8 }), false);
    assert.equal(portableSnapshotIsNewer(snapshot, { ...world, id: 'world-2', revision: 6 }), false);
});

test('portable snapshots own a detached copy of the world', () => {
    const world = { id: 'world-1', revision: 1, scene: { summary: 'before' } };
    const snapshot = createPortableSnapshot(world, '2026-08-05T00:00:00.000Z');
    world.scene.summary = 'after';
    assert.equal(snapshot.world.scene.summary, 'before');
});

test('portable cloning works on browsers without structuredClone', () => {
    const world = { id: 'world-1', nested: { value: 3 } };
    const cloned = clonePortableWorld(world, null);
    assert.deepEqual(cloned, world);
    assert.notEqual(cloned.nested, world.nested);
});
