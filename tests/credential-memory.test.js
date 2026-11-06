import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCredentialMemory, directCredentialContext, embeddingCredentialContext } from '../extension/credential-memory.js';

const keys = { CUSTOM: 'custom', OPENROUTER: 'openrouter', VLLM: 'vllm' };
const custom = directCredentialContext({}, 'extraction', keys);
const router = directCredentialContext({ extractionDirectProvider: 'openrouter' }, 'extraction', keys);
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('credential references are separate for every category and provider', () => {
    const names = new Set();
    for (const kind of ['extraction', 'retrieval', 'correction', 'summary']) {
        for (const provider of ['custom', 'openrouter']) {
            const context = directCredentialContext({ [`${kind}DirectProvider`]: provider }, kind, keys);
            assert.equal(context.slot, keys[provider === 'openrouter' ? 'OPENROUTER' : 'CUSTOM']);
            names.add(context.setting);
        }
    }
    for (const provider of ['proxy', 'openrouter']) {
        const context = embeddingCredentialContext({ embeddingProvider: provider }, keys);
        assert.equal(context.slot, keys[provider === 'openrouter' ? 'OPENROUTER' : 'VLLM']);
        names.add(context.setting);
    }
    assert.equal(names.size, 10);
});

test('switching providers saves each draft to its own slot and persists only references', async () => {
    const writes = [], refs = {};
    const memory = createCredentialMemory({
        write: async (slot, value) => { writes.push([slot, value]); return `id-${slot}`; },
        remember: (setting, id) => { refs[setting] = id; },
    });
    memory.set(custom, ' custom-password ');
    assert.equal(memory.get(router), '');
    memory.set(router, 'router-key');
    await Promise.all([memory.save(custom), memory.save(router)]);
    assert.deepEqual(writes, [['custom', 'custom-password'], ['openrouter', 'router-key']]);
    assert.deepEqual(refs, { extractionDirectSecretId: 'id-custom', extractionOpenRouterSecretId: 'id-openrouter' });
    assert.equal(memory.get(custom), '');
    assert.equal(memory.get(router), '');
    assert.equal(await memory.save(custom), false, 'blank keeps the existing secret');
    assert.equal(writes.length, 2);
});

test('duplicate saves share the same in-flight write', async () => {
    const wait = deferred();
    let count = 0;
    const memory = createCredentialMemory({ write: () => { count++; return wait.promise; }, remember: () => {} });
    memory.set(custom, 'password');
    const first = memory.save(custom), second = memory.save(custom);
    wait.resolve('secret-id');
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(count, 1);
});

test('a newer draft is not erased by an older save and the latest reference wins', async () => {
    const wait = deferred(), writes = [], refs = [];
    const memory = createCredentialMemory({
        write: async (_, value) => { writes.push(value); return value === 'old' ? wait.promise : 'new-id'; },
        remember: (_, id) => refs.push(id),
    });
    memory.set(custom, 'old');
    const first = memory.save(custom);
    memory.set(custom, 'new');
    const second = memory.save(custom);
    wait.resolve('old-id');
    await Promise.all([first, second]);
    assert.deepEqual(writes, ['old', 'new']);
    assert.deepEqual(refs, ['old-id', 'new-id']);
    assert.equal(memory.get(custom), '');
});

for (const failure of ['empty-id', 'rejected-write', 'rejected-reference']) {
    test(`${failure} retains the draft for retry without persisting a password`, async () => {
        let fail = true;
        const refs = [];
        const memory = createCredentialMemory({
            write: async () => {
                if (fail && failure === 'rejected-write') throw new Error('Unavailable');
                return fail && failure === 'empty-id' ? null : 'secret-id';
            },
            remember: (setting, id) => {
                if (fail && failure === 'rejected-reference') throw new Error('Unavailable');
                refs.push([setting, id]);
            },
        });
        memory.set(custom, 'password');
        await assert.rejects(memory.save(custom));
        assert.equal(memory.get(custom), 'password');
        assert.deepEqual(refs, []);
        fail = false;
        await memory.save(custom);
        assert.deepEqual(refs, [['extractionDirectSecretId', 'secret-id']]);
    });
}

test('real UI binding saves on blur and switches isolate drafts without losing failed saves', async () => {
    const source = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const helpers = source.slice(source.indexOf('const credentialContexts ='), source.indexOf('function directSecretSaved('));
    const handlers = {}, input = { value: '' }, refs = {}, writes = [];
    let fail = true;
    const settings = {};
    const $ = () => ({ on(event, fn) { handlers[event] = fn; return this; } });
    const ui = new Function('createCredentialMemory', 'writeSecret', 'getSettings', 'saveSettings', 'document', '$', 'renderRuntime', 'toast', `${helpers}\nreturn {renderCredentialInput,bindCredentialInput,rememberTextInput};`)(
        createCredentialMemory,
        async (slot, value) => { writes.push([slot, value]); if (fail) throw new Error('Unavailable'); return `id-${slot}`; },
        () => settings, () => Object.assign(refs, settings), { querySelector: () => input }, $, () => {}, () => {},
    );
    ui.renderCredentialInput('#key', custom);
    ui.bindCredentialInput('#key');
    input.value = 'custom-password';
    handlers.input.call(input);
    handlers.change.call(input);
    await new Promise(setImmediate);
    ui.renderCredentialInput('#key', router);
    assert.equal(input.value, '', 'never show the Custom password in the OpenRouter field');
    await new Promise(setImmediate);
    ui.renderCredentialInput('#key', custom);
    assert.equal(input.value, 'custom-password', 'a failed save restores the correct provider draft');
    fail = false;
    handlers.change.call(input);
    await new Promise(setImmediate);
    ui.renderCredentialInput('#key', custom);
    assert.equal(input.value, '');
    assert.deepEqual(refs, { extractionDirectSecretId: 'id-custom' });
    ui.rememberTextInput('#url', 'extractionDirectUrl');
    input.value = 'https://example.test/v1';
    handlers.input.call(input);
    assert.equal(settings.extractionDirectUrl, input.value, 'URL is persisted before blur');
});
