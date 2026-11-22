import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createChronicleTokenMeter, formatChronicleTokenStatus } from '../extension/chronicle-token-meter.js';
import { renderChronicleFrontier } from '../extension/chronicle.js';

test('the tokenizer receives the complete rendered frontier, excluding covered children', async () => {
    const chronicle = [
        { id: 'a', level: 0, from: 0, text: 'Hidden child.' },
        { id: 'b', level: 1, from: 0, text: 'Résumé. 故事继续。', turningPoints: ['Another detail.'], childIds: ['a'] },
        { id: 'c', level: 0, from: 8, text: 'New detail.' },
    ].map(node => ({ ...node, chatKey: 'chat' }));
    const text = renderChronicleFrontier({ chronicle }, 'chat');
    const request = { chatKey: 'chat', tokenizer: 'model-a', text };
    let calls = 0, renders = 0;
    const read = createChronicleTokenMeter(async value => {
        calls++;
        assert.equal(value, '[C1] Résumé. 故事继续。\nAnother detail.\n\n[C0] New detail.');
        return 31;
    }, () => renders++);
    assert.equal(read(request).status, 'measuring');
    assert.equal(read(request).status, 'measuring');
    await flush();
    assert.equal(read(request).tokens, 31);
    assert.match(formatChronicleTokenStatus(read(request), 8000), /31 tokens \(SillyTavern tokenizer: model-a; not prompt usage\)/);
    assert.equal(calls, 1);
    assert.equal(renders, 1);
});

test('late counts cannot replace another chat, tokenizer, or rendered revision', async () => {
    const pending = [];
    let renders = 0;
    const read = createChronicleTokenMeter(() => new Promise(resolve => pending.push(resolve)), () => renders++);
    const first = { chatKey: 'chat', tokenizer: 'model-a', text: 'Original.' };
    const updates = [first, { ...first, text: 'Edited.' },
        { ...first, tokenizer: 'model-b' }, { ...first, chatKey: 'other' }];
    updates.forEach(read);
    await flush();
    for (const resolve of pending.slice(0, -1)) resolve(100);
    await flush();
    assert.equal(renders, 0);
    pending.at(-1)(42);
    await flush();
    assert.equal(read(updates.at(-1)).tokens, 42);
    assert.equal(renders, 1);
});

test('unavailable counts stay unreported and retry without inventing a heuristic value', async () => {
    let calls = 0, time = 0;
    const read = createChronicleTokenMeter(async () => {
        if (++calls === 1) throw new Error('network unavailable');
        return 44;
    }, () => {}, { now: () => time, retryMs: 100 });
    const request = { chatKey: 'chat', tokenizer: 'model-a', text: 'A story.' };
    assert.equal(read({ ...request, text: '' }).status, 'empty');
    read(request);
    await flush();
    assert.equal(formatChronicleTokenStatus(read(request), 8000), 'Stored Story so far: tokenizer count unavailable.');
    assert.equal(calls, 1);
    time = 100;
    assert.equal(read(request).status, 'measuring');
    await flush();
    assert.equal(read(request).tokens, 44);
});
