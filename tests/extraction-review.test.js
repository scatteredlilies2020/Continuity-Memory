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
    assert.match(review.json, /old/);
    assert.throws(() => approveExtractionReview('{'), /not valid JSON/);
    approveExtractionReview('{"facts":[{"value":"edited"}]}');
    assert.deepEqual(await promise, { facts: [{ value: 'edited' }] });
    assert.equal(states.at(-1).approved, true);
    assert.equal(getPendingExtractionReview(), null);
});

test('discard rejects safely and leaves no active review', async () => {
    const promise = requestExtractionReview({ result: { facts: [] }, meta: {} });
    assert.equal(cancelExtractionReview(), true);
    await assert.rejects(promise, error => error.code === 'EXTRACTION_REVIEW_CANCELLED');
    assert.equal(getPendingExtractionReview(), null);
});
