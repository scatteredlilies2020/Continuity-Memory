import test from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimitError } from '../extension/errors.js';

test('detects nested endpoint rate limits without confusing other API failures', () => {
    const limited = new Error('API request failed', { cause: new Error('429 Too Many Requests: another request in the queue') });
    assert.equal(isRateLimitError(limited), true);
    assert.equal(isRateLimitError(new Error('401 Unauthorized')), false);
    assert.equal(isRateLimitError(new Error('Extractor returned invalid JSON')), false);
});
