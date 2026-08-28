import assert from 'node:assert/strict';
import test from 'node:test';

import {
    embeddingCoverage,
    embeddingCoverageReady,
    MINIMUM_EMBEDDING_COVERAGE,
} from '../extension/embedding-policy.js';

test('embedding retrieval stays closed until 100% coverage', () => {
    assert.equal(MINIMUM_EMBEDDING_COVERAGE, 1);
    assert.equal(embeddingCoverageReady(412, 417), false);
    assert.equal(embeddingCoverageReady(416, 417), false);
    assert.equal(embeddingCoverageReady(417, 417), true);
    assert.equal(embeddingCoverageReady(0, 0), false);
    assert.equal(embeddingCoverage(417, 417), MINIMUM_EMBEDDING_COVERAGE);
});

test('coverage is clamped to a valid ratio', () => {
    assert.equal(embeddingCoverage(12, 10), 1);
});
