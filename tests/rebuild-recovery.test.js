import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { processAdaptiveExtractionChunks } from '../extension/extraction-recovery.js';

const engine = await readFile(new URL('../extension/engine.js', import.meta.url), 'utf8');

function engineFunction(name, end, context) {
    const start = engine.indexOf(`export async function ${name}`);
    const source = engine.slice(start, engine.indexOf(end, start)).replace('export ', '');
    return runInNewContext(`${source}\n${name}`, context);
}

test('Chronicle maintenance locks before storage awaits and refuses stale chat results', async () => {
    let resolveWorld;
    let reads = 0;
    const runtime = { generation: 0, processing: false, queue: [], paused: false };
    let bound = 'world';
    const context = {
        runtime, getSettings: () => ({ enabled: true }), getBoundWorldId: () => bound,
        updateRuntime: patch => Object.assign(runtime, patch),
        api: { getWorld: () => { reads++; return new Promise(resolve => { resolveWorld = resolve; }); } },
        nextChroniclePromotion: () => { throw new Error('Must not process a stale chat'); },
        RUNTIME_CANCELLED_CODE: 'cancelled', isRuntimeCancellation: error => error.code === 'cancelled',
        queueMicrotask: () => {}, processQueue: () => {},
    };
    const maintain = engineFunction('maintainChronicleHierarchy', 'async function requireRetryStorage', context);
    const first = maintain();
    assert.equal(runtime.processing, true);
    assert.equal(await maintain(), null);
    assert.equal(reads, 1);
    bound = 'another-world';
    resolveWorld({ world: { id: 'world' } });
    await assert.rejects(first, /active memory changed/);
    assert.equal(runtime.processing, false);
    assert.equal(runtime.world, undefined);
});

test('fresh C0 rebuild splits incomplete output, saves every recovered chunk, and preserves the stability buffer', async () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({ index, text: `message ${index}` }));
    const runtime = { generation: 0, processing: false, queue: [], paused: false };
    const attempts = [];
    const saved = [];
    let resets = 0;
    const context = {
        runtime, getBoundWorldId: () => 'world', getChatKey: () => 'chat',
        getContext: () => ({ chat: messages, maxContext: 1000 }),
        getSettings: () => ({ extractionBatchMessages: 2 }), requireRetryStorage: async () => {},
        collectMemoryEligibleMessages: chat => chat, resolveDigestGroupSize: () => 2,
        partitionDigestStabilityBuffer: all => ({ extractable: all.slice(0, 6), buffered: all.slice(6) }),
        completeDigestMessages: all => all, DIGEST_STABILITY_BUFFER_MESSAGES: 2,
        updateRuntime: patch => Object.assign(runtime, patch),
        persistVerifiedEmptyWorld: async () => { resets++; return { id: 'world' }; },
        embedWorldInChat: async () => {}, resolveExtractionChunk: () => 100,
        chunkMessages: async all => [{ messages: all, tokens: all.length }],
        processAdaptiveExtractionChunks, getTokenCountAsync: async all => all.length, formatMessages: all => all,
        extractChunk: async chunk => {
            attempts.push(chunk.map(item => item.index));
            if (chunk.length > 3) throw new Error('Extractor returned text without a valid JSON object.');
            return { summary: 'Complete recovered scene' };
        },
        reviewExtractionBeforeSave: async result => result, fingerprintMessage: item => `fp-${item.index}`,
        saveExtraction: async (worldId, result, meta) => saved.push(meta),
        isRateLimitError: () => false, queueMicrotask: () => {}, processQueue: () => {},
    };
    const restart = engineFunction('restartDigestFromScratch', 'export async function restartHierarchyFromDigest', context);
    const result = await restart();
    assert.equal(resets, 1);
    assert.equal(result.chunks, 2);
    assert.equal(result.adaptiveSplits, 1);
    assert.equal(result.pendingTail, 2);
    assert.deepEqual(attempts, [[0, 1, 2, 3, 4, 5], [0, 1, 2], [3, 4, 5]]);
    assert.deepEqual(saved.map(meta => [meta.from, meta.to]), [[0, 2], [3, 5]]);
    assert.equal(runtime.processing, false);
});

test('replacement Chronicle generation uses the same cancellable retry path as automatic promotion', () => {
    const replacement = engine.slice(engine.indexOf('export async function restartHierarchyFromDigest'), engine.indexOf('async function saveExtraction'));
    assert.match(replacement, /await generateChronicleWithRetry\(nodes, epoch\)/);
});

test('pending Chronicle wakes on memory changes and retries blocked work after a cooldown', async () => {
    const source = await readFile(new URL('../extension/index.js', import.meta.url), 'utf8');
    const start = source.indexOf('const schedulePendingChronicle =');
    const end = source.indexOf('// Recover pending work', start);
    let scheduled = 0;
    const runtime = { world: { id: 'world' }, queue: [], chronicleBlocked: true, chronicleRetryAt: Date.now() + 300000 };
    const run = runInNewContext(`${source.slice(start, end)}\nschedulePendingChronicle`, {
        runtime, getSettings: () => ({ enabled: true }), activeGenerationReadiness: false,
        isGenerating: () => false, getBoundWorldId: () => 'world', nextChroniclePromotion: () => [{}],
        backgroundMemoryWork: { schedule: () => { scheduled++; } },
    });
    run();
    assert.equal(scheduled, 0);
    runtime.chronicleRetryAt = 0;
    run();
    assert.equal(scheduled, 1);
    runtime.paused = true;
    run();
    assert.equal(scheduled, 1);
    assert.match(source, /if \(becameIdle \|\| worldChanged\) schedulePendingChronicle\(\)/);
});
