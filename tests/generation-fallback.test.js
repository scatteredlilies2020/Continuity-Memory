import assert from 'node:assert/strict';
import test from 'node:test';

test('roleplay readiness failures are configured to fall back instead of aborting', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /continuing without fresh memory/iu);
    assert.doesNotMatch(source, /Roleplay generation stopped until Continuity is ready/iu);
});

test('selected embedding retrieval is scheduled without blocking roleplay generation', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /scheduleEmbeddingIndexSync\(runtime\.world, 0, true\)/u);
    assert.match(source, /function resolveWithin\(value, timeout = 3000\)/u);
    assert.match(source, /queryEmbeddingMemory\(world, recent, \{ waitForActiveSync: true \}\)/u);
    assert.match(source, /this reply is using local memory matching/iu);
    assert.doesNotMatch(source, /completeVectorsForGeneration/u);
    assert.doesNotMatch(source, /retryTransientPendingReply\('vector indexing'/u);
    assert.doesNotMatch(source, /strictEmbedding/u);
});

test('generation gives a real in-flight embedding sync its bounded grace period', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /options\.waitForActiveSync/u);
    assert.match(source, /activeWorldSyncs\.get\(world\.id\)/u);
    assert.doesNotMatch(source, /options\.requireReady/u);
});

test('automatic memory-change sync resumes a previously paused or stopped vector index', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /settings\.embeddingAutoSync \? resumeEmbeddingIndexing\(world\) : inspectEmbeddingIndex\(world\)/u);
});
