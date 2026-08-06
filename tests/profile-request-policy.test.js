import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedProfileOptions, isolatedProfilePayload } from '../extension/profile-request-policy.js';

test('connection profile calls exclude preset and instruct prompt additions', () => {
    const signal = new AbortController().signal;
    assert.deepEqual(isolatedProfileOptions({ signal }), {
        stream: false,
        extractData: false,
        includePreset: false,
        includeInstruct: false,
        signal,
    });
});

test('connection profile calls remove hard sampling and disable custom prompt post-processing', () => {
    assert.deepEqual(isolatedProfilePayload({
        temperature: 0.2,
        top_p: 0.9,
        custom_prompt_post_processing: 'merge',
    }), {
        custom_prompt_post_processing: '',
    });
});
