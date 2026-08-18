import test from 'node:test';
import assert from 'node:assert/strict';
import { completeL1MessageCount, completeL1Messages, isL1StabilityProtectedMessage, latestCompleteL1MessageIndex, l1StabilityRepairFrom, L1_STABILITY_BUFFER_MESSAGES, partitionL1StabilityBuffer, partitionPendingL1Messages, resolveL1GroupSize, selectAutomaticL1Messages, validateL1GroupSize } from '../extension/l1-policy.js';

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

test('latest complete L1 boundary ignores an incomplete stable tail', () => {
    const messages = Array.from({ length: 182 }, (_, index) => ({ index }));
    assert.equal(latestCompleteL1MessageIndex(messages, 8), 175);
    assert.equal(latestCompleteL1MessageIndex(messages.slice(0, 7), 8), -1);
});

test('L1 stability keeps the latest two eligible messages out of extraction', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ index }));
    const result = partitionL1StabilityBuffer(messages);
    assert.equal(L1_STABILITY_BUFFER_MESSAGES, 2);
    assert.deepEqual(result.extractable.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(result.buffered.map(item => item.index), [8, 9]);
});

test('L1 stability is based on message order and handles short chats', () => {
    assert.deepEqual(partitionL1StabilityBuffer([{ index: 4 }]), {
        extractable: [],
        buffered: [{ index: 4 }],
    });
    assert.deepEqual(partitionL1StabilityBuffer([{ index: 4 }, { index: 9 }, { index: 15 }]).buffered.map(item => item.index), [9, 15]);
});

test('L1 rebuild preserves two messages before forming complete extraction groups', () => {
    const messages = Array.from({ length: 128 }, (_, index) => ({ index }));
    const stability = partitionL1StabilityBuffer(messages);
    const selected = completeL1Messages(stability.extractable, 8);
    assert.equal(selected.length, 120);
    assert.equal(messages.length - selected.length, 8);
    assert.deepEqual(stability.buffered.map(item => item.index), [126, 127]);
});

test('L1 buffer protects only pending records at the actual chat tail', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ index }));
    const pending = [messages[2], messages[8], messages[9]];
    const result = partitionPendingL1Messages(messages, pending);
    assert.deepEqual(result.extractable.map(item => item.index), [2]);
    assert.deepEqual(result.buffered.map(item => item.index), [8, 9]);
    assert.deepEqual(partitionPendingL1Messages(messages, [messages[2]]).buffered, []);
});

test('L1 mutation protection includes the buffer and a separately provisional reply', () => {
    const allMessages = Array.from({ length: 5 }, (_, index) => ({ index }));
    const eligibleMessages = allMessages.slice(0, -1);
    assert.equal(isL1StabilityProtectedMessage(allMessages, eligibleMessages, 1), false);
    assert.equal(isL1StabilityProtectedMessage(allMessages, eligibleMessages, 2), true);
    assert.equal(isL1StabilityProtectedMessage(allMessages, eligibleMessages, 3), true);
    assert.equal(isL1StabilityProtectedMessage(allMessages, eligibleMessages, 4), true);
    assert.equal(isL1StabilityProtectedMessage(allMessages, eligibleMessages, undefined), false);
});

test('tail deletion rewinds the processed L1 range that enters the stability buffer', () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({ index }));
    const extractions = [
        { chatKey: 'chat', from: 0, to: 7, messageFingerprints: [] },
        { chatKey: 'chat', from: 8, to: 15, messageFingerprints: [] },
    ];
    assert.equal(l1StabilityRepairFrom(messages, extractions, 'chat'), 8);
    assert.equal(l1StabilityRepairFrom(messages.slice(0, 8), extractions, 'chat'), 0);
    assert.equal(l1StabilityRepairFrom(messages, extractions, 'other-chat'), null);
});

test('unprocessed stability messages require no stored L1 rewind', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ index }));
    const extractions = [{ chatKey: 'chat', from: 0, to: 7, messageFingerprints: [] }];
    assert.equal(l1StabilityRepairFrom(messages, extractions, 'chat'), null);
});

test('automatic L1 selection consumes complete eligible groups', () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({ index }));
    assert.deepEqual(selectAutomaticL1Messages(messages).map(item => item.index), Array.from({ length: 8 }, (_, index) => index));
    assert.deepEqual(selectAutomaticL1Messages(messages.slice(0, 8)).map(item => item.index), Array.from({ length: 8 }, (_, index) => index));
});

test('automatic L1 bootstrap keeps only the newest complete eligible group', () => {
    const messages = Array.from({ length: 17 }, (_, index) => ({ index }));
    assert.deepEqual(selectAutomaticL1Messages(messages, 8, true).map(item => item.index), [9, 10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual(selectAutomaticL1Messages(messages.slice(0, 7), 8, true), []);
});

test('automatic selection scales across every allowed L1 group size', () => {
    for (const size of [2, 3, 8, 12, 50]) {
        const messages = Array.from({ length: size * 2 }, (_, index) => ({ index }));
        const selected = selectAutomaticL1Messages(messages, size);
        assert.equal(selected.length, size * 2);
        assert.equal(selected.at(-1).index, size * 2 - 1);
        assert.deepEqual(selectAutomaticL1Messages(messages.slice(0, size), size), messages.slice(0, size));

        const bootstrap = selectAutomaticL1Messages(messages, size, true);
        assert.equal(bootstrap.length, size);
        assert.equal(bootstrap.at(-1).index, size * 2 - 1);
    }
});

test('lowering the L1 group size reshapes only complete eligible groups', () => {
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
