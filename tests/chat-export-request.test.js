import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeChatExportRequest, normalizeNativeChatExportFilename, readNativeChatExportResponse } from '../extension/chat-export-request.js';

test('CM portable export matches the current SillyTavern chat export contract', () => {
    assert.equal(normalizeNativeChatExportFilename('Day 10'), 'Day 10.jsonl');
    assert.equal(normalizeNativeChatExportFilename('Day 10.jsonl'), 'Day 10.jsonl');
    assert.deepEqual(buildNativeChatExportRequest({ avatarUrl: 'card.png', filename: 'Day 10' }), {
        is_group: false,
        avatar_url: 'card.png',
        file: 'Day 10.jsonl',
        exportfilename: 'Day 10.jsonl',
        format: 'jsonl',
    });
});

test('CM portable export reports a plain-text server failure without parsing it as JSON', async () => {
    const response = { ok: false, status: 400, text: async () => 'Bad Request' };
    await assert.rejects(readNativeChatExportResponse(response), /Bad Request/);
});

test('CM portable export accepts a valid SillyTavern JSON response', async () => {
    const response = { ok: true, status: 200, text: async () => JSON.stringify({ result: '{"chat_metadata":{}}\n' }) };
    assert.equal((await readNativeChatExportResponse(response)).result, '{"chat_metadata":{}}\n');
});
