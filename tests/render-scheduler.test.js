import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderScheduler } from '../extension/render-scheduler.js';

test('runtime render bursts are coalesced into one frame using the latest state', () => {
    const frames = [];
    const rendered = [];
    const schedule = createRenderScheduler(value => rendered.push(value), callback => frames.push(callback));

    schedule('first');
    schedule('second');
    schedule('latest');

    assert.equal(frames.length, 1);
    assert.deepEqual(rendered, []);
    frames.shift()();
    assert.deepEqual(rendered, ['latest']);
});

test('a completed render allows the next runtime frame to be scheduled', () => {
    const frames = [];
    let renders = 0;
    const schedule = createRenderScheduler(() => renders++, callback => frames.push(callback));

    schedule();
    frames.shift()();
    schedule();

    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(renders, 2);
});

test('render throttling keeps bursts bounded while retaining the latest state', () => {
    const frames = [];
    const delays = [];
    const rendered = [];
    let clock = 0;
    const schedule = createRenderScheduler(value => rendered.push(value), callback => frames.push(callback), {
        minInterval: 100,
        now: () => clock,
        scheduleDelay: (callback, delay) => delays.push({ callback, delay }),
    });
    schedule('first');
    frames.shift()();
    schedule('latest');
    assert.equal(frames.length, 0);
    assert.deepEqual(delays.map(item => item.delay), [100]);
    clock = 100;
    delays.shift().callback();
    assert.deepEqual(rendered, ['first', 'latest']);
});
