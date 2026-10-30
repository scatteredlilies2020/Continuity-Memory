import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicExtractionChunk, planExtractionOutput, resolveExtractionChunk } from '../extension/extraction-budget.js';

test('dynamic extraction chunks use twenty percent of context up to eight thousand tokens', () => {
    assert.equal(dynamicExtractionChunk(8000), 1600);
    assert.equal(dynamicExtractionChunk(16000), 3200);
    assert.equal(dynamicExtractionChunk(32000), 6400);
    assert.equal(dynamicExtractionChunk(40000), 8000);
    assert.equal(dynamicExtractionChunk(200000), 8000);
});

test('explicit extraction chunk targets are adjustable without a fixed ceiling', () => {
    assert.equal(resolveExtractionChunk(12000, 32000), 12000);
    assert.equal(resolveExtractionChunk(0, 32000), 6400);
    assert.equal(resolveExtractionChunk(999999, 32000), 999999);
});

test('automatic output planning gives long excerpts compact summaries with independent completion headroom', () => {
    const messages = [{ index: 144, text: 'x'.repeat(17800) }];
    const before = structuredClone(messages);
    const plan = planExtractionOutput(messages);
    assert.ok(plan.targetTokens < 4450, 'The summary target must be smaller than the estimated source.');
    assert.ok(plan.responseTokens > 16384, 'Do not repeat the failing single-message recovery allowance as the initial capacity.');
    assert.match(plan.guidance, /entire JSON response/);
    assert.match(plan.guidance, /omit unchanged records/);
    assert.match(plan.guidance, /knowledge boundaries, and foundational canon/);
    assert.match(plan.guidance, /never truncate or pad/);
    assert.deepEqual(messages, before);
    assert.ok(planExtractionOutput([{ text: 'A short exchange.' }]).targetTokens < plan.targetTokens);
});

test('automatic targets stay compact across large excerpts and custom targets stay soft', () => {
    const large = [{ text: 'x'.repeat(200000) }];
    assert.equal(planExtractionOutput(large).targetTokens, 4096);
    const custom = planExtractionOutput(large, 1200);
    assert.equal(custom.targetTokens, 1200);
    assert.match(custom.guidance, /roughly 1200 output tokens/);
    assert.ok(custom.responseTokens > custom.targetTokens * 2);
    assert.equal(planExtractionOutput(large, Infinity).targetTokens, 4096);
});
