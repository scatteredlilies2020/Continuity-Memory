import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_CORRECTION_RESPONSE_TOKENS,
    resolveCorrectionResponseTokens,
} from '../extension/correction-policy.js';

test('correction responses default to eight thousand output tokens', () => {
    assert.equal(DEFAULT_CORRECTION_RESPONSE_TOKENS, 8000);
    assert.equal(resolveCorrectionResponseTokens(undefined), 8000);
    assert.equal(resolveCorrectionResponseTokens(''), 8000);
});

test('correction response tokens are adjustable within safe bounds', () => {
    assert.equal(resolveCorrectionResponseTokens(12000), 12000);
    assert.equal(resolveCorrectionResponseTokens(12500.6), 12501);
    assert.equal(resolveCorrectionResponseTokens(100), 1000);
    assert.equal(resolveCorrectionResponseTokens(64000), 32000);
});
