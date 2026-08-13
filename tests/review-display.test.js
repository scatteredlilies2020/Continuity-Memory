import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clampReviewFontSize,
    DEFAULT_REVIEW_FONT_SIZE,
    extractionReviewRecoveryAction,
    MAX_REVIEW_FONT_SIZE,
    MIN_REVIEW_FONT_SIZE,
    pinchedReviewFontSize,
    reviewGenerationProgress,
    touchDistance,
} from '../extension/review-display.js';

test('review text size stays within mobile-safe bounds', () => {
    assert.equal(clampReviewFontSize('invalid'), DEFAULT_REVIEW_FONT_SIZE);
    assert.equal(clampReviewFontSize(1), MIN_REVIEW_FONT_SIZE);
    assert.equal(clampReviewFontSize(99), MAX_REVIEW_FONT_SIZE);
    assert.equal(clampReviewFontSize(17.6), 18);
});

test('two-finger pinch scales review text without escaping its bounds', () => {
    const start = [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }];
    const wider = [{ clientX: 0, clientY: 0 }, { clientX: 150, clientY: 0 }];
    assert.equal(touchDistance(start), 100);
    assert.equal(pinchedReviewFontSize(14, touchDistance(start), touchDistance(wider)), 21);
    assert.equal(pinchedReviewFontSize(20, 100, 1000), MAX_REVIEW_FONT_SIZE);
    assert.equal(pinchedReviewFontSize(14, 0, 100), 14);
});

test('priority overlay describes active L1 and hierarchy work', () => {
    assert.deepEqual(reviewGenerationProgress({
        progress: { current: 2, total: 3, from: 10, to: 19 },
        retryStatus: 'Roleplay is waiting.',
    }), {
        title: 'Generating L1 for messages 10–19',
        detail: 'Roleplay is waiting. · chunk 2/3',
    });
    assert.equal(reviewGenerationProgress({ retryStatus: 'Completing eligible L2 records…' }).title, 'Generating L2 memory');
    assert.equal(reviewGenerationProgress({ retryStatus: 'Completing the selected vector index…' }).title, 'Updating memory search index');
    assert.equal(reviewGenerationProgress({ roleplayGate: { stopping: true }, retryStatus: 'Stopping safely…' }).title, 'Stopping Continuity generation…');
});

test('pending review recovery reuses a live dialog and reopens a missing one', () => {
    const review = { id: 'review-1' };
    assert.equal(extractionReviewRecoveryAction(null, null), 'none');
    assert.equal(extractionReviewRecoveryAction(null, { reviewId: 'review-1' }), 'close');
    assert.equal(extractionReviewRecoveryAction(review, null), 'open');
    assert.equal(extractionReviewRecoveryAction(review, { reviewId: 'review-2' }), 'replace');
    assert.equal(extractionReviewRecoveryAction(review, { reviewId: 'review-1', popup: { dlg: { isConnected: false, open: false } } }), 'reopen');
    assert.equal(extractionReviewRecoveryAction(review, { reviewId: 'review-1', popup: { dlg: { isConnected: true, open: true } } }), 'reuse');
});
