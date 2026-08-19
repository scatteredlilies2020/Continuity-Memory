import assert from 'node:assert/strict';
import test from 'node:test';
import { completedDetachedWorldIsNewer, detachedProgressNeedsRefresh, latestCompletedDetachedJob } from '../extension/detached-reconnect-policy.js';

test('a detached job that completed during world loading refreshes the stale browser world', () => {
    const jobs = [
        { id: 'new', worldId: 'world', status: 'complete', completedAt: '2026-08-19T16:24:30.000Z' },
        { id: 'old', worldId: 'world', status: 'complete', completedAt: '2026-08-19T16:00:00.000Z' },
    ];
    const completed = latestCompletedDetachedJob(jobs);
    assert.equal(completed.id, 'new');
    assert.equal(completedDetachedWorldIsNewer(
        { id: 'world', revision: 45 },
        { id: 'world', revision: 47 },
        completed,
    ), true);
});

test('completed detached reconciliation ignores an already current or unrelated world', () => {
    const completed = { id: 'done', worldId: 'world', status: 'complete' };
    assert.equal(completedDetachedWorldIsNewer(
        { id: 'world', revision: 47 },
        { id: 'world', revision: 47 },
        completed,
    ), false);
    assert.equal(completedDetachedWorldIsNewer(
        { id: 'other', revision: 1 },
        { id: 'world', revision: 47 },
        completed,
    ), false);
});

test('detached polling refreshes whenever another L1 chunk has been saved', () => {
    assert.equal(detachedProgressNeedsRefresh(0, { status: 'processing', chunks: 0 }), false);
    assert.equal(detachedProgressNeedsRefresh(0, { status: 'processing', chunks: 1 }), true);
    assert.equal(detachedProgressNeedsRefresh(1, { status: 'processing', chunks: 1 }), false);
    assert.equal(detachedProgressNeedsRefresh(1, { status: 'processing', chunks: 2 }), true);
});
