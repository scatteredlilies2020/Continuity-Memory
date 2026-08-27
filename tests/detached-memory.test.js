import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseDetachedTaskPayload } from '../plugin/detached-jobs.js';

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
