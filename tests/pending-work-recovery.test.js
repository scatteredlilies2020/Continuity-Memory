import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { retryConnection } from '../extension/connection-retry.js';
import { previewRetrieval } from '../extension/retrieval-preview.js';
import { localRequest } from '../extension/local-request.js';
import { retryChroniclePromotion } from '../extension/chronicle-retry.js';
import { requestModel } from '../plugin/model-response.js';
import { createDetachedJob, getDetachedJob, cancelDetachedJob } from '../plugin/detached-jobs.js';

test('connection outages keep one operation pending beyond the former attempt limit', async () => {
    let attempts = 0;
    const delays = [];
    assert.equal(await retryConnection(() => {
        if (++attempts < 12) throw new Error('503 Service Unavailable');
        return 'completed';
    }, { wait: async delay => delays.push(delay) }), 'completed');
    assert.equal(attempts, 12);
    assert.equal(delays.at(-1), 60000);
});

test('persistent invalid Chronicle output has bounded correction, independently of connection retries', async () => {
    let calls = 0;
    await assert.rejects(retryChroniclePromotion(() => {
        calls++;
        throw new Error('C1 summarizer returned no summary.');
    }, { wait: async () => {} }), error => error.code === 'CONTINUITY_INVALID_RESPONSE');
    assert.equal(calls, 3);
});

test('streamed reasoning and content can outlast the idle watchdog without another request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0, output;
    const response = new Response(new ReadableStream({ start(controller) { output = controller; } }),
        { headers: { 'Content-Type': 'text/event-stream' } });
    const pending = requestModel(async () => { calls++; return response; }, 'http://example.invalid', {}, 70);
    await new Promise(setImmediate);
    for (let n = 0; n < 6; n++) {
        t.mock.timers.tick(50);
        output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: n < 4 ? { reasoning_content: 'thinking' } : { content: '{}' }, finish_reason: null }] })}\n\n`));
        await new Promise(setImmediate);
    }
    output.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    output.close();
    const payload = await pending;
    assert.equal(calls, 1);
    assert.equal(payload.payload.choices[0].message.content, '{}{}');
    assert.ok(!JSON.stringify(payload.payload).includes('thinking'));
});

test('a provider ignoring abort cannot strand the idle watchdog', async () => {
    await assert.rejects(requestModel(() => new Promise(() => {}), 'http://example.invalid', {}, 10), /timed out waiting for progress/);
});

for (const stage of ['headers', 'body']) test(`local status waits end when ${stage} ignore cancellation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => stage === 'headers' ? new Promise(() => {})
        : { text: () => new Promise(() => {}) });
    const pending = localRequest('http://example.invalid', {}, 15);
    const rejected = assert.rejects(pending, /server request timed out/);
    await new Promise(setImmediate);
    t.mock.timers.tick(20);
    await rejected;
});

function result() {
    return { sceneCapsule: { title: 'Tea', opening: 'Mira makes tea.', beats: [], closing: 'Tea is ready.' },
        entities: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [], chronicleEntry: 'Mira made tea.' };
}
function setup(label, { outages = 0, loseSaveAck = false } = {}) {
    const req = { socket: { localPort: 8000 }, headers: {}, user: { directories: { root: `pending-${label}` } } };
    const payload = { worldId: 'world', chatKey: 'chat', requestId: `request-${label}`, tasks: [{
        messages: [{ index: 0, name: 'Mira', text: 'Mira makes tea.' }], request: { messages: [] },
    }] };
    let world = { id: 'world', revision: 0 }, calls = 0, saves = 0;
    const storage = {
        loadWorld: async () => structuredClone(world),
        saveWorld: async (_worldId, next) => {
            saves++;
            if (saves <= outages) throw new Error('503 Service Unavailable');
            world = { ...structuredClone(next), revision: world.revision + 1 };
            if (loseSaveAck && saves === outages + 1) throw new Error('502 Bad Gateway');
        },
    };
    const options = { retryDelayMs: 10, maxRetryDelayMs: 10, fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result()) }, finish_reason: 'stop' }] }));
    } };
    return { req, payload, storage, options, calls: () => calls, world: () => world, saves: () => saves };
}
async function finish(req, job) {
    for (let n = 0; n < 200; n++) {
        const state = getDetachedJob(req, job.id);
        if (['complete', 'error', 'cancelled'].includes(state.status)) return state;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    cancelDetachedJob(req, job.id);
    assert.fail('Memory work did not finish.');
}

for (const loseSaveAck of [false, true]) test(`a completed response is reused through storage outages${loseSaveAck ? ' and a lost save acknowledgement' : ''}`, async () => {
    const h = setup(`save-${loseSaveAck}`, { outages: 6, loseSaveAck });
    const { job } = createDetachedJob(h.req, structuredClone(h.payload), h.storage, h.options);
    assert.equal((await finish(h.req, job)).status, 'complete');
    assert.equal(h.calls(), 1, 'Saving must never re-run the model.');
    assert.equal(h.world().extractions.length, 1);
    assert.equal(h.world().revision, 1);
    // Re-submit the same logical request after the server finished but the
    // browser lost its acknowledgement.
    const repeated = createDetachedJob(h.req, h.payload, h.storage, h.options);
    assert.equal(repeated.existing, true);
    assert.equal(repeated.job.id, job.id);
    assert.equal(h.calls(), 1);
    // Even a new submission id cannot regenerate unchanged saved messages.
    const newer = createDetachedJob(h.req, { ...h.payload, requestId: 'new-id', tasks: [{
        messages: [{ index: 0, name: 'Mira', text: 'Mira makes tea.' }], request: { messages: [] },
    }] }, h.storage, h.options);
    assert.equal((await finish(h.req, newer.job)).status, 'complete');
    assert.equal(h.calls(), 1);
});

test('a browser-side disconnect does not cancel a server job; CM Stop does', async () => {
    const h = setup('stop');
    h.options.fetchImpl = async () => { throw new Error('503 Service Unavailable'); };
    const { job } = createDetachedJob(h.req, h.payload, h.storage, h.options);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(getDetachedJob(h.req, job.id).status, 'processing');
    cancelDetachedJob(h.req, job.id);
    assert.equal((await finish(h.req, job)).status, 'cancelled');
    assert.equal(h.world().extractions, undefined);
});

const indexSource = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
test('greetings and paused memory do not trigger background requests; accepted replies enable the current chat only', () => {
    let listener, scheduled = 0;
    const scope = vm.createContext({ event_types: { MESSAGE_RECEIVED: 'received' },
        eventSource: { on: (_name, callback) => { listener = callback; } },
        automaticWorkChatKey: null, lastOpenedChatKey: null, runtime: { paused: false },
        scheduleInjectionRefresh() {}, getChatKey: () => 'chat',
        getContext: () => ({ chat: [{ is_user: true }] }),
        backgroundMemoryWork: { schedule: () => { scheduled++; } },
    });
    vm.runInContext(indexSource.match(/    eventSource.on\(event_types.MESSAGE_RECEIVED,[^]*?^    \}\);/m)[0], scope);
    listener(0, 'first_message');
    assert.equal(scheduled, 0);
    assert.equal(scope.automaticWorkChatKey, null);
    scope.runtime.paused = true;
    listener(2, 'normal');
    assert.equal(scheduled, 0);
    scope.runtime.paused = false;
    listener(2, 'normal');
    assert.equal(scheduled, 1);
    assert.equal(scope.automaticWorkChatKey, 'chat');
    assert.equal(scope.lastOpenedChatKey, 'chat');
    scope.getContext = () => ({ chat: [{ is_user: false }] });
    listener(1, 'continue');
    assert.equal(scheduled, 2, 'An explicit Continue is accepted play without a typed user message.');
});

test('background previews do not prepare, repair or generate memory', () => {
    const preview = indexSource.match(/function scheduleInjectionRefresh\([^]*?^}/m)[0];
    assert.doesNotMatch(preview, /prepareRoleplayGeneration|maybeAutoExtract|repairDivergedBranch|ensureCurrentChatMemory/);
    const opened = indexSource.match(/async function onChatChanged\([^]*?^}/m)[0];
    assert.match(opened, /if \(chatKey !== lastOpenedChatKey\) automaticWorkChatKey = null/);
    assert.match(opened, /if \(automaticWorkChatKey === getChatKey\(\)\) scheduleMutationSync/);
});

test('card browsing uses only saved recall across all retrieval modes', () => {
    let reads = 0;
    const cached = new Map([['fact:tea', 1]]);
    for (let card = 0; card < 30; card++) {
        for (const mode of ['local', 'ai-expanded', 'embedding-hybrid']) {
            const result = previewRetrieval({ mode, world: { id: `world-${card}` }, messages: [],
                peekEmbedding: () => { reads++; return card % 2 ? cached : null; } });
            assert.equal(result.assist.phase, 'preview');
            assert.equal(result.assist.executed, mode === 'embedding-hybrid' && card % 2 === 1);
        }
    }
    assert.equal(reads, 30, 'Only embedding previews read the local cache.');
    assert.equal(previewRetrieval({ mode: 'embedding-hybrid', peekEmbedding: () => { throw new Error('Missing model'); } }).ranks.size, 0);
});
