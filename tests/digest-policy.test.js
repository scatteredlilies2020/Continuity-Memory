import test from 'node:test';
import assert from 'node:assert/strict';
import { completeDigestMessageCount, completeDigestMessages, isDigestStabilityProtectedMessage, latestCompleteDigestMessageIndex, digestStabilityRepairFrom, DIGEST_STABILITY_BUFFER_MESSAGES, partitionDigestStabilityBuffer, partitionPendingDigestMessages, resolveDigestGroupSize, selectAutomaticDigestMessages, validateDigestGroupSize } from '../extension/digest-policy.js';

test('Digest defaults to complete groups of eight messages', () => {
    assert.equal(resolveDigestGroupSize(), 8);
    assert.equal(completeDigestMessageCount(7), 0);
    assert.equal(completeDigestMessageCount(8), 8);
    assert.equal(completeDigestMessageCount(18), 16);
});

test('Digest leaves an incomplete recent tail unselected', () => {
    const messages = Array.from({ length: 18 }, (_, index) => ({ index }));
    assert.deepEqual(completeDigestMessages(messages).map(item => item.index), Array.from({ length: 16 }, (_, index) => index));
});

test('latest complete Digest boundary ignores an incomplete stable tail', () => {
    const messages = Array.from({ length: 182 }, (_, index) => ({ index }));
    assert.equal(latestCompleteDigestMessageIndex(messages, 8), 175);
    assert.equal(latestCompleteDigestMessageIndex(messages.slice(0, 7), 8), -1);
});

test('Digest stability keeps the latest two eligible messages out of extraction', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ index }));
    const result = partitionDigestStabilityBuffer(messages);
    assert.equal(DIGEST_STABILITY_BUFFER_MESSAGES, 2);
    assert.deepEqual(result.extractable.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(result.buffered.map(item => item.index), [8, 9]);
});

test('Digest stability is based on message order and handles short chats', () => {
    assert.deepEqual(partitionDigestStabilityBuffer([{ index: 4 }]), {
        extractable: [],
        buffered: [{ index: 4 }],
    });
    assert.deepEqual(partitionDigestStabilityBuffer([{ index: 4 }, { index: 9 }, { index: 15 }]).buffered.map(item => item.index), [9, 15]);
});

test('Digest rebuild preserves two messages before forming complete extraction groups', () => {
    const messages = Array.from({ length: 128 }, (_, index) => ({ index }));
    const stability = partitionDigestStabilityBuffer(messages);
    const selected = completeDigestMessages(stability.extractable, 8);
    assert.equal(selected.length, 120);
    assert.equal(messages.length - selected.length, 8);
    assert.deepEqual(stability.buffered.map(item => item.index), [126, 127]);
});

test('Digest buffer protects only pending records at the actual chat tail', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ index }));
    const pending = [messages[2], messages[8], messages[9]];
    const result = partitionPendingDigestMessages(messages, pending);
    assert.deepEqual(result.extractable.map(item => item.index), [2]);
    assert.deepEqual(result.buffered.map(item => item.index), [8, 9]);
    assert.deepEqual(partitionPendingDigestMessages(messages, [messages[2]]).buffered, []);
});

test('Digest mutation protection includes the buffer and a separately provisional reply', () => {
    const allMessages = Array.from({ length: 5 }, (_, index) => ({ index }));
    const eligibleMessages = allMessages.slice(0, -1);
    assert.equal(isDigestStabilityProtectedMessage(allMessages, eligibleMessages, 1), false);
    assert.equal(isDigestStabilityProtectedMessage(allMessages, eligibleMessages, 2), true);
    assert.equal(isDigestStabilityProtectedMessage(allMessages, eligibleMessages, 3), true);
    assert.equal(isDigestStabilityProtectedMessage(allMessages, eligibleMessages, 4), true);
    assert.equal(isDigestStabilityProtectedMessage(allMessages, eligibleMessages, undefined), false);
});

test('tail deletion rewinds the processed Digest range that enters the stability buffer', () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({ index }));
    const extractions = [
        { chatKey: 'chat', from: 0, to: 7, messageFingerprints: [] },
        { chatKey: 'chat', from: 8, to: 15, messageFingerprints: [] },
    ];
    assert.equal(digestStabilityRepairFrom(messages, extractions, 'chat'), 8);
    assert.equal(digestStabilityRepairFrom(messages.slice(0, 8), extractions, 'chat'), 0);
    assert.equal(digestStabilityRepairFrom(messages, extractions, 'other-chat'), null);
});

test('unprocessed stability messages require no stored Digest rewind', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ index }));
    const extractions = [{ chatKey: 'chat', from: 0, to: 7, messageFingerprints: [] }];
    assert.equal(digestStabilityRepairFrom(messages, extractions, 'chat'), null);
});

test('automatic Digest selection consumes complete eligible groups', () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({ index }));
    assert.deepEqual(selectAutomaticDigestMessages(messages).map(item => item.index), Array.from({ length: 8 }, (_, index) => index));
    assert.deepEqual(selectAutomaticDigestMessages(messages.slice(0, 8)).map(item => item.index), Array.from({ length: 8 }, (_, index) => index));
});

test('automatic Digest bootstrap keeps only the newest complete eligible group', () => {
    const messages = Array.from({ length: 17 }, (_, index) => ({ index }));
    assert.deepEqual(selectAutomaticDigestMessages(messages, 8, true).map(item => item.index), [9, 10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual(selectAutomaticDigestMessages(messages.slice(0, 7), 8, true), []);
});

test('automatic selection scales across every allowed Digest group size', () => {
    for (const size of [2, 3, 8, 12, 50]) {
        const messages = Array.from({ length: size * 2 }, (_, index) => ({ index }));
        const selected = selectAutomaticDigestMessages(messages, size);
        assert.equal(selected.length, size * 2);
        assert.equal(selected.at(-1).index, size * 2 - 1);
        assert.deepEqual(selectAutomaticDigestMessages(messages.slice(0, size), size), messages.slice(0, size));

        const bootstrap = selectAutomaticDigestMessages(messages, size, true);
        assert.equal(bootstrap.length, size);
        assert.equal(bootstrap.at(-1).index, size * 2 - 1);
    }
});

test('lowering the Digest group size reshapes only complete eligible groups', () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({ index }));
    assert.deepEqual(selectAutomaticDigestMessages(messages, 8).map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(selectAutomaticDigestMessages(messages, 2).map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('custom Digest group sizes remain bounded', () => {
    assert.equal(resolveDigestGroupSize(1), 2);
    assert.equal(resolveDigestGroupSize(12), 12);
    assert.equal(resolveDigestGroupSize(100), 50);
});

test('Digest group validation distinguishes valid settings from corrected values', () => {
    assert.deepEqual(validateDigestGroupSize(2), { value: 2, valid: true });
    assert.deepEqual(validateDigestGroupSize('50'), { value: 50, valid: true });
    assert.deepEqual(validateDigestGroupSize(1), { value: 2, valid: false });
    assert.deepEqual(validateDigestGroupSize(51), { value: 50, valid: false });
    assert.deepEqual(validateDigestGroupSize(2.4), { value: 2, valid: false });
    assert.deepEqual(validateDigestGroupSize(''), { value: 8, valid: false });
});
