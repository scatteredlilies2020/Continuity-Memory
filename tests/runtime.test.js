import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidateRuntimeWork, invalidateStoryWork, isRuntimeCancellation, pauseRuntime, RUNTIME_CANCELLED_CODE, runtime, STORY_RUNTIME_STATUSES, stopRuntime, stopRuntimeTask, updateRuntime } from '../extension/runtime.js';

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
    const resolved = [];
    const original = { ...runtime, queue: runtime.queue };
    runtime.generation = 10;
    runtime.stopSequence = 2;
    runtime.paused = false;
    runtime.lastError = 'Old failure';
    runtime.queue = [{ resolve: result => resolved.push(result) }];
    try {
        stopRuntime('Reviewed L2 candidate was discarded.');
        assert.equal(runtime.generation, 11);
        assert.equal(runtime.stopSequence, 3);
        assert.equal(runtime.paused, true);
        assert.equal(runtime.status, 'paused');
        assert.deepEqual(runtime.queue, []);
        assert.equal(runtime.lastValidation, 'Reviewed L2 candidate was discarded.');
        assert.equal(runtime.retryStatus, 'Reviewed L2 candidate was discarded.');
        assert.equal(runtime.lastError, '');
        assert.deepEqual(resolved, [{ cancelled: true, messages: 0, chunks: 0 }]);
    } finally {
        Object.assign(runtime, original);
    }
});

test('a scoped task stop cancels only the matching active task without clearing the queue', () => {
    const before = { ...runtime, queue: runtime.queue };
    const queued = [{ id: 'pending-extraction' }];
    Object.assign(runtime, { processing: true, status: 'processing', generation: 20, storyProcessing: true, storyStatus: 'rebuilding-story', storyGeneration: 40, queue: queued });
    try {
        assert.equal(stopRuntimeTask('idle', 'wrong task'), false);
        assert.equal(runtime.generation, 20);
        assert.equal(stopRuntimeTask('rebuilding-story', 'Story stopped.'), true);
        assert.equal(runtime.generation, 20);
        assert.equal(runtime.storyGeneration, 41);
        assert.equal(runtime.status, 'processing');
        assert.equal(runtime.storyStatus, 'stopping');
        assert.equal(runtime.storyRetryStatus, 'Story stopped.');
        assert.equal(runtime.queue, queued);
        assert.equal(runtime.queue.length, 1);
    } finally {
        Object.assign(runtime, before);
    }
});

test('Story stop covers pending preparation as well as active model requests', () => {
    const before = { ...runtime, queue: runtime.queue };
    Object.assign(runtime, { processing: true, status: 'processing', generation: 30, storyProcessing: true, storyStatus: 'pending-story-build', storyGeneration: 50, queue: [] });
    try {
        assert.equal(STORY_RUNTIME_STATUSES.includes('pending-story-build'), true);
        assert.equal(STORY_RUNTIME_STATUSES.includes('pending-story-rebuild'), true);
        assert.equal(stopRuntimeTask(STORY_RUNTIME_STATUSES, 'Pending Story stopped.'), true);
        assert.equal(runtime.generation, 30);
        assert.equal(runtime.storyGeneration, 51);
        assert.equal(runtime.status, 'processing');
        assert.equal(runtime.storyStatus, 'stopping');
    } finally {
        Object.assign(runtime, before);
    }
});

test('source invalidation can cancel Story without disturbing extraction', () => {
    const before = { ...runtime, queue: runtime.queue };
    const queue = [{ id: 'extraction' }];
    Object.assign(runtime, {
        processing: true,
        status: 'processing',
        generation: 60,
        queue,
        storyProcessing: true,
        storyStatus: 'updating-story',
        storyGeneration: 70,
        storyProgress: { current: 1, total: 2 },
    });
    try {
        assert.deepEqual(invalidateStoryWork('Story source changed.'), { invalidated: true });
        assert.equal(runtime.storyGeneration, 71);
        assert.equal(runtime.storyProgress, null);
        assert.equal(runtime.storyRetryStatus, 'Story source changed.');
        assert.equal(runtime.generation, 60);
        assert.equal(runtime.processing, true);
        assert.equal(runtime.queue, queue);
    } finally {
        Object.assign(runtime, before);
    }
});

test('stopping memory processing leaves the independent Story lane running', () => {
    const before = { ...runtime, queue: runtime.queue };
    Object.assign(runtime, {
        processing: true,
        status: 'processing',
        generation: 80,
        stopSequence: 4,
        paused: false,
        queue: [],
        storyProcessing: true,
        storyStatus: 'updating-story',
        storyGeneration: 90,
    });
    try {
        stopRuntime('Memory stopped.');
        assert.equal(runtime.generation, 81);
        assert.equal(runtime.status, 'paused');
        assert.equal(runtime.storyProcessing, true);
        assert.equal(runtime.storyStatus, 'updating-story');
        assert.equal(runtime.storyGeneration, 90);
    } finally {
        Object.assign(runtime, before);
    }
});

test('parallel saves cannot regress the visible world revision', () => {
    const before = { ...runtime };
    runtime.world = { id: 'world-1', revision: 12, marker: 'newer' };
    try {
        updateRuntime({ world: { id: 'world-1', revision: 11, marker: 'stale' }, storyStatus: 'idle' });
        assert.equal(runtime.world.revision, 12);
        assert.equal(runtime.world.marker, 'newer');
        updateRuntime({ world: { id: 'world-1', revision: 13, marker: 'latest' } });
        assert.equal(runtime.world.revision, 13);
        assert.equal(runtime.world.marker, 'latest');
    } finally {
        Object.assign(runtime, before);
    }
});

test('pause is a clean state and intentional cancellation is distinguishable from failure', () => {
    const original = { ...runtime, queue: runtime.queue };
    runtime.paused = false;
    runtime.lastError = 'Old failure';
    runtime.queue = [];
    try {
        pauseRuntime();
        assert.equal(runtime.paused, true);
        assert.equal(runtime.status, 'paused');
        assert.equal(runtime.lastError, '');
        assert.match(runtime.retryStatus, /paused safely/iu);
        assert.equal(isRuntimeCancellation(Object.assign(new Error('Detached extraction was cancelled.'), { code: RUNTIME_CANCELLED_CODE })), true);
        assert.equal(isRuntimeCancellation(new Error('Authentication failed.')), false);
    } finally {
        Object.assign(runtime, original);
    }
});
