import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildEmbeddingQuery } from '../extension/embedding-index.js';
import { resolveEmbeddingProvider } from '../extension/embedding-provider.js';
import { checkRetrievalDeadline } from '../extension/retrieval-assist.js';
import { embeddingCoverageReady } from '../extension/embedding-policy.js';

test('cached semantic ranks require the current query, revision, provider, and retrieval settings', () => {
    const source = readFileSync(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8');
    const fn = source.match(/export function getCachedEmbeddingMemory\([^]*?^\}/mu)[0].replace('export ', '');
    const settings = { embeddingProvider: 'proxy', embeddingProxyUrl: 'http://localhost:17777/api',
        embeddingProxyModel: 'embedding-test', retrievalQueryMessages: 6, embeddingTopK: 100, embeddingThreshold: 0.2 };
    const world = { id: 'world-a', revision: 4 };
    const messages = [{ name: 'User', is_user: true, mes: 'The blue gate.' }];
    const queryCache = new Map();
    const key = `${world.id}|${world.revision}|${resolveEmbeddingProvider(settings).fingerprint}|ready|100|0.2|${buildEmbeddingQuery(messages, 6, 6000)}`;
    queryCache.set(key, [['fact:blue-gate', 1]]);
    const context = { getSettings: () => settings, providerRequest: () => resolveEmbeddingProvider(settings), buildEmbeddingQuery, queryCache };
    vm.runInNewContext(fn, context);
    const read = context.getCachedEmbeddingMemory;
    assert.equal(read(world, messages).get('fact:blue-gate'), 1);
    assert.equal(read({ ...world, revision: 5 }, messages), null);
    assert.equal(read(world, [{ ...messages[0], mes: 'The red key.' }]), null);
    settings.embeddingProxyModel = 'new-model';
    assert.equal(read(world, messages), null);
    settings.embeddingProxyModel = 'embedding-test';
    settings.embeddingTopK = 20;
    assert.equal(read(world, messages), null);
});

function queryFixture(overrides = {}) {
    const source = readFileSync(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8');
    const fn = source.match(/export async function queryEmbeddingMemory\([^]*?^\}/mu)[0].replace('export ', '');
    const requests = [];
    const context = {
        checkRetrievalDeadline, embeddingCoverageReady, getSettings: () => ({}), providerRequest: () => ({ fingerprint: 'provider', body: {} }),
        indexSignature: () => 'signature', syncedIndexes: new Map([['world', 'signature']]), queryCache: new Map(),
        buildEmbeddingQuery: () => 'current query', buildEmbeddingDocuments: () => [], collectionId: () => 'collection',
        vectorRequest: async (...args) => { requests.push(args); return {}; },
        semanticRanksFromResponse: () => new Map([['fact:current', 1]]),
        ...overrides,
    };
    vm.runInNewContext(fn, context);
    return { run: context.queryEmbeddingMemory, context, requests };
}

test('late embedding responses are rejected before they can enter the query cache', async t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const fixture = queryFixture({ vectorRequest: async () => { now = 200; return {}; } });
    await assert.rejects(fixture.run({ id: 'world' }, [], { deadline: 100 }), { name: 'TimeoutError' });
    assert.equal(fixture.context.queryCache.size, 0);
});

test('the retrieval budget includes index inspection and prevents a second overdue request', async t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const fixture = queryFixture({ syncedIndexes: new Map(),
        inspectEmbeddingIndex: async () => { now = 200; return { status: 'ready', indexed: 4, total: 4 }; } });
    await assert.rejects(fixture.run({ id: 'world' }, [], { deadline: 100 }), { name: 'TimeoutError' });
    assert.deepEqual(fixture.requests, []);
});
