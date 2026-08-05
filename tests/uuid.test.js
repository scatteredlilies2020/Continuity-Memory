import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUuid } from '../extension/uuid.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uses native randomUUID when available', () => {
    const expected = '12345678-1234-4123-8123-123456789abc';
    assert.equal(randomUuid({ randomUUID: () => expected }), expected);
});

test('creates a UUID v4 with getRandomValues on older browsers', () => {
    const value = randomUuid({ getRandomValues: bytes => bytes.fill(0xab) });
    assert.match(value, UUID_V4);
    assert.equal(value, 'abababab-abab-4bab-abab-abababababab');
});

test('retains a unique UUID fallback without Web Crypto', () => {
    const first = randomUuid(null);
    const second = randomUuid(null);
    assert.match(first, UUID_V4);
    assert.match(second, UUID_V4);
    assert.notEqual(first, second);
});
