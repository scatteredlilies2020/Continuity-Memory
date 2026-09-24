import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isAdaptiveExtractionSplitError, isExplicitExtractionOutputLimitError } from '../extension/extraction-recovery.js';
import { extractionResponseTokens } from '../extension/memory-response-policy.js';

const engine = await readFile(new URL('../extension/engine.js', import.meta.url), 'utf8');
const start = engine.indexOf('async function extractChunk(');
const end = engine.indexOf('function prepareExtractionPrompts(', start);

function makeExtractor(requestExtraction, settings = { extractionOutputTokens: 0 }) {
    const runtime = {};
    const updates = [];
    const context = {
        runtime,
        getSettings: () => settings,
        prepareExtractionPrompts: () => ({ prompt: 'prompt', fallbackPrompt: 'fallback', systemPrompt: 'system' }),
        extractionCompletenessFeedback: () => '',
        extractionResponseTokens,
        requestExtraction,
        updateRuntime: patch => updates.push(patch),
        parseJsonResponse: JSON.parse,
        validateResult: parsed => ({ result: parsed, validation: {} }),
        applySourceAttributionFailClosed: () => 0,
        isRateLimitError: () => false,
        isExplicitExtractionOutputLimitError,
        isAdaptiveExtractionSplitError,
    };
    return { extract: runInNewContext(`${engine.slice(start, end)}\nextractChunk`, context), updates };
}

test('a truncated single message skips a duplicate default request and retries at a higher output limit', async () => {
    const budgets = [];
    const { extract, updates } = makeExtractor(async (prompt, system, fallback, budget) => {
        budgets.push(budget);
        if (budgets.length === 1) throw new Error('finish_reason: length');
        return '{}';
    });
    assert.deepEqual(await extract([{ index: 10, text: 'one message' }]), {});
    assert.deepEqual(budgets, [null, 16384]);
    assert.match(updates.at(-1).lastValidation, /higher-output retry/);
});

test('a truncated multi-message chunk still splits instead of increasing output tokens', async () => {
    const budgets = [];
    const { extract } = makeExtractor(async (prompt, system, fallback, budget) => {
        budgets.push(budget);
        throw new Error('finish_reason: length');
    });
    await assert.rejects(extract([{ index: 10 }, { index: 11 }]), /finish_reason: length/);
    assert.deepEqual(budgets, [null]);
});

test('a configured extraction limit is used initially and increased for single-message recovery', async () => {
    const budgets = [];
    const { extract } = makeExtractor(async (prompt, system, fallback, budget) => {
        budgets.push(budget);
        if (budgets.length < 3) throw new Error('Unexpected end of JSON input');
        return '{}';
    }, { extractionOutputTokens: 4096 });
    assert.deepEqual(await extract([{ index: 10, text: 'one message' }]), {});
    assert.deepEqual(budgets, [4096, 4096, 16384]);
});

test('non-incomplete single-message failures do not trigger the higher-budget retry', async () => {
    const budgets = [];
    const { extract } = makeExtractor(async (prompt, system, fallback, budget) => {
        budgets.push(budget);
        throw new Error('401 Unauthorized');
    });
    await assert.rejects(extract([{ index: 10 }]), /401 Unauthorized/);
    assert.deepEqual(budgets, [null, null]);
});
