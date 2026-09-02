import assert from 'node:assert/strict';
import test from 'node:test';

import { createDetachedJob, getDetachedJob, releaseDetachedTaskPayload } from '../plugin/detached-jobs.js';

function request(label) {
    return {
        messages: [
            { role: 'system', content: `large shared system prompt ${label}` },
            { role: 'user', content: `large extraction prompt ${label}` },
        ],
        json_schema: { value: { type: 'object', properties: { label: { const: label } } } },
    };
}

function task(label, parts = []) {
    return {
        messages: [{ index: 0, text: label }],
        request: request(`${label}-primary`),
        fallbackRequest: request(`${label}-fallback`),
        mandatoryRequest: request(`${label}-mandatory`),
        mandatoryFallbackRequest: request(`${label}-mandatory-fallback`),
        uncontrolledRequest: request(`${label}-uncontrolled`),
        parts,
    };
}

test('completed detached tasks release every retry and recursive split payload', () => {
    const left = task('left');
    const right = task('right');
    const root = task('root', [left, right]);

    releaseDetachedTaskPayload(root);

    for (const item of [root, left, right]) {
        assert.deepEqual(item.messages, []);
        assert.equal(item.parts, null);
        assert.equal(item.request, null);
        assert.equal(item.fallbackRequest, null);
        assert.equal(item.mandatoryRequest, null);
        assert.equal(item.mandatoryFallbackRequest, null);
        assert.equal(item.uncontrolledRequest, null);
    }
});

test('detached transient failures stop at the configured request limit', async () => {
    const req = {
        socket: { localPort: 3210 },
        headers: {},
        user: { directories: { root: 'detached-test' } },
    };
    let calls = 0;
    const { job } = createDetachedJob(req, {
        worldId: 'world',
        chatKey: 'chat',
        tasks: [{ messages: [{ index: 0, text: 'hello' }], request: { messages: [] } }],
    }, {
        loadWorld: async () => ({ id: 'world' }),
        saveWorld: async () => {},
    }, {
        fetchImpl: async () => {
            calls++;
            throw new Error('503 Service Unavailable');
        },
        maxNetworkAttempts: 2,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
    });

    for (let attempt = 0; attempt < 50; attempt++) {
        if (getDetachedJob(req, job.id)?.status === 'error') break;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    const finished = getDetachedJob(req, job.id);
    assert.equal(finished.status, 'error');
    assert.equal(calls, 2);
    assert.match(finished.error, /after 2 attempts.*without marking this section processed/i);
});
