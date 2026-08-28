import assert from 'node:assert/strict';
import test from 'node:test';

test('roleplay readiness failures are configured to fall back instead of aborting', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /continuing without fresh memory/iu);
    assert.doesNotMatch(source, /Roleplay generation stopped until Continuity is ready/iu);
});

test('roleplay uses latency-safe local retrieval while embeddings converge in the background', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /localOnly: true/u);
    assert.match(source, /reason: 'latency-safe'/u);
    assert.match(source, /continueEmbeddingAfterReplyRelease\(runtime\.world, runtime\.stopSequence\)/u);
    assert.doesNotMatch(source, /queryEmbeddingWithRetries|Vector retrieval timed out/u);
    assert.doesNotMatch(source, /required 99% embedding coverage|Reply pending while Continuity/u);
});

test('embedding inserts get a long stall watchdog and restart from saved vectors', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /VECTOR_REQUEST_TIMEOUT_MS = 45000/u);
    assert.match(source, /EMBEDDING_INSERT_TIMEOUT_MS = 180000/u);
    assert.match(source, /EMBEDDING_STALL_RESTARTS = 2/u);
    assert.match(source, /const timeoutMs = route === 'insert' \? EMBEDDING_INSERT_TIMEOUT_MS : VECTOR_REQUEST_TIMEOUT_MS/u);
    assert.match(source, /requestController\.abort\(new DOMException\('Vector request timed out\.'/u);
    assert.match(source, /it will resume from stored vectors/u);
    assert.match(source, /async function insertEmbeddingBatch/u);
    assert.match(source, /Embedding batch \$\{batch\} stalled; restarting/u);
    assert.match(source, /pending = items\.filter\(item => !savedHashes\.has/u);
    assert.match(source, /globalThis\.clearTimeout\(timer\)/u);
});

test('memory catch-up never retries or waits on the visible roleplay path', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const start = source.indexOf('async function prepareRoleplayGeneration');
    const end = source.indexOf('async function performInjectionRefresh', start);
    const preparation = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(preparation, /Roleplay released immediately/u);
    assert.doesNotMatch(preparation, /backgroundMemoryWork\.schedule|await maybeAutoExtract|await ensureEmbeddingCoverage|retryPendingReply|completeL1ForGeneration/u);
    assert.match(source, /event_types\.GENERATION_STOPPED/u);
});

test('background memory resumes only after the visible reply returns', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const start = source.indexOf('eventSource.on(event_types.GENERATION_STARTED');
    const end = source.indexOf('event_types.GENERATION_STOPPED', start);
    const handler = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(handler, /const roleplayGeneration = !dryRun && shouldGateRoleplayGeneration/u);
    assert.doesNotMatch(handler, /resumeRuntime|backgroundMemoryWork\.schedule/u);
    const receivedStart = source.indexOf('eventSource.on(event_types.MESSAGE_RECEIVED');
    const receivedEnd = source.indexOf('eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY', receivedStart);
    const received = source.slice(receivedStart, receivedEnd);
    assert.match(received, /if \(runtime\.paused\) resumeRuntime\(\)/u);
    assert.match(received, /backgroundMemoryWork\.schedule\(\)/u);
    assert.match(received, /continueEmbeddingAfterReplyRelease/u);
});

test('background memory captures the runtime stop sequence before processing', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const start = source.indexOf('const backgroundMemoryWork = createBackgroundScheduler');
    const end = source.indexOf('onRuntimeStop(', start);
    const worker = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(worker, /const stopSequence = runtime\.stopSequence;/u);
    assert.ok(worker.indexOf('const stopSequence') < worker.indexOf('runtime.stopSequence !== stopSequence'));
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

test('after a reply returns, embeddings keep restarting to full coverage', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /function continueEmbeddingAfterReplyRelease/u);
    assert.match(source, /ensureEmbeddingCoverage\(world, 1, stopSequence\)/u);
    assert.match(source, /continueEmbeddingAfterReplyRelease\(runtime\.world, runtime\.stopSequence\)/u);
    assert.match(source, /Background embedding completion failed/u);
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
