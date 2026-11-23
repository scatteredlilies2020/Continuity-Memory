import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { EXTRACTION_OUTPUT_RECOVERY_GUIDE, isAdaptiveExtractionSplitError, isExplicitExtractionOutputLimitError } from '../extension/extraction-recovery.js';
import { extractionResponseTokens } from '../extension/memory-response-policy.js';
import { assertCompleteExtractionRecords, extractionCompletenessFeedback, normalizeDigestNarrative } from '../extension/extraction-contract.js';
import { parseJsonResponse } from '../extension/json-response.js';
import { mergeExtraction } from '../extension/memory-model.js';

const engine = await readFile(new URL('../extension/engine.js', import.meta.url), 'utf8');
const start = engine.indexOf('async function extractChunk(');
const end = engine.indexOf('function prepareExtractionPrompts(', start);

function makeExtractor(requestExtraction, settings = { extractionOutputTokens: 0 }, plannedCapacity = undefined, overrides = {}) {
    const runtime = {};
    const updates = [];
    const context = {
        runtime,
        getSettings: () => settings,
        prepareExtractionPrompts: () => ({ prompt: 'prompt', fallbackPrompt: 'fallback', systemPrompt: 'system', responseTokens: plannedCapacity }),
        extractionCompletenessFeedback,
        extractionResponseTokens,
        requestExtraction,
        updateRuntime: patch => updates.push(patch),
        parseJsonResponse,
        normalizeDigestNarrative: result => result,
        validateExtractionProvenance: async result => result,
        validateResult: parsed => ({ result: parsed, validation: {} }),
        applySourceAttributionFailClosed: () => 0,
        isRateLimitError: () => false,
        isExplicitExtractionOutputLimitError,
        isAdaptiveExtractionSplitError,
        EXTRACTION_OUTPUT_RECOVERY_GUIDE,
        ...overrides,
    };
    return { extract: runInNewContext(`${engine.slice(start, end)}\nextractChunk`, context), updates };
}

test('browser saves one full Digest narrative in C0 without retrying a bogus legacy field', async () => {
    const sentence = 'Alice kept the route secret while she considered whether to leave the city.';
    const opening = Array(6).fill(sentence).join(' ');
    const closing = 'Bob did not learn the route.';
    let calls = 0;
    const { extract } = makeExtractor(async () => {
        calls++;
        return JSON.stringify({ sceneCapsule: { title: 'The route', opening, beats: [], closing }, chronicleEntry: 'A.' });
    }, undefined, undefined, {
        normalizeDigestNarrative,
        validateResult: result => ({ result: assertCompleteExtractionRecords(result), validation: {} }),
    });
    const world = {};
    const result = await extract([{ index: 0 }, { index: 1 }]);
    mergeExtraction(world, result, { chatKey: 'chat', from: 0, to: 1 });
    assert.equal(calls, 1);
    assert.equal(world.chronicle[0].text, `${opening} ${closing}`);
    assert.equal(Object.hasOwn(world.extractions[0].result, 'chronicleEntry'), false);
    assert.ok(world.capsules[0].opening.length < opening.length, 'overview clipping must not shorten C0');
    const replayed = {};
    mergeExtraction(replayed, world.extractions[0].result, { chatKey: 'chat', from: 0, to: 1, replayStoredExtraction: true });
    assert.equal(replayed.chronicle[0].text, world.chronicle[0].text);
});

test('a truncated single message retries with concise JSON guidance and more output capacity', async () => {
    const budgets = [];
    const { extract, updates } = makeExtractor(async (prompt, system, fallback, budget) => {
        budgets.push(budget);
        if (budgets.length === 1) throw new Error('finish_reason: length');
        assert.match(prompt, /one complete JSON object/);
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

test('browser extraction reserves planned capacity from the first call and preserves it during recovery', async () => {
    const budgets = [];
    const { extract } = makeExtractor(async (_prompt, _system, _fallback, budget) => {
        budgets.push(budget);
        if (budget < 65536) throw new Error('finish_reason: length');
        return '{}';
    }, { extractionOutputTokens: 1200 }, 32768);
    await extract([{ index: 144 }]);
    assert.deepEqual(budgets, [32768, 65536]);
});

test('a configured extraction target remains soft during initial and recovery requests', async () => {
    const budgets = [];
    const { extract } = makeExtractor(async (prompt, system, fallback, budget) => {
        budgets.push(budget);
        if (budgets.length < 3) throw new Error('Unexpected end of JSON input');
        return '{}';
    }, { extractionOutputTokens: 4096 });
    assert.deepEqual(await extract([{ index: 10, text: 'one message' }]), {});
    assert.deepEqual(budgets, [null, null, 16384]);
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

test('schema-ignoring proxy retries include explicit definitions and JSON feedback', async () => {
    const requests = [];
    const { extract, updates } = makeExtractor(async (prompt, system, fallback, budget) => {
        requests.push({ prompt, system, fallback, budget });
        return requests.length === 1 ? 'Narrative instead of JSON.' : 'Here is the "answer:\n{"facts":[]}';
    });
    assert.deepEqual(await extract([{ index: 10 }]), { facts: [] });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].prompt, 'prompt');
    assert.match(requests[1].prompt, /^fallback\n\nThe previous response was rejected/);
    assert.equal(requests[1].prompt, requests[1].fallback);
    assert.equal(requests[1].budget, null, 'Do not increase tokens just to fix wrappers.');
    assert.match(updates.at(-1).lastValidation, /Valid structured extraction after malformed-output retry/);
});

test('persistently truncated JSON never becomes a valid extraction', async () => {
    let calls = 0;
    const { extract, updates } = makeExtractor(async () => { calls++; return '{"facts":[{}]'; });
    await assert.rejects(extract([{ index: 10 }]), /without a valid JSON object.*incomplete/);
    assert.equal(calls, 3);
    assert.ok(updates.every(update => !update.lastValidation?.startsWith('Valid structured extraction')));
});
