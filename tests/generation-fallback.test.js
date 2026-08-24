import assert from 'node:assert/strict';
import test from 'node:test';

test('roleplay readiness failures are configured to fall back instead of aborting', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /continuing without fresh memory/iu);
    assert.doesNotMatch(source, /Roleplay generation stopped until Continuity is ready/iu);
});

test('selected embedding retrieval hard-stops generation below minimum coverage', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /retryPendingReply\(\s*'embedding coverage'/u);
    assert.match(source, /ensureEmbeddingCoverage\(runtime\.world, undefined, stopSequence\)/u);
    assert.match(source, /required 99% embedding coverage/iu);
    assert.match(source, /function resolveWithin\(value, timeout = 3000\)/u);
    assert.match(source, /queryEmbeddingWithRetries\(world, recent\)/u);
    assert.match(source, /this reply is using local memory matching/iu);
    assert.doesNotMatch(source, /strictEmbedding/u);
});

test('embedding retrieval retries quick failures without overlapping a slow request', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /async function queryEmbeddingWithRetries/u);
    assert.match(source, /attempt < 3/u);
    assert.match(source, /return await resolveWithin\(request, 12000\)/u);
    assert.match(source, /CONTINUITY_VECTOR_TIMEOUT/u);
    assert.match(source, /350 \* \(attempt \+ 1\)/u);
});

test('a pending reply restarts failed memory and embedding work until the user stops generation', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /async function retryPendingReply/u);
    assert.match(source, /memory processing[\s\S]*retryPendingReply|retryPendingReply\('memory processing'/u);
    assert.match(source, /retryPendingReply\('memory catch-up'/u);
    assert.match(source, /failed \(\$\{error\.message\}\)\. Restarting/u);
    assert.doesNotMatch(source, /if \(!isTransientApiError\(error\)\) throw error/u);
    assert.match(source, /event_types\.GENERATION_STOPPED/u);
    assert.match(source, /stopRuntime\('Pending reply stopped by the user/u);
});

test('opening an externally updated chat drains pending L1 after mutation reconciliation', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const start = source.indexOf('function scheduleMutationSync');
    const end = source.indexOf('async function onChatChanged', start);
    const reconciliation = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(reconciliation, /syncChangedExtractions\(\)/u);
    assert.match(reconciliation, /backgroundMemoryWork\.schedule\(0\)/u);
    assert.ok(reconciliation.indexOf('syncChangedExtractions()') < reconciliation.indexOf('backgroundMemoryWork.schedule(0)'));
});

test('generation defers branch repair instead of failing while background L1 owns the processing lock', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/engine.js', import.meta.url), 'utf8'));
    const start = source.indexOf('export async function repairDivergedBranch');
    const end = source.indexOf('export async function repairTailRollback', start);
    const repair = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(repair, /if \(runtime\.processing\) return \{ deferred: true, repaired: false \};/u);
    assert.doesNotMatch(repair, /Wait for current processing to finish/u);
});

test('generation queries an index that has reached minimum coverage without waiting for full sync', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /embeddingCoverageReady\(indexed, total\)/u);
    assert.match(source, /generation readiness has enforced the minimum coverage/u);
    assert.match(source, /const indexCoverage = index\.status === 'ready'/u);
    assert.doesNotMatch(source, /if \(index\.status !== 'ready' && options\.waitForActiveSync\)/u);
    assert.doesNotMatch(source, /await activeSync/u);
});

test('releasing a reply at safe coverage keeps restarting embeddings to full coverage', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /function continueEmbeddingAfterReplyRelease/u);
    assert.match(source, /ensureEmbeddingCoverage\(world, 1, stopSequence\)/u);
    assert.match(source, /continueEmbeddingAfterReplyRelease\(runtime\.world, stopSequence\)/u);
    assert.match(source, /Reply released at safe embedding coverage; full indexing failed/u);
    assert.match(source, /!activeGenerationReadiness && !generationEmbeddingCompletion/u);
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
