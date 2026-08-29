import assert from 'node:assert/strict';
import test from 'node:test';
import {
    approveExtractionReview,
    cancelExtractionReview,
    getPendingExtractionReview,
    regenerateExtractionReview,
    requestExtractionReview,
    revertExtractionReviewDraft,
    selectExtractionReviewCandidate,
    updateExtractionReviewDraft,
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

test('review identifies editable recursive Chronicle results', async () => {
    const c1Promise = requestExtractionReview({
        result: { summary: 'Arc summary', participants: [], turningPoints: [], openThreads: [] },
        meta: { layer: 'C1', from: 0, to: 191, sourceCount: 24, reason: 'hierarchy' },
    });
    const c1 = getPendingExtractionReview();
    assert.equal(c1.layer, 'C1');
    assert.equal(c1.sourceCount, 24);
    assert.equal(c1.reason, 'hierarchy');
    approveExtractionReview(c1.json, c1.id);
    await c1Promise;

    const c2Promise = requestExtractionReview({
        result: { summary: 'Era summary', participants: [], turningPoints: [], openThreads: [] },
        meta: { layer: 'C2', from: 0, to: 1151, sourceCount: 6 },
    });
    assert.equal(getPendingExtractionReview().layer, 'C2');
    cancelExtractionReview(undefined, getPendingExtractionReview().id);
    await assert.rejects(c2Promise, error => error.code === 'EXTRACTION_REVIEW_CANCELLED');
});

test('discard rejects safely and leaves no active review', async () => {
    const promise = requestExtractionReview({ result: { facts: [] }, meta: {} });
    assert.equal(cancelExtractionReview(), true);
    await assert.rejects(promise, error => error.code === 'EXTRACTION_REVIEW_CANCELLED');
    assert.equal(getPendingExtractionReview(), null);
});

test('regeneration creates temporary swipes and preserves each manual draft', async () => {
    let generations = 1;
    const promise = requestExtractionReview({
        result: { summary: 'candidate one' },
        meta: { layer: 'C1', sourceCount: 24 },
        regenerate: async () => ({ summary: `candidate ${++generations}` }),
    });
    let review = updateExtractionReviewDraft('{"summary":"edited one"}');
    assert.equal(review.dirty, true);

    review = await regenerateExtractionReview(review.json, review.id);
    assert.equal(review.candidateCount, 2);
    assert.equal(review.candidateIndex, 1);
    assert.match(review.json, /candidate 2/);
    assert.equal(review.dirty, false);

    review = updateExtractionReviewDraft('{"summary":"edited two"}', review.id);
    review = selectExtractionReviewCandidate(0, review.json, review.id);
    assert.equal(review.json, '{"summary":"edited one"}');
    assert.equal(review.dirty, true);

    review = revertExtractionReviewDraft(review.id);
    assert.match(review.json, /candidate one/);
    assert.equal(review.dirty, false);
    review = selectExtractionReviewCandidate(1, review.json, review.id);
    assert.equal(review.json, '{"summary":"edited two"}');

    approveExtractionReview(review.json, review.id);
    assert.deepEqual(await promise, { summary: 'edited two' });
    assert.equal(getPendingExtractionReview(), null);
});

test('failed regeneration keeps the current draft awaiting review', async () => {
    const promise = requestExtractionReview({
        result: { summary: 'safe candidate' },
        regenerate: async () => { throw new Error('provider unavailable'); },
    });
    const review = updateExtractionReviewDraft('{"summary":"safe edit"}');
    await assert.rejects(regenerateExtractionReview(review.json, review.id), /provider unavailable/);
    const pending = getPendingExtractionReview();
    assert.equal(pending.phase, 'review');
    assert.equal(pending.candidateCount, 1);
    assert.equal(pending.json, '{"summary":"safe edit"}');
    cancelExtractionReview(undefined, pending.id);
    await assert.rejects(promise, error => error.code === 'EXTRACTION_REVIEW_CANCELLED');
});
