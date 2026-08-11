import assert from 'node:assert/strict';
import test from 'node:test';
import {
    approveExtractionReview,
    cancelExtractionReview,
    getPendingExtractionReview,
    requestExtractionReview,
} from '../extension/extraction-review.js';

test('review exposes editable JSON and resolves only after validation', async () => {
    const states = [];
    const promise = requestExtractionReview({
        result: { facts: [{ value: 'old' }] },
        meta: { from: 4, to: 7 },
        validate: value => {
            if (!Array.isArray(value.facts)) throw new Error('facts required');
            return value;
        },
        onPending: review => states.push(review),
        onSettled: result => states.push(result),
    });
    const review = getPendingExtractionReview();
    assert.equal(review.from, 4);
    assert.equal(review.layer, 'L1');
    assert.match(review.json, /old/);
    assert.throws(() => approveExtractionReview('{'), /not valid JSON/);
    approveExtractionReview('{"facts":[{"value":"edited"}]}');
    assert.deepEqual(await promise, { facts: [{ value: 'edited' }] });
    assert.equal(states.at(-1).approved, true);
    assert.equal(getPendingExtractionReview(), null);
});

test('review identifies editable L2 and L3 hierarchy results', async () => {
    const l2Promise = requestExtractionReview({
        result: { summary: 'Arc summary', participants: [], turningPoints: [], openThreads: [] },
        meta: { layer: 'l2', from: 0, to: 191, sourceCount: 24, reason: 'hierarchy' },
    });
    const l2 = getPendingExtractionReview();
    assert.equal(l2.layer, 'L2');
    assert.equal(l2.sourceCount, 24);
    assert.equal(l2.reason, 'hierarchy');
    approveExtractionReview(l2.json, l2.id);
    await l2Promise;

    const l3Promise = requestExtractionReview({
        result: { summary: 'Era summary', participants: [], turningPoints: [], openThreads: [] },
        meta: { layer: 'L3', from: 0, to: 1151, sourceCount: 6 },
    });
    assert.equal(getPendingExtractionReview().layer, 'L3');
    cancelExtractionReview(undefined, getPendingExtractionReview().id);
    await assert.rejects(l3Promise, error => error.code === 'EXTRACTION_REVIEW_CANCELLED');
});

test('discard rejects safely and leaves no active review', async () => {
    const promise = requestExtractionReview({ result: { facts: [] }, meta: {} });
    assert.equal(cancelExtractionReview(), true);
    await assert.rejects(promise, error => error.code === 'EXTRACTION_REVIEW_CANCELLED');
    assert.equal(getPendingExtractionReview(), null);
});
