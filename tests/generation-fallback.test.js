import assert from 'node:assert/strict';
import test from 'node:test';

test('roleplay readiness failures are configured to fall back instead of aborting', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /continuing without fresh memory/iu);
    assert.doesNotMatch(source, /Roleplay generation stopped until Continuity is ready/iu);
});

test('roleplay uses latency-safe local retrieval without starting embeddings', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    assert.match(source, /localOnly: true/u);
    assert.match(source, /reason: 'latency-safe'/u);
    assert.doesNotMatch(source, /continueEmbeddingAfterReplyRelease|ensureEmbeddingCoverage|queryEmbeddingWithRetries|Vector retrieval timed out/u);
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
    assert.doesNotMatch(preparation, /backgroundMemoryWork\.schedule|await maybeAutoExtract|await ensureEmbeddingCoverage|retryPendingReply|completeDigestForGeneration/u);
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
    assert.doesNotMatch(received, /Embedding|embedding/u);
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

test('opening an externally updated chat drains pending Digest after mutation reconciliation', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const start = source.indexOf('function scheduleMutationSync');
    const end = source.indexOf('async function onChatChanged', start);
    const reconciliation = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(reconciliation, /syncChangedExtractions\(\)/u);
    assert.match(reconciliation, /backgroundMemoryWork\.schedule\(0\)/u);
    assert.ok(reconciliation.indexOf('syncChangedExtractions()') < reconciliation.indexOf('backgroundMemoryWork.schedule(0)'));
});

test('background memory enforces Chronicle capacity even when no Digest is pending', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const start = source.indexOf('const backgroundMemoryWork = createBackgroundScheduler');
    const end = source.indexOf('onRuntimeStop(', start);
    const worker = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(source, /maintainChronicleHierarchy/u);
    assert.match(worker, /const result = await maybeAutoExtract\(false\);/u);
    assert.match(worker, /const hierarchy = await maintainChronicleHierarchy\(\);/u);
    assert.match(worker, /if \(!result && !hierarchy\) return;/u);
    assert.ok(worker.indexOf('await maybeAutoExtract(false)') < worker.indexOf('await maintainChronicleHierarchy()'));
    assert.ok(worker.indexOf('await maintainChronicleHierarchy()') < worker.indexOf('if (!result && !hierarchy) return'));
});

test('automatic Chronicle maintenance owns the processing lock and drains recursively', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/engine.js', import.meta.url), 'utf8'));
    const start = source.indexOf('export async function maintainChronicleHierarchy');
    const end = source.indexOf('async function requireRetryStorage', start);
    const maintenance = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(maintenance, /if \(runtime\.processing \|\| runtime\.queue\.length\) return null;/u);
    assert.match(maintenance, /processing: true/u);
    assert.match(maintenance, /while \(await buildNextChronicle\(worldId, epoch\)\) chroniclePromotions\+\+;/u);
    assert.match(maintenance, /finally \{[\s\S]*processing: false/u);
});

test('changing Recursive Chronicle settings schedules immediate maintenance', async () => {
    const index = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const ui = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/ui.js', import.meta.url), 'utf8'));
    assert.match(index, /initUI\(\{ scheduleMemoryMaintenance: \(\) => backgroundMemoryWork\.schedule\(0\) \}\)/u);
    assert.match(ui, /export function initUI\(\{ scheduleMemoryMaintenance = null \} = \{\}\)/u);
    assert.match(ui, /continuity_hierarchy_mode[\s\S]*scheduleChronicleMaintenance/u);
    assert.match(ui, /continuity_chronicle_capacity[\s\S]*scheduleChronicleMaintenance/u);
    assert.match(ui, /continuity_chronicle_fan_in[\s\S]*scheduleChronicleMaintenance/u);
});

test('generation defers branch repair instead of failing while background Digest owns the processing lock', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/engine.js', import.meta.url), 'utf8'));
    const start = source.indexOf('export async function repairDivergedBranch');
    const end = source.indexOf('export async function repairTailRollback', start);
    const repair = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(repair, /if \(runtime\.processing\) return \{ deferred: true, repaired: false \};/u);
    assert.doesNotMatch(repair, /Wait for current processing to finish/u);
});

test('an explicit vector query requires a fully complete index', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    assert.match(source, /index\.status !== 'ready' \|\| indexed !== total/u);
    assert.match(source, /until all \$\{total\} records are ready/u);
    assert.doesNotMatch(source, /hasUsablePartialIndex|embeddingCoverageReady/u);
    assert.doesNotMatch(source, /if \(index\.status !== 'ready' && options\.waitForActiveSync\)/u);
    assert.doesNotMatch(source, /await activeSync/u);
});

test('unchanged replies do not schedule embeddings while memory revisions do', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const receivedStart = source.indexOf('eventSource.on(event_types.MESSAGE_RECEIVED');
    const receivedEnd = source.indexOf('eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY', receivedStart);
    const received = source.slice(receivedStart, receivedEnd);
    assert.doesNotMatch(received, /Embedding|embedding|scheduleEmbeddingIndexSync/u);
    assert.match(source, /worldRevision !== lastObservedWorldRevision/u);
    assert.match(source, /scheduleEmbeddingIndexSync\(state\.world, 300, changedDuringSession\)/u);
    assert.doesNotMatch(source, /continueEmbeddingAfterReplyRelease|ensureEmbeddingCoverage|generationEmbeddingCompletion/u);
});

test('a memory revision observed during roleplay readiness remains queued for embedding sync', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8'));
    const interceptorStart = source.indexOf('globalThis.continuityMemoryGenerateInterceptor');
    const preparationStart = source.indexOf('async function prepareRoleplayGeneration', interceptorStart);
    const interceptor = source.slice(interceptorStart, preparationStart);
    const listenerStart = source.indexOf('onRuntimeChange(state =>');
    const listenerEnd = source.indexOf('\n    });\n\n    scheduleInjectionRefresh();', listenerStart);
    const listener = source.slice(listenerStart, listenerEnd);
    assert.doesNotMatch(interceptor, /pendingEmbeddingSync\s*=\s*null/u);
    assert.match(listener, /state\.processing \|\| activeGenerationReadiness/u);
    assert.match(listener, /pendingEmbeddingSync = \{/u);
    assert.match(listener, /!state\.processing && !activeGenerationReadiness && pendingEmbeddingSync/u);
    assert.match(listener, /scheduleEmbeddingIndexSync\(world, 300, allowAutomaticBuild\)/u);
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

test('automatic embedding sync is revision-driven and full Build reaches 100%', async () => {
    const retrieval = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'));
    const ui = await import('node:fs/promises').then(fs => fs.readFile(new URL('../extension/ui.js', import.meta.url), 'utf8'));
    assert.match(retrieval, /allowAutomaticBuild && settings\.embeddingAutoSync/u);
    assert.match(retrieval, /resumeEmbeddingIndexing\(world\)/u);
    assert.match(ui, /continuity_embedding_build'[\s\S]*resumeEmbeddingIndexing\(runtime\.world\)/u);
    assert.match(ui, /continuity_embedding_rebuild'[\s\S]*rebuildEmbeddingIndex\(runtime\.world\)/u);
    assert.match(ui, /Completing the selected embedding index to 100%/u);
});
