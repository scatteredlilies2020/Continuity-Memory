import assert from 'node:assert/strict';
import test from 'node:test';

import {
    embeddingCoverage,
    embeddingCoverageReady,
    MINIMUM_EMBEDDING_COVERAGE,
} from '../extension/embedding-policy.js';

test('embedding retrieval stays closed below 90% coverage', () => {
    assert.equal(MINIMUM_EMBEDDING_COVERAGE, 0.9);
    assert.equal(embeddingCoverageReady(375, 417), false);
    assert.equal(embeddingCoverageReady(376, 417), true);
    assert.equal(embeddingCoverageReady(416, 417), true);
    assert.equal(embeddingCoverageReady(417, 417), true);
    assert.equal(embeddingCoverageReady(0, 0), false);
    assert.equal(embeddingCoverage(417, 417), 1);
    assert.equal(embeddingCoverageReady(89, 100), false);
    assert.equal(embeddingCoverageReady(90, 100), true);
});

test('coverage is clamped to a valid ratio', () => {
    assert.equal(embeddingCoverage(12, 10), 1);
});
