import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fingerprintMessage } from '../extension/message-digest.js';
import { EXTRACTION_VERSION } from '../extension/coverage.js';
import { mapContextMessages } from '../extension/context-message-map.js';
import { canReduceContext } from '../extension/reduction-policy.js';
import { tailPolicy } from '../extension/tail-policy.js';

const source = readFileSync(new URL('../extension/context-reducer.js', import.meta.url), 'utf8')
    .replace(/^import .*\n/gmu, '').replace(/^export /gmu, '');

function fixture({ loaded = true, changed = false } = {}) {
    const chat = Array.from({ length: 12 }, (_, index) => ({ name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0, mes: `Message ${index}` }));
    const processedMessages = chat.map((message, index) => ({ index, version: EXTRACTION_VERSION,
        fingerprint: fingerprintMessage({ index, name: message.name, text: message.mes }) }));
    if (changed) chat[0].mes = 'Edited source must stay raw.';
    const world = { id: 'world-a', sources: { 'chat-a': { processedMessages } } };
    let requests = 0;
    const context = {
        getTokenCountAsync: () => { requests++; return new Promise(() => {}); },
        loadBoundWorld: () => { requests++; return new Promise(() => {}); },
        getContext: () => ({ chat, maxContext: 60000 }),
        getSettings: () => ({ enabled: true, contextReductionEnabled: true, rawTailMode: 'turns', rawTailValue: 2 }),
        getBoundWorldId: () => 'world-a', getChatKey: () => 'chat-a',
        runtime: { world: loaded ? world : null }, updateRuntime: () => {},
        fingerprintMessage, EXTRACTION_VERSION, mapContextMessages, canReduceContext, tailPolicy,
        promptManager: {}, TextEncoder, console,
    };
    vm.runInNewContext(source, context);
    return { context, chat, requests: () => requests };
}

test('cached reduction never requests token counts, including an uncached newest message', async () => {
    const { context, chat, requests } = fixture();
    const core = chat.map((message, index) => ({ ...message, index }));
    await context.reduceChatContext(core, 60000, null, 'normal', { cachedOnly: true });
    assert.equal(requests(), 0);
    assert.deepEqual(core.map(message => message.index), [8, 9, 10, 11]);
});

test('cached reduction preserves edited source and the protected recent tail', async () => {
    const { context, chat, requests } = fixture({ changed: true });
    const core = chat.map((message, index) => ({ ...message, index }));
    await context.reduceChatContext(core, 60000, null, 'normal', { cachedOnly: true });
    assert.equal(requests(), 0);
    assert.deepEqual(core.map(message => message.index), [0, 8, 9, 10, 11]);
});

test('a cold memory binding leaves all history intact without loading storage', async () => {
    const { context, chat, requests } = fixture({ loaded: false });
    const core = chat.map((message, index) => ({ ...message, index }));
    await context.reduceChatContext(core, 60000, null, 'normal', { cachedOnly: true });
    assert.equal(requests(), 0);
    assert.equal(core.length, chat.length);
});
