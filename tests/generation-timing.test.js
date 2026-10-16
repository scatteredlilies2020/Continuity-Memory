import assert from 'node:assert/strict';
import test from 'node:test';
import { getGenerationTiming, timeGenerationStep } from '../extension/generation-timing.js';

test('standalone installs run work without host timing assets or hooks', async () => {
    assert.equal(getGenerationTiming(), null);
    assert.equal(await timeGenerationStep('lookup', async () => 42), 42);
    const error = new Error('lookup failed');
    await assert.rejects(timeGenerationStep('lookup', async () => { throw error; }), actual => actual === error);
});

test('the optional host hook receives the same trace and operation', async t => {
    const trace = {}, operation = () => 42, calls = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavernGenerationTiming');
    Object.defineProperty(globalThis, 'SillyTavernGenerationTiming', { configurable: true, value: {
        getGenerationTiming: () => trace,
        timeGenerationStep: (...args) => { calls.push(args); return args[1](); },
    } });
    t.after(() => previous ? Object.defineProperty(globalThis, 'SillyTavernGenerationTiming', previous) : delete globalThis.SillyTavernGenerationTiming);
    assert.equal(getGenerationTiming(), trace);
    assert.equal(await timeGenerationStep('lookup', operation), 42);
    assert.deepEqual(calls, [['lookup', operation, trace]]);
});
