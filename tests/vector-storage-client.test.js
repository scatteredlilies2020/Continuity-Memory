import assert from 'node:assert/strict';
import test from 'node:test';
import { createVectorStorageRequester, vectorStorageError } from '../extension/vector-storage-client.js';

function response(status) {
    return { ok: status >= 200 && status < 300, status };
}

test('vector errors expose server validation details and preserve HTTP status', async () => {
    const error = await vectorStorageError('purge', {
        status: 400, statusText: 'Bad Request',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: 'Collection ID is invalid' }),
    });
    assert.equal(error.status, 400);
    assert.match(error.message, /purge failed \(400 Bad Request\): Collection ID is invalid/);
    const malformed = await vectorStorageError('list', {
        status: 503, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => { throw new SyntaxError('bad JSON'); },
    });
    assert.equal(malformed.status, 503);
});

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
