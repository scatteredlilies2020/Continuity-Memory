import assert from 'node:assert/strict';
import test from 'node:test';
import { createVectorStorageRequester } from '../extension/vector-storage-client.js';

function response(status) {
    return { ok: status >= 200 && status < 300, status };
}

test('vector client falls back to native SillyTavern storage when the optional CM plugin is absent', async () => {
    const calls = [];
    const request = createVectorStorageRequester(async url => {
        calls.push(url);
        return response(url.startsWith('/api/plugins/') ? 404 : 200);
    });

    assert.equal((await request('list', {})).status, 200);
    assert.equal((await request('insert', {})).status, 200);
    assert.deepEqual(calls, [
        '/api/plugins/continuity-memory/vectors/list',
        '/api/vector/list',
        '/api/vector/insert',
    ]);
});

test('vector client keeps all operations on CM storage when its plugin is available', async () => {
    const calls = [];
    const request = createVectorStorageRequester(async url => {
        calls.push(url);
        return response(200);
    });

    await request('list', {});
    await request('delete', {});
    assert.deepEqual(calls, [
        '/api/plugins/continuity-memory/vectors/list',
        '/api/plugins/continuity-memory/vectors/delete',
    ]);
});

test('vector client does not hide real CM storage errors behind another backend', async () => {
    const calls = [];
    const request = createVectorStorageRequester(async url => {
        calls.push(url);
        return response(500);
    });

    assert.equal((await request('list', {})).status, 500);
    assert.deepEqual(calls, ['/api/plugins/continuity-memory/vectors/list']);
});
