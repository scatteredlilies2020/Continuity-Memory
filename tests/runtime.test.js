import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidateRuntimeWork, runtime, stopRuntime } from '../extension/runtime.js';

test('a source mutation invalidates in-flight work and clears queued stale ranges', () => {
    const rejected = [];
    const original = {
        generation: runtime.generation,
        processing: runtime.processing,
        queue: runtime.queue,
        progress: runtime.progress,
        retryStatus: runtime.retryStatus,
    };
    runtime.generation = 7;
    runtime.processing = true;
    runtime.queue = [
        { reject: error => rejected.push(error.message) },
        { reject: error => rejected.push(error.message) },
    ];
    runtime.progress = { current: 1, total: 1 };
    try {
        const result = invalidateRuntimeWork('Source message deleted.');
        assert.equal(runtime.generation, 8);
        assert.deepEqual(runtime.queue, []);
        assert.equal(runtime.progress, null);
        assert.equal(runtime.retryStatus, 'Source message deleted.');
        assert.deepEqual(rejected, ['Source message deleted.', 'Source message deleted.']);
        assert.deepEqual(result, { invalidated: true, queued: 2 });
    } finally {
        Object.assign(runtime, original);
    }
});

test('discarding a review can stop generation with a specific visible reason', () => {
    const rejected = [];
    const original = { ...runtime, queue: runtime.queue };
    runtime.generation = 10;
    runtime.paused = false;
    runtime.queue = [{ reject: error => rejected.push(error.message) }];
    try {
        stopRuntime('Reviewed L2 candidate was discarded.');
        assert.equal(runtime.generation, 11);
        assert.equal(runtime.paused, true);
        assert.equal(runtime.status, 'paused');
        assert.deepEqual(runtime.queue, []);
        assert.equal(runtime.lastValidation, 'Reviewed L2 candidate was discarded.');
        assert.equal(runtime.retryStatus, 'Reviewed L2 candidate was discarded.');
        assert.deepEqual(rejected, ['Processing stopped and the queue was cleared.']);
    } finally {
        Object.assign(runtime, original);
    }
});
