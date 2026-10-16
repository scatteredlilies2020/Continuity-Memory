import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEndpointPrefill } from '../extension/endpoint-prefill.js';
import { decodeMemoryResponse, memoryRequestMessages, memoryWireRequest, requestPrefill } from '../extension/preset-prefill.js';

const bodyFor = (source = 'custom', model = 'model', prefill = '{"facts":') => ({
    chat_completion_source: source, model, messages: memoryRequestMessages('task', 'system', prefill),
    reverse_proxy: 'https://proxy.example.invalid/v1', proxy_password: 'fake-test-password',
    custom_url: 'https://custom.example.invalid/v1', secret_id: 'fake-reference',
});
const settings = { structured_prefill: 'on', structured_prefill_min_length: 1 };

test('fork endpoint encoders preserve routing and exact JSON prefix literals', () => {
    for (const [source, model, claude] of [['custom', 'model', false], ['openrouter', 'vendor/claude-test', true], ['claude', 'claude-test', true]]) {
        const input = bodyFor(source, model);
        const before = structuredClone(input);
        const { body, metadata } = applyEndpointPrefill(input, settings);
        assert.deepEqual(input, before);
        for (const key of ['reverse_proxy', 'proxy_password', 'custom_url', 'secret_id', 'model']) assert.equal(body[key], input[key]);
        assert.equal(body.messages.at(-1).role, 'user');
        const schema = claude ? body.structured_prefill_schema : body.json_schema.value;
        assert.ok(new RegExp(schema.properties.value.pattern).test('{"facts":[]}'));
        assert.equal(decodeMemoryResponse('{"value":"{\\"facts\\":[]}"}', metadata), '{"facts":[]}');
    }
});

test('Gemini schema uses ordered fields, preserves real newlines and resolves slots', () => {
    for (const source of ['makersuite', 'vertexai']) {
        const { body, metadata } = applyEndpointPrefill(bodyFor(source, 'gemini-test', 'A\n[[opt:B|C]]\n'), settings);
        assert.deepEqual(body.json_schema.value.propertyOrdering, ['p0', 'p1', 'p2', 'p3']);
        assert.deepEqual(body.json_schema.value.properties.p1.enum, ['B', 'C']);
        assert.equal(decodeMemoryResponse(JSON.stringify({ p3: '<NL>end', p1: 'B', p0: 'A\n', p2: '\n' }), metadata), 'A\nB\n<NL>end');
        assert.throws(() => decodeMemoryResponse('{"p0":"A"}', metadata), /Incomplete/);
    }
});

test('fork on/auto/off capability decisions mirror the host without guessing provider support', () => {
    const base = bodyFor('openrouter', 'vendor/claude-test');
    const cases = [
        [{ structured_prefill: 'off' }, {}, false],
        [{ structured_prefill: false }, {}, false],
        [{ structured_prefill: true }, {}, true],
        [{ structured_prefill: 'auto' }, { capabilities: { supports_assistant_prefill: true } }, false],
        [{ structured_prefill: 'on' }, { capabilities: { supports_assistant_prefill: true } }, true],
        [settings, { capabilities: { supports_response_schema: false } }, false],
        [settings, { preferNative: true }, false],
        [{ structured_prefill: 'auto', structured_prefill_auto_providers: { openrouter: false } }, {}, false],
        [{ structured_prefill: 'auto', structured_prefill_auto_disable_for_forced_reasoning: true }, { forcedReasoning: true }, false],
        [{ structured_prefill: 'auto' }, {}, true],
    ];
    for (const [preset, capabilities, expected] of cases) {
        assert.equal(!!applyEndpointPrefill(base, preset, capabilities).metadata.structured, expected);
    }
    for (const source of ['ai21', 'siliconflow', 'cometapi', 'nanogpt']) assert.equal(applyEndpointPrefill(bodyFor(source), settings).metadata.structured, undefined);
});

test('native responses restore partial JSON; structured wrappers never prepend unresolved slot templates', () => {
    const input = bodyFor('custom', 'model', 'Hello [[w:1]]\n');
    const { metadata } = applyEndpointPrefill(input, settings);
    assert.equal(decodeMemoryResponse(JSON.stringify({ value: 'Hello Alice<NL>rest' }), metadata), 'Hello Alice\nrest');
    assert.equal(decodeMemoryResponse('"facts":[]}', { prefill: '{' }), '{"facts":[]}');
    assert.equal(decodeMemoryResponse('{"facts":[]}', { prefill: '{' }), '{"facts":[]}');
    assert.throws(() => decodeMemoryResponse('{}', metadata), /Invalid/);
    const wire = memoryWireRequest({ ...input, continuity_prefill: metadata });
    assert.equal(wire.continuity_prefill, undefined);
    assert.equal(wire.proxy_password, input.proxy_password);
});

const host = readFileSync(new URL('../extension/preset-prefill-host.js', import.meta.url), 'utf8');
function load(name, dependencies) {
    const start = host.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0);
    const end = start + host.slice(start).search(/^\}$/m) + 1;
    return new Function(...Object.keys(dependencies), `${host.slice(start, end).replace(/^export /, '')}; return ${name};`)(...Object.values(dependencies));
}
function prepareWith(modules, preset = settings) {
    return load('prepareMemoryRequest', {
        requestPrefill, applyEndpointPrefill, endpointModules: async () => modules,
        memoryPresetSettings: () => preset, hostOpenAI: { model_list: [] },
    });
}
const modules = [
    { getModelCapabilities: () => ({}) },
    { resolveReasoningCapabilities: () => ({ forcedReasoning: false }) },
    { supportsKimiNativePrefill: () => false },
    { toSdkRequest: body => { body.maxOutputTokens = body.max_tokens; delete body.max_tokens; return body; } },
];

test('upstream staging/release path does not import fork modules or change native messages/routing', async () => {
    const input = bodyFor('claude', 'claude-test');
    const prepared = await prepareWith(null)(input);
    assert.deepEqual(memoryWireRequest(prepared), input);
    assert.equal(prepared.continuity_prefill.prefill, '{"facts":');
    let imported = false;
    const endpointModules = load('endpointModules', { hostOpenAI: {}, get forkModules() { imported = true; return null; } });
    imported = false;
    assert.equal(await endpointModules(), null);
    assert.equal(imported, false);
});

test('fork request adapter handles direct/detached SDK transport without mutating active globals', async () => {
    const input = { ...bodyFor('makersuite', 'gemini-test'), max_tokens: 120 };
    const original = structuredClone(input);
    const prepared = await prepareWith(modules)(input, '__direct__');
    assert.equal(prepared.maxOutputTokens, 120);
    assert.equal(prepared.max_tokens, undefined);
    assert.ok(prepared.json_schema);
    assert.deepEqual(input, original);
    assert.doesNotMatch(host, /hostOpenAI\.consumeStructuredPrefillInfo\(/);
});

test('profile adapter leaves proxy and secret routing with Connection Manager and decodes schema wrappers', async () => {
    let calls = 0;
    const profile = { model: 'vendor/claude-test', preset: 'Memory', proxy: 'Selected proxy', 'secret-id': 'fake-reference' };
    const send = load('sendMemoryProfileRequest', {
        requestPrefill, memoryWireRequest, decodeMemoryResponse,
        prepareMemoryRequest: prepareWith(modules),
        ConnectionManagerRequestService: {
            getProfile: () => profile,
            validateProfile: () => ({ selected: 'openai', source: 'openrouter' }),
            sendRequest: async (id, messages, tokens, options, payload) => {
                calls++;
                assert.equal(id, 'proxy-profile');
                assert.equal(options.includePreset, false);
                assert.equal(messages.at(-1).role, 'user');
                assert.equal(payload.continuity_prefill, undefined);
                assert.equal(payload.reverse_proxy, undefined); // no active-proxy override
                assert.equal(payload.secret_id, undefined);
                assert.ok(payload.structured_prefill_schema);
                return { choices: [{ message: { content: JSON.stringify({ value: '{"facts":[]}' }) } }] };
            },
        },
    });
    const result = await send('proxy-profile', bodyFor().messages, 120, { includePreset: false }, {});
    assert.equal(calls, 1);
    assert.equal(result.choices[0].message.content, '{"facts":[]}');
    assert.equal(result.continuity_prefill_complete, true);
});

test('detached tree prepares all retries and split tasks with per-request metadata', async () => {
    const prepare = prepareWith(modules);
    const recurse = load('prepareDetachedPrefills', { prepareMemoryRequest: prepare });
    const tree = { request: bodyFor(), mandatoryRequest: bodyFor(), parts: [{ request: bodyFor('makersuite') }], fallbackRequest: null };
    const result = await recurse(tree, 'profile');
    assert.ok(result.request.continuity_prefill.structured);
    assert.ok(result.mandatoryRequest.continuity_prefill.structured);
    assert.ok(result.parts[0].request.continuity_prefill.structured.multiField);
    assert.equal(result.fallbackRequest, null);
});

test('active fork prefill uses isolated host routing and never enables its shared decoder', async () => {
    const active = { ...settings, structured_prefill_hide: true, chat_completion_source: 'custom', reverse_proxy: 'https://proxy.example.invalid' };
    const sent = [];
    let dispatches = 0;
    const generate = load('generateEndpointMemory', {
        endpointModules: async () => modules, getContext: () => ({ mainApi: 'openai' }),
        oai_settings: active, memoryRequestMessages, memoryWireRequest, decodeMemoryResponse,
        prepareMemoryRequest: prepareWith(modules, active), getRequestHeaders: () => ({}),
        hostOpenAI: {
            getChatCompletionModel: () => 'model',
            createGenerationParameters: async (settings, model, type, messages) => {
                assert.equal(settings.structured_prefill, 'off');
                assert.equal(settings.function_calling, false);
                assert.equal(type, 'quiet');
                return { generate_data: { model, chat_completion_source: settings.chat_completion_source, reverse_proxy: settings.reverse_proxy, messages } };
            },
        },
        fetch: async (_, { body }) => {
            assert.equal(dispatches, sent.length + 1);
            const request = JSON.parse(body);
            sent.push(request);
            assert.equal(request.continuity_prefill, undefined);
            assert.equal(request.reverse_proxy, active.reverse_proxy);
            assert.equal(request.messages.at(-1).role, 'user');
            const text = JSON.stringify({ value: `${request.messages.at(-1).content}\nrest` });
            return { ok: true, json: async () => ({ text }) };
        },
    });
    const results = await Promise.all(['one', 'two'].map(prompt => generate({ prompt, systemPrompt: 'system', prefill: `${prompt}\n`, onDispatch: () => { dispatches++; } }, body => { body.max_tokens = 150; })));
    assert.deepEqual(results, ['one\nrest', 'two\nrest']);
    assert.equal(sent.length, 2);
    assert.equal(dispatches, 2);
    assert.equal(active.structured_prefill, 'on');
    assert.equal(active.structured_prefill_hide, true);
});

test('text-completion active generation stays on the existing generateRaw path', async () => {
    const generate = load('generateEndpointMemory', {
        getContext: () => ({ mainApi: 'textgenerationwebui' }),
        endpointModules: () => { throw new Error('Must not load chat-only modules'); },
    });
    assert.equal(await generate({ prefill: '{' }, () => {}), null);
});
