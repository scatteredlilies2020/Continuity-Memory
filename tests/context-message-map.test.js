import test from 'node:test';
import assert from 'node:assert/strict';
import { mapContextMessages } from '../extension/context-message-map.js';
import { fingerprintMessage } from '../extension/fingerprint.js';

test('verifies processed messages against original text before prompt-only regex changes', () => {
    const source = [{
        name: 'Character',
        is_user: false,
        mes: '<stat>large status block</stat>\nNarrative result',
    }];
    const processed = [{
        ...source[0],
        index: 0,
        mes: 'Narrative result',
    }];

    const [entry] = mapContextMessages(processed, source);
    const storedFingerprint = fingerprintMessage({
        index: 0,
        name: 'Character',
        text: source[0].mes,
    });

    assert.equal(fingerprintMessage(entry.sourceIdentity), storedFingerprint);
    assert.notEqual(fingerprintMessage(entry.promptIdentity), storedFingerprint);
    assert.equal(entry.promptIdentity.text, 'Narrative result');
});

test('preserves original indexes when system messages are filtered from the generation chat', () => {
    const source = [
        { name: 'User', is_user: true, mes: 'First' },
        { name: 'System', is_system: true, mes: 'Internal marker' },
        { name: 'Character', is_user: false, mes: 'Second' },
    ];
    const processed = [
        { ...source[0], index: 0 },
        { ...source[2], index: 1 },
    ];

    const entries = mapContextMessages(processed, source);
    assert.deepEqual(entries.map(entry => entry.sourceIdentity.index), [0, 2]);
});

test('keeps tool-call messages non-reducible without misaligning later source messages', () => {
    const source = [
        { name: 'Character', mes: 'Tool call', extra: { tool_invocations: [] } },
        { name: 'User', is_user: true, mes: 'After tool call' },
    ];
    const processed = [
        { ...source[0], index: 0 },
        { ...source[1], index: 1 },
    ];

    const entries = mapContextMessages(processed, source);
    assert.equal(entries[0].promptIdentity, null);
    assert.equal(entries[1].sourceIdentity.index, 1);
    assert.equal(entries[1].sourceIdentity.text, 'After tool call');
});
