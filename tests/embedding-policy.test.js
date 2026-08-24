import assert from 'node:assert/strict';
import test from 'node:test';

import {
    embeddingCoverage,
    embeddingCoverageReady,
    MINIMUM_EMBEDDING_COVERAGE,
} from '../extension/embedding-policy.js';

test('embedding generation gate stays closed until 99% coverage', () => {
    assert.equal(MINIMUM_EMBEDDING_COVERAGE, 0.99);
    assert.equal(embeddingCoverageReady(412, 417), false);
    assert.equal(embeddingCoverageReady(413, 417), true);
    assert.equal(embeddingCoverageReady(0, 0), false);
    assert.ok(embeddingCoverage(413, 417) >= MINIMUM_EMBEDDING_COVERAGE);
});

test('coverage is clamped to a valid ratio', () => {
    assert.equal(embeddingCoverage(12, 10), 1);
});
