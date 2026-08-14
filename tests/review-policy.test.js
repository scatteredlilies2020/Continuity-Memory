import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewBeforeCommitDefault, DEFAULT_REVIEW_BEFORE_COMMIT } from '../extension/review-policy.js';

test('generated memory review defaults off for new and existing installations', () => {
    const fresh = {};
    const legacyDefault = { reviewBeforeCommit: true };

    assert.equal(DEFAULT_REVIEW_BEFORE_COMMIT, false);
    assert.equal(applyReviewBeforeCommitDefault(fresh), true);
    assert.equal(applyReviewBeforeCommitDefault(legacyDefault), true);
    assert.equal(fresh.reviewBeforeCommit, false);
    assert.equal(legacyDefault.reviewBeforeCommit, false);
});

test('the review default migration does not override a later user choice', () => {
    const settings = { reviewBeforeCommit: true, reviewBeforeCommitDefaultVersion: 1 };

    assert.equal(applyReviewBeforeCommitDefault(settings), false);
    assert.equal(settings.reviewBeforeCommit, true);
});
