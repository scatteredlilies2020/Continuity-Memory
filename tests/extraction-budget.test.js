import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicExtractionChunk, resolveExtractionChunk } from '../extension/extraction-budget.js';

test('dynamic extraction chunks use twenty percent of context up to eight thousand tokens', () => {
    assert.equal(dynamicExtractionChunk(8000), 1600);
    assert.equal(dynamicExtractionChunk(16000), 3200);
    assert.equal(dynamicExtractionChunk(32000), 6400);
    assert.equal(dynamicExtractionChunk(40000), 8000);
    assert.equal(dynamicExtractionChunk(200000), 8000);
});

test('explicit extraction chunks remain fixed and bounded', () => {
    assert.equal(resolveExtractionChunk(12000, 32000), 12000);
    assert.equal(resolveExtractionChunk(0, 32000), 6400);
    assert.equal(resolveExtractionChunk(999999, 32000), 50000);
});
