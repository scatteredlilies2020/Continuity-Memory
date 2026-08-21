import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundScheduler } from '../extension/background-scheduler.js';

test('background work is serialized and a burst schedules one follow-up run', async () => {
    const timers = [];
    const cancelled = new Set();
    const runs = [];
    let release;
    const scheduler = createBackgroundScheduler(async () => {
        runs.push('start');
        await new Promise(resolve => { release = resolve; });
        runs.push('end');
    }, { delay: 0, schedule: callback => { timers.push(callback); return callback; }, cancel: callback => cancelled.add(callback) });

    scheduler.schedule();
    scheduler.schedule();
    assert.equal(timers.length, 2);
    assert.equal(cancelled.has(timers[0]), true);
    void timers.pop()();
    await Promise.resolve();
    assert.deepEqual(runs, ['start']);

    scheduler.schedule();
    assert.equal(scheduler.pending, true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(runs.at(-1), 'end');
    assert.equal(timers.length, 2);
    void timers.at(-1)();
    await Promise.resolve();
    assert.deepEqual(runs, ['start', 'end', 'start']);
});

test('cancelling a delayed background run prevents it from starting', () => {
    const timers = [];
    let runs = 0;
    const cancelled = new Set();
    const scheduler = createBackgroundScheduler(() => { runs++; }, { schedule: callback => { timers.push(callback); return callback; }, cancel: callback => cancelled.add(callback) });
    scheduler.schedule();
    scheduler.cancel();
    assert.equal(scheduler.pending, false);
    assert.equal(timers.length, 1);
    assert.equal(cancelled.has(timers[0]), true);
    assert.equal(runs, 0);
});
