import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidateRuntimeWork, runtime } from '../extension/runtime.js';

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
