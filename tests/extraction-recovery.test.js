import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isExplicitExtractionOutputLimitError,
    isAdaptiveExtractionSplitError,
    isRecoverableExtractionOutputError,
    processAdaptiveExtractionChunks,
    splitMessagesByTokenBalance,
} from '../extension/extraction-recovery.js';

function messages(weights) {
    return weights.map((weight, index) => ({ index, text: 'x'.repeat(weight), weight }));
}

async function measure(items) {
    return items.reduce((sum, item) => sum + item.weight, 0);
}

test('recognizes incomplete structured output without treating ordinary API failures as splittable', () => {
    assert.equal(isRecoverableExtractionOutputError(new Error('Extractor returned text without a valid JSON object.')), true);
    assert.equal(isRecoverableExtractionOutputError(new Error('finish_reason: length')), true);
    assert.equal(isExplicitExtractionOutputLimitError(new Error('finish_reason: length')), true);
    assert.equal(isExplicitExtractionOutputLimitError(new Error('Extractor returned text without a valid JSON object.')), false);
    assert.equal(isRecoverableExtractionOutputError(new Error('401 Unauthorized')), false);
    assert.equal(isRecoverableExtractionOutputError(new Error('Rate limited')), false);
    assert.equal(isAdaptiveExtractionSplitError(new Error('Extractor returned text without a valid JSON object.')), true);
    assert.equal(isAdaptiveExtractionSplitError(new Error('Extractor field "facts" is not an array.')), false);
    assert.equal(isAdaptiveExtractionSplitError(new Error('Extractor returned no valid chronological scene capsule.')), false);
});

test('splits messages near half of their token weight while preserving order', async () => {
    const source = messages([8, 7, 2, 1]);
    const parts = await splitMessagesByTokenBalance(source, measure);
    assert.deepEqual(parts.map(part => part.messages.map(item => item.index)), [[0], [1, 2, 3]]);
    assert.deepEqual(parts.map(part => part.tokens), [8, 10]);
});

test('retries incomplete extraction as smaller ordered parts and saves only valid results', async () => {
    const source = messages([4, 4, 4, 4]);
    const attempts = [];
    const saved = [];
    const splitNotices = [];
    const result = await processAdaptiveExtractionChunks([{ messages: source, tokens: 16 }], {
        measureMessages: measure,
        extract: async chunk => {
            attempts.push(chunk.map(item => item.index));
            if (chunk.length > 2) throw new Error('Extractor returned text without a valid JSON object.');
            return { indexes: chunk.map(item => item.index) };
        },
        save: async value => saved.push(value.indexes),
        onSplit: async event => splitNotices.push(event.parts.map(part => part.messages.map(item => item.index))),
    });
    assert.deepEqual(attempts, [[0, 1, 2, 3], [0, 1], [2, 3]]);
    assert.deepEqual(saved, [[0, 1], [2, 3]]);
    assert.deepEqual(splitNotices, [[[0, 1], [2, 3]]]);
    assert.deepEqual(result, { completed: 2, total: 2, splits: 1 });
});

test('keeps completed subparts saved when a later single-message part remains invalid', async () => {
    const source = messages([1, 1, 1, 1]);
    const saved = [];
    await assert.rejects(
        processAdaptiveExtractionChunks([{ messages: source, tokens: 4 }], {
            measureMessages: measure,
            extract: async chunk => {
                if (chunk.length > 1 || chunk[0].index === 3) throw new Error('Extractor returned no JSON object.');
                return { index: chunk[0].index };
            },
            save: async value => saved.push(value.index),
        }),
        /message 3.*cannot be split safely/i,
    );
    assert.deepEqual(saved, [0, 1, 2]);
});

test('does not split transport or authentication errors', async () => {
    const source = messages([1, 1]);
    let attempts = 0;
    await assert.rejects(
        processAdaptiveExtractionChunks([{ messages: source, tokens: 2 }], {
            measureMessages: measure,
            extract: async () => { attempts++; throw new Error('401 Unauthorized'); },
            save: async () => {},
        }),
        /401 Unauthorized/,
    );
    assert.equal(attempts, 1);
});

test('does not recursively split a structurally invalid schema response', async () => {
    const source = messages([1, 1, 1, 1]);
    let attempts = 0;
    await assert.rejects(
        processAdaptiveExtractionChunks([{ messages: source, tokens: 4 }], {
            measureMessages: measure,
            extract: async () => {
                attempts++;
                throw new Error('Extractor field "facts" is not an array.');
            },
            save: async () => {},
        }),
        /facts.*not an array/i,
    );
    assert.equal(attempts, 1);
});
