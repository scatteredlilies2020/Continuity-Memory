import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveredModelIds } from '../extension/model-discovery.js';

const ok = { ok: true, status: 200, statusText: 'OK' };

test('HTTP 200 with a host error explains the upstream failure, not 200 OK', () => {
    assert.throws(() => discoveredModelIds(ok, { error: true, data: { data: [] } }), error => {
        assert.match(error.message, /upstream model-list failure/);
        assert.match(error.message, /SillyTavern server log/);
        assert.match(error.message, /Manual model entry/);
        assert.doesNotMatch(error.message, /200 OK/);
        return true;
    });
});

test('discovery retains structured, string and top-level server error messages', () => {
    for (const payload of [{ error: { message: 'Unauthorized' } }, { error: 'Unauthorized' }, { error: true, message: 'Unauthorized' }]) {
        assert.throws(() => discoveredModelIds(ok, payload), /Unauthorized/);
    }
    assert.throws(() => discoveredModelIds({ ok: false, status: 503, statusText: 'Service Unavailable' }, {}), /HTTP 503 Service Unavailable/);
});

test('discovery accepts supported catalogs and filters malformed entries', () => {
    const entries = [' qwen ', { id: 'qwen' }, { name: 'alpha' }, null, {}, { id: 123 }, ''];
    for (const payload of [entries, { data: entries }, { models: entries }]) {
        assert.deepEqual(discoveredModelIds(ok, payload), ['alpha', 'qwen']);
    }
    for (const payload of [{}, { data: [] }, { data: [null, {}] }]) {
        assert.throws(() => discoveredModelIds(ok, payload), /no model IDs/);
    }
});
