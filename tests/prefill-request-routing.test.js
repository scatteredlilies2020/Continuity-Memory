import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestModel } from '../plugin/model-response.js';
import * as prefillPolicy from '../extension/preset-prefill.js';
import * as profilePolicy from '../extension/profile-request-policy.js';

const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
const plugin = readFileSync(new URL('../plugin/detached-jobs.js', import.meta.url), 'utf8');
function functionSource(source, name) {
    const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    const end = start + source.slice(start).search(/^\}$/m) + 1;
    return source.slice(start, end).replace(/^export /, '');
}
function load(source, name, dependencies, extra = '') {
    return new Function(...Object.keys(dependencies), `${extra}\n${functionSource(source, name)}\nreturn ${name};`)(...Object.values(dependencies));
}
function dependencies(overrides = {}) {
    return {
        ...prefillPolicy, ...profilePolicy,
        DIRECT_PROFILE_ID: '__direct__',
        resolveMemoryPrefill: () => '{',
        prepareMemoryRequest: async body => ({ ...body, continuity_prefill: { prefill: prefillPolicy.requestPrefill(body.messages) } }),
        generateEndpointMemory: async () => null,
        applyExtractionRequestSettings: () => {},
        sendMemoryProfileRequest: (...args) => overrides.ConnectionManagerRequestService.sendRequest(...args),
        getSettings: () => ({ thinkingMode: 'off', memoryProfileId: 'test-profile' }),
        resolveThinkingModeForProfile: mode => mode,
        buildThinkingRequest: () => ({ adapter: 'custom', controlled: true, payload: { reasoning_effort: 'none' } }),
        outputTokenPayload: () => ({}),
        resolveMemoryResponseTokens: () => 100,
        shouldSendStructuredSchema: () => true,
        updateRuntime: () => {},
        assertCompletionNotTruncated: () => {},
        extractMessageFromData: response => response,
        isThinkingControlError: error => error.message === 'thinking rejected',
        isMandatoryThinkingError: () => false,
        thinkingControlFallbackPayload: () => ({}),
        directRequestConfig: () => ({ provider: 'custom', model: 'test-model', url: 'https://example.invalid' }),
        getRequestHeaders: () => ({}),
        ...overrides,
    };
}

const disabledPreset = {
    assistant_prefill: 'old stale prefix',
    prompts: [{ identifier: 'chatHistory', marker: true },
        { identifier: 'custom-prefix', role: 'assistant', content: 'disabled prefix' }],
    prompt_order: [{ character_id: 100001, order: [
        { identifier: 'chatHistory', enabled: true }, { identifier: 'custom-prefix', enabled: false },
    ] }],
};

test('direct retrieval reports dispatch after request preparation and before fetch', async () => {
    const steps = [];
    const request = load(engine, 'requestDirectStructured', dependencies({
        prepareMemoryRequest: async body => { steps.push('prepare'); return { ...body, continuity_prefill: { prefill: '' } }; },
        fetch: async () => { steps.push('fetch'); return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'answer' } }] }) }; },
    }));
    await request('query', 'system', null, 300, 'retrieval', false, 'off', undefined, '', () => steps.push('dispatch'));
    assert.deepEqual(steps, ['prepare', 'dispatch', 'fetch']);
});

test('active generation forwards prefill through thinking retries and restores partial JSON', async () => {
    const calls = [];
    const fn = load(engine, 'generateWithThinkingPolicy', dependencies({
        generateRaw: async options => {
            calls.push(options);
            if (calls.length === 1) throw new Error('thinking rejected');
            return '"result":true}';
        },
        console: { warn() {} },
    }), 'let activeExtractionThinkingMode = null;');
    assert.equal(await fn({ prompt: 'task', systemPrompt: 'system', jsonSchema: { value: {} } }), '{"result":true}');
    assert.equal(calls.length, 2);
    for (const options of calls) {
        assert.equal(options.prefill, '{');
        assert.equal(options.jsonSchema, null);
    }
});

test('named profiles keep prefills and task isolation across thinking retries', async () => {
    const calls = [];
    const deps = dependencies({
        ConnectionManagerRequestService: {
            getProfile: () => ({ name: 'Profile', model: 'test-model', preset: 'Memory preset' }),
            validateProfile: () => ({ source: 'custom', selected: 'openai' }),
            sendRequest: async (...args) => {
                calls.push(args);
                if (calls.length === 1) throw new Error('thinking rejected');
                return '"result":true}';
            },
        },
    });
    const fn = load(engine, 'requestStructured', deps, functionSource(engine, 'extractProfileResponse'));
    assert.equal(await fn('task', 'system', { value: {} }, 100, 'test-profile', 'extraction', 'plain task'), '{"result":true}');
    assert.equal(calls.length, 2);
    for (const [, messages, , options, payload] of calls) {
        assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'assistant']);
        assert.equal(messages[1].content, 'plain task');
        assert.equal(messages.at(-1).content, '{');
        assert.equal(options.includePreset, false);
        assert.equal(options.includeInstruct, false);
        assert.equal(payload.json_schema, undefined);
    }
});

test('Direct requests append active-preset prefill without a conflicting schema', async () => {
    let body;
    const fn = load(engine, 'requestDirectStructured', dependencies({
        fetch: async (_, options) => {
            body = JSON.parse(options.body);
            return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '"result":true}' } }] }) };
        },
    }));
    assert.equal(await fn('task', 'system', { value: {} }, 100, 'extraction'), '{"result":true}');
    assert.equal(body.messages.at(-1).content, '{');
    assert.equal(body.json_schema, undefined);
});

test('detached request variants all retain prefill and disable native schema', () => {
    const fn = load(engine, 'detachedRequestBodies', dependencies({
        resolveMemoryPrefill: (_, options) => { assert.equal(options.summary, true); return '{'; },
        extractionJsonSchema: {}, extractionResponseTokens: () => 100, memoryResponseTokens: () => 100,
        mandatoryThinkingPayload: () => ({ reasoning_effort: 'low' }),
    }));
    const bundle = fn({ prompt: 'task', fallbackPrompt: 'plain task', systemPrompt: 'system', usesStructuredSchema: true }, { profileId: '__direct__' });
    for (const request of Object.values(bundle).filter(value => value?.messages)) {
        assert.equal(request.messages.at(-1).content, '{');
        assert.equal(request.json_schema, undefined);
    }
    assert.ok(bundle.request);
    assert.ok(bundle.mandatoryRequest);
    assert.ok(bundle.uncontrolledRequest);
});

test('detached backend restores the assistant prefix before parsing', async () => {
    const fn = load(plugin, 'backendRequestOnce', {
        ...prefillPolicy, AbortController, setTimeout, clearTimeout, requestModel,
        assertNotTruncated: () => {}, completionText: payload => payload.choices[0].message.content,
    });
    const job = {
        controller: new AbortController(), requestTimeoutMs: 1000,
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '"result":true}' } }] })),
    };
    assert.equal(await fn(job, { messages: prefillPolicy.memoryRequestMessages('task', 'system', '{') }), '{"result":true}');
});

test('requests without prefill preserve schema behavior', async () => {
    const schema = { value: {} };
    let sent;
    const fn = load(engine, 'generateWithThinkingPolicy', dependencies({
        resolveMemoryPrefill: () => '', generateRaw: async options => { sent = options; return '{"result":true}'; },
    }), 'let activeExtractionThinkingMode = null;');
    assert.equal(await fn({ prompt: 'task', jsonSchema: schema }), '{"result":true}');
    assert.equal(sent.jsonSchema, schema);
    assert.equal(sent.prefill, '');
});

test('host resolver chooses saved profile presets, active edits, and Direct active defaults', () => {
    const source = readFileSync(new URL('../extension/preset-prefill-host.js', import.meta.url), 'utf8');
    const settings = { summaryPrefillEnabled: true, summaryPrefill: 'custom {{char}}: ' };
    const fn = load(source, 'resolveMemoryPrefill', {
        ...prefillPolicy,
        getSettings: () => settings,
        oai_settings: { preset_settings_openai: 'Current', assistant_prefill: 'active {{char}}' },
        openai_setting_names: { Other: 0, Current: 1 },
        openai_settings: [{ assistant_prefill: 'saved {{char}}' }, { assistant_prefill: 'stale' }],
        promptManager: null,
        ConnectionManagerRequestService: { getProfile: id => ({ preset: id }) },
        getContext: () => ({ characterId: 42 }),
        substituteParams: text => text.replace('{{char}}', 'Alice'),
    });
    assert.equal(fn('Other'), 'saved Alice');
    assert.equal(fn('Current'), 'active Alice');
    assert.equal(fn('__direct__'), 'active Alice');
    assert.equal(fn(), 'active Alice');
    assert.equal(fn('Missing'), '');
    for (const profile of ['Other', 'Current', '__direct__', '', 'Missing']) {
        assert.equal(fn(profile, { summary: true }), 'custom Alice: ');
    }
    assert.equal(fn('Other', { summary: true, expandMacros: false }), 'custom {{char}}: ');
    settings.summaryPrefillEnabled = false;
    assert.equal(fn('Other', { summary: true }), 'saved Alice');
    settings.summaryPrefillEnabled = true;
    settings.summaryPrefill = '   ';
    assert.equal(fn('Other', { summary: true }), 'saved Alice');
});

test('correction review honors disabled preset prefills across active, Direct, and saved profiles', async () => {
    const host = readFileSync(new URL('../extension/preset-prefill-host.js', import.meta.url), 'utf8');
    for (const profileId of ['', '__direct__', 'saved-profile']) {
        const data = {
            assistant_prefill: 'old stale {{char}} prefix',
            prompts: [{ identifier: 'chatHistory', marker: true },
                { identifier: 'custom-prefix', role: 'assistant', content: 'disabled {{char}} prefix' }],
            prompt_order: [{ character_id: 100001, order: [
                { identifier: 'chatHistory', enabled: true }, { identifier: 'custom-prefix', enabled: false },
            ] }],
        };
        // Live Prompt Manager toggles can differ from the stored preset order.
        const activeData = structuredClone(data);
        activeData.prompt_order[0].order[1].enabled = true;
        const settings = { memoryProfileId: profileId, correctionProfileId: '', thinkingMode: 'off' };
        const profile = { preset: 'Saved', model: 'test-model', name: 'Memory' };
        const schema = { name: 'continuity_memory_correction', value: { type: 'object' } };
        const result = { operations: [] };
        let requests = 0;
        const resolveMemoryPrefill = load(host, 'resolveMemoryPrefill', {
            ...prefillPolicy, getSettings: () => settings,
            oai_settings: { ...activeData, preset_settings_openai: 'Active' },
            openai_setting_names: { Saved: 0 }, openai_settings: [data],
            promptManager: { activeCharacter: { id: 100001 }, getPromptOrderForCharacter: () => data.prompt_order[0].order },
            getContext: () => ({ characterId: 42 }),
            ConnectionManagerRequestService: { getProfile: () => profile },
            substituteParams: () => { assert.fail('Disabled prefills must not expand macros'); },
        });
        const deps = dependencies({
            getSettings: () => settings, resolveMemoryPrefill,
            generateRaw: async options => {
                requests++;
                assert.equal(options.prefill, '');
                assert.equal(options.jsonSchema, schema);
                return JSON.stringify(result);
            },
            fetch: async (_, options) => {
                requests++;
                const body = JSON.parse(options.body);
                assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
                assert.deepEqual(body.json_schema, schema);
                return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) };
            },
            ConnectionManagerRequestService: {
                getProfile: () => profile,
                validateProfile: () => ({ source: 'custom', selected: 'openai' }),
                sendRequest: async (_, messages, maxTokens, options, payload) => {
                    requests++;
                    assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
                    assert.equal(payload.json_schema, schema);
                    assert.equal(options.includePreset, false);
                    return JSON.stringify(result);
                },
            },
        });
        deps.generateWithThinkingPolicy = load(engine, 'generateWithThinkingPolicy', deps, 'let activeExtractionThinkingMode = null;');
        deps.requestDirectStructured = load(engine, 'requestDirectStructured', deps);
        const requestStructured = load(engine, 'requestStructured', deps, functionSource(engine, 'extractProfileResponse'));
        const world = { id: 'world', revision: 1 };
        const review = load(engine, 'reviewMemoryCorrection', {
            requestStructured, getSettings: () => settings, DIRECT_PROFILE_ID: '__direct__',
            runtime: { world, health: { schemaVersion: 7 }, generation: 0, paused: true },
            getBoundWorldId: () => world.id, getChatKey: () => 'chat', getContext: () => ({ chat: [] }),
            selectCorrectionContext: () => [{ id: 'fact:one', subject: 'Alice' }],
            resolveCorrectionResponseTokens: () => 8000,
            updateRuntime: () => {}, CORRECTION_SYSTEM_PROMPT: 'Repair memory. Return JSON only.',
            correctionJsonSchema: schema, parseJsonResponse: JSON.parse,
            validateCorrectionProposal: (_, parsed) => parsed, augmentCorrectionChronology: (_, proposal) => proposal,
        });
        const proposal = await review('Alice never visited the castle.');
        assert.equal(requests, 1, `${profileId || 'active'} sends one correction request`);
        assert.deepEqual(proposal.operations, []);
    }
});

test('Digest and Chronicle requests keep disabled preset prefills off through schema fallback', async () => {
    for (const profileId of ['', '__direct__', 'saved-profile']) {
        for (const category of ['digest', 'chronicle']) {
            const schema = { name: category, value: { type: 'object' } };
            let requests = 0;
            const reply = () => {
                if (++requests === 1) throw new Error('schema rejected');
                return '{"result":true}';
            };
            const checkMessages = messages => assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
            const deps = dependencies({
                resolveMemoryPrefill: () => prefillPolicy.presetPrefill(disabledPreset),
                shouldRetryWithoutSchema: error => error.message === 'schema rejected',
                rootErrorMessage: error => error.message,
                console: { warn() {} },
                generateRaw: async options => {
                    assert.equal(options.prefill, '');
                    assert.equal(options.jsonSchema, requests ? undefined : schema);
                    return reply();
                },
                fetch: async (_, options) => {
                    const body = JSON.parse(options.body);
                    checkMessages(body.messages);
                    assert.deepEqual(body.json_schema, requests ? undefined : schema);
                    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: reply() } }] }) };
                },
                ConnectionManagerRequestService: {
                    getProfile: () => ({ name: 'Memory', model: 'test-model' }),
                    validateProfile: () => ({ source: 'custom', selected: 'openai' }),
                    sendRequest: async (_, messages, maxTokens, options, payload) => {
                        checkMessages(messages);
                        assert.equal(payload.json_schema, requests ? undefined : schema);
                        return reply();
                    },
                },
            });
            deps.generateWithThinkingPolicy = load(engine, 'generateWithThinkingPolicy', deps, 'let activeExtractionThinkingMode = null;');
            deps.requestDirectStructured = load(engine, 'requestDirectStructured', deps);
            const request = load(engine, 'requestStructured', deps, functionSource(engine, 'extractProfileResponse'));
            assert.equal(await request('task', 'system', schema, 100, profileId,
                category === 'digest' ? 'extraction' : 'summary', 'plain task', 'off', true), '{"result":true}');
            assert.equal(requests, 2, `${profileId || 'active'} ${category} retries without reviving the prefill`);
        }
    }
});

test('detached Digest and Chronicle variants honor disabled preset prefills', () => {
    const fn = load(engine, 'detachedRequestBodies', dependencies({
        resolveMemoryPrefill: () => prefillPolicy.presetPrefill(disabledPreset),
        extractionJsonSchema: {}, extractionResponseTokens: () => 100, memoryResponseTokens: () => 100,
        mandatoryThinkingPayload: () => ({ reasoning_effort: 'low' }),
        proxies: [],
        ConnectionManagerRequestService: {
            getProfile: () => ({ name: 'Memory', model: 'test-model' }),
            validateProfile: () => ({ source: 'custom', selected: 'openai' }),
        },
    }));
    for (const profileId of ['__direct__', 'saved-profile']) {
        for (const layer of ['digest', 'chronicle']) {
            const schema = { name: layer, value: { type: 'object' } };
            const bundle = fn({ prompt: 'task', fallbackPrompt: 'plain task', systemPrompt: 'system', usesStructuredSchema: true },
                { profileId, layer, jsonSchema: schema });
            assert.deepEqual(bundle.request.json_schema, schema);
            for (const variant of Object.values(bundle).filter(value => value?.messages)) {
                assert.deepEqual(variant.messages.map(message => message.role), ['system', 'user']);
            }
        }
    }
});

test('summary override is routed explicitly across active, Direct, and profile requests', async () => {
    for (const profileId of ['', '__direct__', 'profile']) {
        for (const summary of [true, false]) {
            const expected = summary ? 'custom' : 'preset';
            const fn = load(engine, 'requestStructured', dependencies({
                resolveMemoryPrefill: (_, options) => options.summary ? 'custom' : 'preset',
                generateWithThinkingPolicy: async options => {
                    assert.equal(options.prefill, expected);
                    return 'response';
                },
                requestDirectStructured: async (...args) => {
                    assert.equal(args[8], expected);
                    return 'response';
                },
                ConnectionManagerRequestService: {
                    getProfile: () => ({ name: 'Profile', model: 'test-model' }),
                    validateProfile: () => ({ source: 'custom', selected: 'openai' }),
                    sendRequest: async (_, messages) => {
                        assert.equal(messages.at(-1).role, 'assistant');
                        assert.equal(messages.at(-1).content, expected);
                        assert.equal(messages.filter(message => message.role === 'assistant').length, 1);
                        return 'response';
                    },
                },
            }), functionSource(engine, 'extractProfileResponse'));
            await fn('task', 'system', {}, 100, profileId, 'extraction', 'plain task', 'off', summary);
        }
    }
});

test('Digest and Chronicle opt in to summary overrides, correction does not', async () => {
    let args;
    const fn = load(engine, 'requestExtraction', {
        withRuntimeConnection: operation => operation(), extractionJsonSchema: {}, requestStructured: (...values) => { args = values; },
    });
    await fn('task', 'system', 'fallback', 100);
    assert.equal(args[8], true);
    assert.match(functionSource(engine, 'generateChroniclePromotion'), /requestStructured\([^;]+thinkingMode, true\)/);
    assert.doesNotMatch(functionSource(engine, 'reviewMemoryCorrection'), /requestStructured\([^;]+true\s*\)/);
});
