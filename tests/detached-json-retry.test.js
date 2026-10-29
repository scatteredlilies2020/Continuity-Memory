import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseJsonResponse } from '../extension/json-response.js';
import { extractionCompletenessFeedback } from '../extension/extraction-contract.js';
import { appendMemoryFeedback } from '../extension/preset-prefill.js';
import { EXTRACTION_OUTPUT_RECOVERY_GUIDE, isExplicitExtractionOutputLimitError } from '../extension/extraction-recovery.js';
import { extractionRecoveryRequest } from '../extension/memory-response-policy.js';

const source = await readFile(new URL('../plugin/detached-jobs.js', import.meta.url), 'utf8');
const extractTask = source.match(/^async function extractTask\([^]*?^}/m)[0];

for (const success of [true, false]) test(`detached malformed JSON retry ${success ? 'recovers' : 'fails closed'} with explicit definitions`, async () => {
    const prefix = { role: 'assistant', content: '{' };
    const request = { model: 'proxy-model', json_schema: { name: 'extraction' },
        continuity_prefill: { prefill: '{' }, messages: [{ role: 'user', content: 'Short native-schema prompt' }, prefix] };
    const fallbackRequest = { ...request, json_schema: undefined,
        messages: [{ role: 'user', content: 'Full field definitions' }, prefix] };
    const task = { request, fallbackRequest, messages: [{ index: 1 }] };
    const before = structuredClone(task);
    let calls = 0;
    let validations = 0;
    const context = {
        isCurrentStorySnapshot: () => false,
        extractionCompletenessFeedback, appendMemoryFeedback, parseJsonResponse,
        EXTRACTION_OUTPUT_RECOVERY_GUIDE, isExplicitExtractionOutputLimitError, extractionRecoveryRequest,
        isMandatoryThinkingError: () => false, isThinkingControlError: () => false,
        shouldRetryWithoutSchema: () => false, isRateLimitError: () => false,
        backendRequest: async (job, body) => {
            calls++;
            assert.equal(validations, 0, 'Malformed output must not reach record validation.');
            if (calls === 1) assert.equal(body.messages[0].content, 'Short native-schema prompt');
            else {
                assert.equal(body.messages[0].content, 'Full field definitions');
                assert.match(body.messages.at(-2).content, /previous response was rejected/);
                assert.equal(body.messages.at(-1), prefix);
                assert.equal(body.json_schema, request.json_schema);
                assert.equal(body.continuity_prefill, request.continuity_prefill);
                assert.equal(body.model, request.model);
            }
            return success && calls === 2 ? '{"facts":[]}' : '{"facts":[';
        },
        validateResult: result => { validations++; return { result, validation: {} }; },
        validationLabel: () => 'Valid detached extraction after retry',
    };
    const extract = runInNewContext(`${extractTask}\nextractTask`, context);
    const job = { chatKey: 'chat' };
    if (success) assert.deepEqual(await extract(job, task, {}), { facts: [] });
    else await assert.rejects(extract(job, task, {}), /Structured extraction failed twice/);
    assert.equal(calls, 2);
    assert.equal(validations, success ? 1 : 0);
    assert.deepEqual(task, before, 'Retry must not mutate stored request variants.');
});
