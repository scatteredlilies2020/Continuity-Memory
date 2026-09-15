import test from 'node:test';
import assert from 'node:assert/strict';
import { compactWorldStorage, restoreWorldStorage } from '../extension/storage-compaction.js';
import { summarizedWorld } from './helpers/compaction-world.js';

test('summary parents replace covered history in active shards with exact ordered archive recovery', () => {
    const original = summarizedWorld();
    const { world, compaction } = compactWorldStorage(original);
    assert.equal(world.chronicle.length, 1);
    assert.equal(world.capsules.length, 0);
    assert.equal(world.extractions.length, 0);
    assert.equal(world.facts, original.facts);
    assert.equal(world.threads, original.threads);
    assert.equal(compaction.categories.chronicle.archived, 10);
    assert.deepEqual(restoreWorldStorage(world, compaction), original);
});

test('uncovered, cross-chat and unsummarized history stays active', () => {
    for (const mutate of [w => { w.chronicle.at(-1).text = ''; w.chronicle.at(-1).summary = ''; },
        w => { w.chronicle.at(-1).chatKey = 'other'; }, w => { w.chronicle.at(-1).childIds.push('missing'); }]) {
        const w = summarizedWorld(); mutate(w);
        assert.equal(compactWorldStorage(w).compaction, null);
    }
});

test('missing archive entries and duplicate positions fail closed', () => {
    for (const mutate of [w => w['archive-chronicle'].pop(), w => { w['archive-capsules'][1].position = 0; }]) {
        const { world, compaction } = compactWorldStorage(summarizedWorld()); mutate(world);
        assert.throws(() => restoreWorldStorage(world, compaction), /archive/);
    }
});
