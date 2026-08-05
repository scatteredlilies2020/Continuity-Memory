import test from 'node:test';
import assert from 'node:assert/strict';
import { completeL1MessageCount, completeL1Messages, resolveL1GroupSize } from '../extension/l1-policy.js';

test('L1 defaults to complete groups of eight messages', () => {
    assert.equal(resolveL1GroupSize(), 8);
    assert.equal(completeL1MessageCount(7), 0);
    assert.equal(completeL1MessageCount(8), 8);
    assert.equal(completeL1MessageCount(18), 16);
});

test('L1 leaves an incomplete recent tail unselected', () => {
    const messages = Array.from({ length: 18 }, (_, index) => ({ index }));
    assert.deepEqual(completeL1Messages(messages).map(item => item.index), Array.from({ length: 16 }, (_, index) => index));
});

test('custom L1 group sizes remain bounded', () => {
    assert.equal(resolveL1GroupSize(1), 2);
    assert.equal(resolveL1GroupSize(12), 12);
    assert.equal(resolveL1GroupSize(100), 50);
});
