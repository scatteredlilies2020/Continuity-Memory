import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeChatExport } from '../extension/chat-sanitizer.js';

test('cleans embedded Continuity memory from a SillyTavern JSONL chat export', () => {
    const input = [
        JSON.stringify({ user_name: 'User', chat_metadata: { continuityMemory: { world: { id: 'secret' } }, integrity: 'keep' } }),
        JSON.stringify({ name: 'Assistant', mes: 'Hello' }),
        '',
    ].join('\n');
    const result = sanitizeChatExport(input, 'chat.jsonl');
    const [header, message] = result.text.trim().split('\n').map(JSON.parse);
    assert.equal(result.removed, 1);
    assert.equal(result.format, 'jsonl');
    assert.equal(Object.hasOwn(header.chat_metadata, 'continuityMemory'), false);
    assert.equal(header.chat_metadata.integrity, 'keep');
    assert.equal(message.mes, 'Hello');
});

test('cleans JSON chat exports without changing unrelated metadata', () => {
    const input = JSON.stringify({ chat_metadata: { continuityMemory: { world: { id: 'secret' } }, note: 'keep' }, messages: [] });
    const result = sanitizeChatExport(input, 'chat.json');
    const clean = JSON.parse(result.text);
    assert.equal(result.removed, 1);
    assert.deepEqual(clean.chat_metadata, { note: 'keep' });
});

test('refuses invalid files and exports that contain no Continuity memory', () => {
    assert.throws(() => sanitizeChatExport('{bad', 'chat.json'), /JSON/);
    assert.throws(() => sanitizeChatExport(JSON.stringify({ chat_metadata: {} }), 'chat.json'), /No embedded Continuity memory/);
});
