import test from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimitError, isTransientApiError } from '../extension/errors.js';

test('detects nested endpoint rate limits without confusing other API failures', () => {
    const limited = new Error('API request failed', { cause: new Error('429 Too Many Requests: another request in the queue') });
    assert.equal(isRateLimitError(limited), true);
    assert.equal(isRateLimitError(new Error('401 Unauthorized')), false);
    assert.equal(isRateLimitError(new Error('Extractor returned invalid JSON')), false);
});

test('retries transient transport and server failures but not configuration errors', () => {
    assert.equal(isTransientApiError(new Error('503 Service Unavailable')), true);
    assert.equal(isTransientApiError(new Error('TypeError: fetch failed because ECONNRESET')), true);
    assert.equal(isTransientApiError(new Error('408 request timeout')), true);
    assert.equal(isTransientApiError(new Error('401 Unauthorized')), false);
    assert.equal(isTransientApiError(new Error('400 invalid model')), false);
});
