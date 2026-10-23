import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { presetPrefill } from '../extension/preset-prefill.js';
const url = new URL('../extension/semantic-retrieval.js', import.meta.url);
let sequence = 0;
async function load(settings, calls, overrides = {}) {
    const key = `__cmAiTest${sequence++}`;
    globalThis[key] = {
        settings,
        extractMessageFromData: response => response,
        resolveMemoryPrefill: () => '',
        ConnectionManagerRequestService: {
            getProfile: () => ({ model: 'sample-model', name: 'AI test', 'api-url': 'http://example.invalid' }),
            validateProfile: () => ({ source: 'custom', selected: 'custom' }),
            sendRequest: async (...args) => { calls.push(['profile', ...args]); return '{"terms":["rail clamp repairs"]}'; },
        },
        generateWithThinkingPolicy: async (...args) => { calls.push(['active', ...args]); return '{"terms":["rail clamp repairs"]}'; },
        requestDirectText: async (...args) => { calls.push(['direct', ...args]); return '{"terms":["rail clamp repairs"]}'; },
        resolveThinkingModeForProfile: () => 'off',
        ...overrides,
    };
    const source = readFileSync(url, 'utf8')
        .replace("import { extractMessageFromData } from '/script.js';", `const { extractMessageFromData } = globalThis.${key};`)
        .replace("import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';", `const { ConnectionManagerRequestService } = globalThis.${key};`)
        .replace(/import \{ resolveMemoryPrefill, sendMemoryProfileRequest \} from '[^']+';/, `const { resolveMemoryPrefill } = globalThis.${key}; const sendMemoryProfileRequest = (...args) => ConnectionManagerRequestService.sendRequest(...args);`)
        .replace(/import \{ generateWithThinkingPolicy, requestDirectText, resolveThinkingModeForProfile \} from '[^']+';/,
            `const { generateWithThinkingPolicy, requestDirectText, resolveThinkingModeForProfile } = globalThis.${key};`)
        .replace(/import \{ getSettings \} from '[^']+';/, `const settings = globalThis.${key}.settings; const getSettings = () => settings;`)
        .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
    try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`); }
    finally { delete globalThis[key]; }
}
const messages = [{ is_user: true, mes: 'What about those repairs?' }];

test('AI retrieval inherits the extraction direct provider when no separate model is selected', async () => {
    const calls = [];
    const settings = { memoryProfileId: '__direct__', retrievalProfileId: '', extractionDirectModel: 'first' };
    const module = await load(settings, calls);
    const signal = new AbortController().signal;
    assert.deepEqual(await module.expandRetrievalTerms(messages, { signal }), ['rail clamp repairs']);
    assert.equal(calls[0][0], 'direct');
    assert.equal(calls[0][4], 'extraction');
    assert.equal(calls[0][6].signal, signal);
    await module.expandRetrievalTerms(messages);
    assert.equal(calls.length, 1, 'identical configuration should use cache');
    settings.extractionDirectModel = 'second';
    await module.expandRetrievalTerms(messages);
    assert.equal(calls.length, 2, 'inherited model changes invalidate cached expansion');
    settings.retrievalQueryTemplate = 'Find related terms: {{conversation}}';
    await module.expandRetrievalTerms(messages);
    assert.equal(calls.length, 3, 'template changes invalidate cached expansion');
});

test('a separate AI direct model uses retrieval routing and forwards cancellation', async () => {
    const calls = [];
    const module = await load({ memoryProfileId: 'other', retrievalProfileId: '__direct__' }, calls);
    const signal = new AbortController().signal;
    const onDispatch = () => {};
    await module.expandRetrievalTerms(messages, { signal, onDispatch });
    assert.equal(calls[0][4], 'retrieval');
    assert.equal(calls[0][6].signal, signal);
    assert.equal(calls[0][6].onDispatch, onDispatch);
});

test('AI connection profiles receive isolated requests and the caller abort signal', async () => {
    const calls = [];
    const module = await load({ retrievalProfileId: 'retrieval-profile' }, calls);
    const signal = new AbortController().signal;
    const onDispatch = () => {};
    await module.expandRetrievalTerms(messages, { signal, onDispatch });
    assert.equal(calls[0][0], 'profile');
    assert.equal(calls[0][1], 'retrieval-profile');
    assert.equal(calls[0][4].signal, signal);
    assert.equal(calls[0][4].onDispatch, onDispatch);
    assert.equal(calls[0][4].includePreset, false);
    assert.equal(calls[0][4].includeInstruct, false);
});

test('an uncancellable host response after timeout is rejected and never cached', async () => {
    let finish;
    const calls = [];
    const module = await load({ memoryProfileId: '__direct__' }, calls, {
        requestDirectText: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); },
    });
    const controller = new AbortController();
    const pending = module.expandRetrievalTerms(messages, { signal: controller.signal });
    controller.abort(new Error('test cancellation'));
    finish('{"terms":["stale terms"]}');
    await assert.rejects(pending, /test cancellation/);
    const next = module.expandRetrievalTerms(messages);
    finish('{"terms":["fresh terms"]}');
    assert.deepEqual(await next, ['fresh terms']);
    assert.equal(calls.length, 2);
});

test('AI retrieval appends preset prefill and invalidates cached terms when it changes', async () => {
    const calls = [];
    let prefill = '{';
    const module = await load({ retrievalProfileId: 'retrieval-profile' }, calls, {
        resolveMemoryPrefill: () => prefill,
    });
    await module.expandRetrievalTerms(messages);
    assert.deepEqual(calls[0][2].at(-1), { role: 'assistant', content: '{' });
    await module.expandRetrievalTerms(messages);
    assert.equal(calls.length, 1);
    prefill = '{"terms":';
    await module.expandRetrievalTerms(messages);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][2].at(-1).content, prefill);
});

test('AI retrieval honors a disabled preset prefill even when legacy text remains', async () => {
    const calls = [];
    const data = {
        assistant_prefill: 'old stale prefix',
        prompts: [{ identifier: 'chatHistory', marker: true },
            { identifier: 'custom-prefix', role: 'assistant', content: '{' }],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true }, { identifier: 'custom-prefix', enabled: false },
        ] }],
    };
    const module = await load({ retrievalProfileId: 'retrieval-profile' }, calls, {
        resolveMemoryPrefill: () => presetPrefill(data),
    });
    assert.deepEqual(await module.expandRetrievalTerms(messages), ['rail clamp repairs']);
    assert.deepEqual(calls[0][2].map(message => message.role), ['system', 'user']);
    data.prompt_order[0].order[1].enabled = true;
    await module.expandRetrievalTerms(messages);
    assert.equal(calls.length, 2, 'enabling a prefill invalidates the no-prefill search cache');
    assert.deepEqual(calls[1][2].at(-1), { role: 'assistant', content: '{' });
});

test('AI retrieval using the active provider forwards its independent cancellation signal', async () => {
    const calls = [];
    const module = await load({}, calls);
    const signal = new AbortController().signal;
    const onDispatch = () => {};
    await module.expandRetrievalTerms(messages, { signal, onDispatch });
    assert.equal(calls[0][0], 'active');
    assert.equal(calls[0][1].signal, signal);
    assert.equal(calls[0][1].onDispatch, onDispatch);
});

test('a new reply never joins an aborted preview that has not settled', async () => {
    const pending = [];
    const module = await load({ memoryProfileId: '__direct__' }, [], {
        requestDirectText: () => new Promise(resolve => pending.push(resolve)),
    });
    const previewController = new AbortController();
    const preview = module.expandRetrievalTerms(messages, { signal: previewController.signal });
    const rejected = assert.rejects(preview, /preview cancelled/);
    previewController.abort(new Error('preview cancelled'));
    const reply = module.expandRetrievalTerms(messages, { signal: new AbortController().signal });
    assert.equal(pending.length, 2);
    pending[1]('{"terms":["current terms"]}');
    assert.deepEqual(await reply, ['current terms']);
    pending[0]('{"terms":["old terms"]}');
    await rejected;
    assert.deepEqual(await module.expandRetrievalTerms(messages), ['current terms']);
});

test('AI responses arriving after a delayed timer are rejected and never cached', async t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    let count = 0;
    const module = await load({ memoryProfileId: '__direct__' }, [], {
        requestDirectText: async () => { now = 200; count++; return '{"terms":["current terms"]}'; },
    });
    await assert.rejects(module.expandRetrievalTerms(messages, { deadline: 100 }), { name: 'TimeoutError' });
    assert.deepEqual(await module.expandRetrievalTerms(messages), ['current terms']);
    assert.equal(count, 2);
});

test('malformed AI terms rerun once with brief JSON guidance and cache only the valid result', async () => {
    const calls = [];
    const signal = new AbortController().signal;
    const onDispatch = () => {};
    const module = await load({ memoryProfileId: '__direct__' }, [], {
        requestDirectText: async (...args) => {
            calls.push(args);
            return calls.length === 1 ? 'PRIVATE_SENTINEL narrative' : 'Final answer:\n```json\n{"terms":["rail clamps"]}\n```';
        },
    });
    assert.deepEqual(await module.expandRetrievalTerms(messages, { signal, onDispatch }), ['rail clamps']);
    assert.equal(calls.length, 2);
    assert.match(calls[1][0], /previous response was not valid search-term JSON/);
    assert.doesNotMatch(calls[1][0], /PRIVATE_SENTINEL/);
    assert.ok(calls[1][0].length - calls[0][0].length < 200, 'Correction guidance stays brief.');
    for (const call of calls) {
        assert.equal(call[5].signal, signal);
        assert.equal(call[5].onDispatch, onDispatch);
    }
    assert.deepEqual(await module.expandRetrievalTerms(messages), ['rail clamps']);
    assert.equal(calls.length, 2);
});

test('malformed AI output stops after one rerun and never enters the cache', async () => {
    let calls = 0;
    const module = await load({ memoryProfileId: '__direct__' }, [], {
        requestDirectText: async () => { calls++; return 'PRIVATE_SENTINEL'; },
    });
    await assert.rejects(module.expandRetrievalTerms(messages), { code: 'CONTINUITY_INVALID_RETRIEVAL_OUTPUT' });
    assert.equal(calls, 2);
    await assert.rejects(module.expandRetrievalTerms(messages), { code: 'CONTINUITY_INVALID_RETRIEVAL_OUTPUT' });
    assert.equal(calls, 4);
});

test('AI format recovery does not retry transport/authentication errors', async () => {
    for (const message of ['401 Unauthorized', '503 temporarily unavailable', 'JSON.parse: invalid API envelope']) {
        let calls = 0;
        const error = new Error(message);
        const module = await load({ memoryProfileId: '__direct__' }, [], {
            requestDirectText: async () => { calls++; throw error; },
        });
        await assert.rejects(module.expandRetrievalTerms(messages), value => value === error);
        assert.equal(calls, 1);
    }
});

test('a format rerun cannot extend the original retrieval deadline or cache a late answer', async t => {
    let now = 0, calls = 0;
    t.mock.method(Date, 'now', () => now);
    const module = await load({ memoryProfileId: '__direct__' }, [], {
        requestDirectText: async () => {
            calls++;
            if (calls === 1) { now = 20; return 'not JSON'; }
            now = 200;
            return '```json\n{"terms":["rail clamps"]}\n```';
        },
    });
    await assert.rejects(module.expandRetrievalTerms(messages, { deadline: () => 100 }), { name: 'TimeoutError' });
    assert.equal(calls, 2);
    assert.deepEqual(await module.expandRetrievalTerms(messages), ['rail clamps']);
    assert.equal(calls, 3);
});

test('cancelling during AI format recovery rejects the rerun and does not cache its answer', async () => {
    let calls = 0, finish;
    const controller = new AbortController();
    let dispatched;
    const ready = new Promise(resolve => { dispatched = resolve; });
    const module = await load({ memoryProfileId: '__direct__' }, [], {
        requestDirectText: async () => {
            if (++calls === 1) return 'not JSON';
            dispatched();
            return new Promise(resolve => { finish = resolve; });
        },
    });
    const pending = module.expandRetrievalTerms(messages, { signal: controller.signal });
    await ready;
    controller.abort(new DOMException('Stopped during format rerun', 'AbortError'));
    finish('```json\n{"terms":["stale terms"]}\n```');
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls, 2);
    const next = module.expandRetrievalTerms(messages);
    finish('{"terms":["fresh terms"]}');
    assert.deepEqual(await next, ['fresh terms']);
    assert.equal(calls, 3);
});
