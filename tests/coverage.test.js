import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBranchDivergence, analyzeCoverage, analyzeTailRollback, EXTRACTION_VERSION } from '../extension/coverage.js';
import { fingerprintMessage } from '../extension/message-digest.js';

const messages = [
    { index: 0, name: 'User', text: 'One' },
    { index: 1, name: 'Character', text: 'Two' },
    { index: 2, name: 'User', text: 'Three' },
];

test('reports unchanged, changed, and never-processed messages exactly', () => {
    const processed = [
        { index: 0, fingerprint: fingerprintMessage(messages[0]), version: EXTRACTION_VERSION },
        { index: 1, fingerprint: fingerprintMessage({ ...messages[1], text: 'Old swipe' }), version: EXTRACTION_VERSION },
    ];
    const coverage = analyzeCoverage(messages, processed);
    assert.equal(coverage.processed, 1);
    assert.equal(coverage.pending, 2);
    assert.equal(coverage.changed, 1);
    assert.equal(coverage.outdated, 0);
    assert.equal(coverage.neverProcessed, 1);
    assert.deepEqual(coverage.pendingRanges, [{ from: 1, to: 2 }]);
});

test('reports legacy successful records as needing a narrative upgrade', () => {
    const coverage = analyzeCoverage(messages, [{ index: 0, fingerprint: fingerprintMessage(messages[0]) }]);
    assert.equal(coverage.outdated, 1);
    assert.equal(coverage.changed, 0);
    assert.equal(coverage.pending, 3);
});

test('detects processed messages removed from the chat tail', () => {
    const current = [0, 1, 2].map(index => ({ index, name: 'A', text: `message ${index}` }));
    const processed = [0, 1, 2, 3, 4].map(index => ({ index, fingerprint: 'stored', version: 2 }));
    const extractions = [
        { chatKey: 'chat', from: 0, to: 2, messageFingerprints: [] },
        { chatKey: 'chat', from: 3, to: 4, messageFingerprints: [{ index: 3 }, { index: 4 }] },
    ];
    const rollback = analyzeTailRollback(current, processed, extractions, 'chat');
    assert.equal(rollback.detected, true);
    assert.equal(rollback.removedMessages, 2);
    assert.deepEqual(rollback.affectedExtractions.map(item => [item.from, item.to]), [[3, 4]]);
});

test('finds the stored Digest boundary for edits, deletions, and hidden messages', () => {
    const current = [0, 1, 2, 3].map(index => ({ index, name: 'A', text: `message ${index}` }));
    const processed = current.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message), version: EXTRACTION_VERSION }));
    const extractions = [
        { chatKey: 'chat', from: 0, to: 1 },
        { chatKey: 'chat', from: 2, to: 3 },
    ];
    const changed = current.map(message => message.index === 2 ? { ...message, text: 'changed' } : message);
    assert.equal(analyzeBranchDivergence(changed, processed, extractions, 'chat').repairFrom, 2);
    const hidden = current.filter(message => message.index !== 1);
    assert.equal(analyzeBranchDivergence(hidden, processed, extractions, 'chat').repairFrom, 0);
    const appended = [...current, { index: 4, name: 'A', text: 'new tail' }];
    assert.equal(analyzeBranchDivergence(appended, processed, extractions, 'chat').detected, false);
});
