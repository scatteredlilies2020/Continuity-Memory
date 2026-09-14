import assert from 'node:assert/strict';
import test from 'node:test';
import { chronicleRetryFeedback, retryChroniclePromotion, waitForChronicleRetry } from '../extension/chronicle-retry.js';

test('promotion survives more than five failures and caps retry delays', async () => {
    let calls = 0;
    const delays = [];
    const result = await retryChroniclePromotion(previous => {
        calls++;
        if (calls > 1) assert.ok(previous);
        if (calls <= 6) throw new Error('Detached API request failed: true');
        if (calls === 7) throw new Error('Extractor returned text without a valid JSON object.');
        assert.match(chronicleRetryFeedback(previous), /corrected, complete JSON parent/);
        return 'saved parent';
    }, { wait: async delay => delays.push(delay) });
    assert.equal(result, 'saved parent');
    assert.equal(calls, 8);
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('Stop aborts retry waits and never starts another request', async () => {
    const controller = new AbortController();
    const stopped = new Error('Stopped by user');
    let calls = 0;
    const pending = retryChroniclePromotion(() => {
        calls++;
        throw new Error('503 Service Unavailable');
    }, { signal: controller.signal, onRetry: () => controller.abort(stopped) });
    await assert.rejects(pending, error => error === stopped);
    assert.equal(calls, 1);
    await assert.rejects(waitForChronicleRetry(60000, controller.signal), error => error === stopped);
});

test('network failures retain the last model correction feedback', async () => {
    let calls = 0;
    await retryChroniclePromotion(previous => {
        calls++;
        if (calls === 1) throw new Error('C1 summarizer returned no summary.');
        if (calls === 2) throw new Error('502 Bad Gateway');
        assert.match(chronicleRetryFeedback(previous), /returned no summary/);
    }, { wait: async () => {} });
    assert.equal(calls, 3);
});

test('late responses after Stop are discarded and configuration failures are not retried', async () => {
    const controller = new AbortController();
    await assert.rejects(retryChroniclePromotion(() => {
        controller.abort(new Error('Stopped'));
        return 'late response';
    }, { signal: controller.signal }), /Stopped/);
    for (const message of ['401 Unauthorized', '400 invalid model', 'Could not find profile.']) {
        let calls = 0;
        await assert.rejects(retryChroniclePromotion(() => { calls++; throw new Error(message); }), error => error.message === message);
        assert.equal(calls, 1);
    }
});
