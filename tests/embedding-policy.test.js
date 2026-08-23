import assert from 'node:assert/strict';
import test from 'node:test';

import {
    embeddingCoverage,
    embeddingCoverageReady,
    MINIMUM_EMBEDDING_COVERAGE,
} from '../extension/embedding-policy.js';

test('embedding generation gate opens at 80% coverage', () => {
    assert.equal(MINIMUM_EMBEDDING_COVERAGE, 0.8);
    assert.equal(embeddingCoverageReady(334, 417), true);
    assert.equal(embeddingCoverageReady(333, 417), false);
    assert.equal(embeddingCoverageReady(0, 0), false);
    assert.ok(embeddingCoverage(334, 417) >= MINIMUM_EMBEDDING_COVERAGE);
});

test('coverage is clamped to a valid ratio', () => {
    assert.equal(embeddingCoverage(12, 10), 1);
});
