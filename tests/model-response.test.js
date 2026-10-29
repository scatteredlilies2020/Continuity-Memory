import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { requestModel } from '../plugin/model-response.js';

const encode = value => new TextEncoder().encode(value);
const event = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
const reply = '{"title":"A journey","summary":"The company leaves."}';
const stream = ': joining queue at position 0\n\n: queue heartbeat payload size: 512\n\n'
    + event({ reasoning_content: 'Private reasoning, not memory output.' })
    + event({ content: reply.slice(0, 18) }) + event({ content: reply.slice(18) })
    + event({}, 'stop') + 'data: [DONE]\n\n';

function chunksResponse(chunks, headers = {}) {
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encode(chunk));
            controller.close();
        },
    }), { headers });
}

for (const contentType of [null, 'text/plain', 'application/json', 'text/event-stream; charset=utf-8']) {
    test(`decodes a completed model stream with content type ${contentType}`, async () => {
        const progress = [];
        const headers = contentType ? { 'Content-Type': contentType } : {};
        // Split framing and JSON across chunks as a proxy or TCP connection can.
        const chunks = stream.match(/.{1,7}/gs);
        const { response, payload } = await requestModel(async () => chunksResponse(chunks, headers),
            'http://example.invalid', {}, 1000, item => progress.push(item));
        assert.equal(response.ok, true);
        assert.equal(payload.choices[0].message.content, reply);
        assert.equal(payload.choices[0].finish_reason, 'stop');
        assert.ok(progress.some(item => item.reasoningCharacters > 0));
        assert.ok(!JSON.stringify(payload).includes('Private reasoning'));
        assert.ok(!JSON.stringify(progress).includes('Private reasoning'));
    });
}

test('SillyTavern-style HTTP forwarding without Content-Type preserves streamed results', async t => {
    const server = createServer((_req, res) => res.end(stream));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { payload, response } = await requestModel(fetch, `http://127.0.0.1:${server.address().port}`, {}, 1000);
    assert.equal(response.headers.get('content-type'), null);
    assert.equal(payload.choices[0].message.content, reply);
});

test('split data field and CRLF framing are detected without an initial queue comment', async () => {
    const text = (event({ content: reply }) + event({}, 'stop')).replaceAll('\n', '\r\n');
    const chunks = ['\uFEFF \r\n', 'd', 'a', 't', 'a', text.slice(4)];
    const { payload } = await requestModel(async () => chunksResponse(chunks), 'http://example.invalid', {}, 1000);
    assert.equal(payload.choices[0].message.content, reply);
});

test('headerless reasoning resets the idle watchdog, not merely queue heartbeats', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let controller;
    const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
    const pending = requestModel(async () => response, 'http://example.invalid', {}, 70);
    await new Promise(setImmediate);
    for (let n = 0; n < 5; n++) {
        t.mock.timers.tick(50);
        controller.enqueue(encode(event({ reasoning_content: 'thinking' })));
        await new Promise(setImmediate);
    }
    controller.enqueue(encode(event({ content: reply }, 'stop')));
    controller.close();
    assert.equal((await pending).payload.choices[0].message.content, reply);
});

test('headerless heartbeat-only streams still time out', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let controller;
    const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
    const pending = requestModel(async () => response, 'http://example.invalid', {}, 70);
    const rejected = assert.rejects(pending, /timed out waiting for progress/);
    await new Promise(setImmediate);
    controller.enqueue(encode(': heartbeat\n\n'));
    await new Promise(setImmediate);
    t.mock.timers.tick(71);
    await rejected;
    controller.close();
});

test('headerless stream disconnects are not accepted as complete output', async () => {
    await assert.rejects(requestModel(async () => chunksResponse([event({ content: reply })]),
        'http://example.invalid', {}, 1000), /closed before the response completed/);
});

test('streamed output limits and provider errors remain authoritative', async () => {
    const { payload } = await requestModel(async () => chunksResponse([event({ content: reply }, 'length')]),
        'http://example.invalid', {}, 1000);
    assert.equal(payload.choices[0].finish_reason, 'length');
    await assert.rejects(requestModel(async () => chunksResponse([
        'data: {"error":{"message":"Rate limited","code":429}}\n\n',
    ]), 'http://example.invalid', {}, 1000), error => error.status === 429 && error.message === 'Rate limited');
});

test('ordinary JSON completion and structured HTTP errors keep their original payloads', async () => {
    const completion = { choices: [{ message: { content: reply }, finish_reason: 'stop' }] };
    const result = await requestModel(async () => chunksResponse([JSON.stringify(completion)]),
        'http://example.invalid', {}, 1000);
    assert.deepEqual(result.payload, completion);
    const error = { error: { message: 'Invalid model.' } };
    const failed = await requestModel(async () => new Response(JSON.stringify(error), { status: 400 }),
        'http://example.invalid', {}, 1000);
    assert.equal(failed.response.status, 400);
    assert.deepEqual(failed.payload, error);
});

test('malformed bodies do not flood errors with raw model output or HTML', async () => {
    for (const status of [200, 502]) {
        const { payload } = await requestModel(async () => new Response('Private output '.repeat(10000), { status }),
            'http://example.invalid', {}, 1000);
        assert.match(payload.error, /not valid JSON/);
        assert.ok(payload.error.length < 200);
        assert.ok(!payload.error.includes('Private output'));
    }
});
