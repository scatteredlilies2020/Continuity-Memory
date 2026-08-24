import assert from 'node:assert/strict';
import test from 'node:test';

test('roleplay readiness failures are configured to fall back instead of aborting', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /continuing without fresh memory/iu);
    assert.doesNotMatch(source, /Roleplay generation stopped until Continuity is ready/iu);
});

test('selected embedding retrieval hard-stops generation below minimum coverage', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /retryTransientPendingReply\(\s*'embedding coverage'/u);
    assert.match(source, /ensureEmbeddingCoverage\(runtime\.world, undefined, stopSequence\)/u);
    assert.match(source, /required 80% embedding coverage/iu);
    assert.match(source, /function resolveWithin\(value, timeout = 3000\)/u);
    assert.match(source, /queryEmbeddingMemory\(world, recent\)/u);
    assert.match(source, /this reply is using local memory matching/iu);
    assert.doesNotMatch(source, /strictEmbedding/u);
});

test('generation queries an index that has reached minimum coverage without waiting for full sync', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /embeddingCoverageReady\(indexed, total\)/u);
    assert.match(source, /generation readiness has enforced the minimum coverage/u);
    assert.match(source, /const indexCoverage = index\.status === 'ready'/u);
    assert.doesNotMatch(source, /if \(index\.status !== 'ready' && options\.waitForActiveSync\)/u);
    assert.doesNotMatch(source, /await activeSync/u);
});

test('embedding replacement keeps the previous usable index until new vectors are stored', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    const insert = source.indexOf("await vectorRequest('insert'");
    const cleanup = source.indexOf("await vectorRequest('delete'");
    assert.ok(insert >= 0);
    assert.ok(cleanup > insert);
    assert.match(source, /Keep obsolete vectors until every replacement has been stored/u);
});

test('embedding builds are serialized across restored browser page instances', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /globalThis\.navigator\?\.locks\?\.request/u);
    assert.match(source, /continuity-embedding-index:/u);
});

test('automatic memory-change sync resumes a previously paused or stopped vector index', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /settings\.embeddingAutoSync \? resumeEmbeddingIndexing\(world\) : inspectEmbeddingIndex\(world\)/u);
});
