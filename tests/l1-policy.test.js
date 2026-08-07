import test from 'node:test';
import assert from 'node:assert/strict';
import { completeL1MessageCount, completeL1Messages, holdBackLatestMessage, resolveL1GroupSize, selectAutomaticL1Messages, validateL1GroupSize } from '../extension/l1-policy.js';

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

test('automatic L1 selection holds back the newest reply', () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({ index }));
    const stable = holdBackLatestMessage(messages);
    assert.deepEqual(stable.map(item => item.index), Array.from({ length: 8 }, (_, index) => index));
    assert.deepEqual(messages.map(item => item.index), Array.from({ length: 9 }, (_, index) => index));
    assert.deepEqual(holdBackLatestMessage([]), []);
    assert.deepEqual(selectAutomaticL1Messages(messages).map(item => item.index), Array.from({ length: 8 }, (_, index) => index));
    assert.deepEqual(selectAutomaticL1Messages(messages.slice(0, 8)), []);
});

test('automatic L1 bootstrap keeps only the newest stable complete group', () => {
    const messages = Array.from({ length: 18 }, (_, index) => ({ index }));
    assert.deepEqual(selectAutomaticL1Messages(messages, 8, true).map(item => item.index), [9, 10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual(selectAutomaticL1Messages(messages.slice(0, 8), 8, true), []);
});

test('automatic holdback scales across every allowed L1 group size', () => {
    for (const size of [2, 3, 8, 12, 50]) {
        const messages = Array.from({ length: size * 2 + 1 }, (_, index) => ({ index }));
        const selected = selectAutomaticL1Messages(messages, size);
        assert.equal(selected.length, size * 2);
        assert.equal(selected.at(-1).index, size * 2 - 1);
        assert.equal(selected.some(message => message.index === size * 2), false);
        assert.deepEqual(selectAutomaticL1Messages(messages.slice(0, size), size), []);

        const bootstrap = selectAutomaticL1Messages(messages, size, true);
        assert.equal(bootstrap.length, size);
        assert.equal(bootstrap.at(-1).index, size * 2 - 1);
    }
});

test('lowering the L1 group size preserves the same held-back newest reply', () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({ index }));
    assert.deepEqual(selectAutomaticL1Messages(messages, 8).map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(selectAutomaticL1Messages(messages, 2).map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('custom L1 group sizes remain bounded', () => {
    assert.equal(resolveL1GroupSize(1), 2);
    assert.equal(resolveL1GroupSize(12), 12);
    assert.equal(resolveL1GroupSize(100), 50);
});

test('L1 group validation distinguishes valid settings from corrected values', () => {
    assert.deepEqual(validateL1GroupSize(2), { value: 2, valid: true });
    assert.deepEqual(validateL1GroupSize('50'), { value: 50, valid: true });
    assert.deepEqual(validateL1GroupSize(1), { value: 2, valid: false });
    assert.deepEqual(validateL1GroupSize(51), { value: 50, valid: false });
    assert.deepEqual(validateL1GroupSize(2.4), { value: 2, valid: false });
    assert.deepEqual(validateL1GroupSize(''), { value: 8, valid: false });
});
