import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const url = new URL('../extension/semantic-retrieval.js', import.meta.url);
let sequence = 0;
async function load(settings, calls, overrides = {}) {
    const key = `__cmAiTest${sequence++}`;
    globalThis[key] = {
        settings,
        extractMessageFromData: response => response,
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
    await module.expandRetrievalTerms(messages, { signal });
    assert.equal(calls[0][4], 'retrieval');
    assert.equal(calls[0][6].signal, signal);
});

test('AI connection profiles receive isolated requests and the caller abort signal', async () => {
    const calls = [];
    const module = await load({ retrievalProfileId: 'retrieval-profile' }, calls);
    const signal = new AbortController().signal;
    await module.expandRetrievalTerms(messages, { signal });
    assert.equal(calls[0][0], 'profile');
    assert.equal(calls[0][1], 'retrieval-profile');
    assert.equal(calls[0][4].signal, signal);
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
