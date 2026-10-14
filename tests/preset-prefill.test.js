import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMemoryFeedback, memoryRequestMessages, presetPrefill, requestPrefill, responseWithPrefill, summaryPrefill } from '../extension/preset-prefill.js';
import { parseJsonResponse } from '../extension/json-response.js';

function preset(prompts, order = prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true }))) {
    return { prompts, prompt_order: [{ character_id: 100001, order }] };
}
const history = { identifier: 'chatHistory', marker: true };
const prefix = { identifier: 'prefix', role: 'assistant', content: '{"result": ' };

test('custom summary prefill requires both the checkbox and nonblank content', () => {
    assert.equal(summaryPrefill({}), '');
    assert.equal(summaryPrefill({ summaryPrefillEnabled: false, summaryPrefill: '{' }), '');
    assert.equal(summaryPrefill({ summaryPrefillEnabled: true, summaryPrefill: ' \n ' }), '');
    assert.equal(summaryPrefill({ summaryPrefillEnabled: true, summaryPrefill: '{{char}}: ' }, text => text.replace('{{char}}', 'Alice')), 'Alice: ');
    assert.equal(summaryPrefill({ summaryPrefillEnabled: true, summaryPrefill: '{{empty}}' }, () => ''), '');
});

test('legacy prefills expand macros and preserve significant whitespace', () => {
    assert.equal(presetPrefill({ assistant_prefill: '{{char}}: ' }, { substitute: text => text.replace('{{char}}', 'Alice') }), 'Alice: ');
    assert.equal(presetPrefill({ assistant_prefill: '   ' }), '');
    assert.equal(presetPrefill(null), '');
});

test('imports only enabled trailing assistant entries, not other preset prompts or history', () => {
    const data = preset([
        { identifier: 'roleplay', role: 'system', content: 'Do not import this.' },
        history, prefix, { ...prefix, identifier: 'disabled', content: 'Do not import this either.' },
    ], ['roleplay', 'chatHistory', 'prefix', 'disabled'].map(identifier => ({ identifier, enabled: identifier !== 'disabled' })));
    const before = structuredClone(data);
    assert.equal(presetPrefill(data), prefix.content);
    assert.deepEqual(data, before);
    assert.equal(presetPrefill(preset([prefix, history])), '');
    assert.equal(presetPrefill(preset([history, prefix, { identifier: 'last', role: 'user', content: 'Not a prefill' } ])), '');
});

test('supports migrated depth-zero prefills and excludes deeper injections and impersonation', () => {
    const migrated = { ...prefix, identifier: 'assistantPrefill', injection_position: 1, injection_depth: 0, injection_order: 0,
        injection_trigger: ['normal', 'swipe', 'regenerate'] };
    assert.equal(presetPrefill(preset([history, migrated])), prefix.content);
    assert.equal(presetPrefill(preset([history, { ...migrated, injection_depth: 1 }])), '');
    assert.equal(presetPrefill(preset([history, { ...migrated, injection_trigger: ['impersonate'] }])), '');
    assert.equal(presetPrefill({ ...preset([migrated], [{ identifier: migrated.identifier, enabled: false }]), assistant_prefill: 'old stale prefix' }), '');
});

test('respects character order and never reuses Continuity memory as a prefill', () => {
    const data = preset([history, prefix, { ...prefix, identifier: 'continuity_memory_dynamic', content: 'private memory' }]);
    data.prompt_order.push({ character_id: 42, order: [{ identifier: 'prefix', enabled: false }] });
    assert.equal(presetPrefill(data, { characterId: 42 }), '');
    assert.equal(presetPrefill(data), prefix.content);
    assert.equal(presetPrefill(data, { order: [] }), '');
});

test('combines consecutive assistant prefills and handles depth-zero injection priorities', () => {
    assert.equal(presetPrefill(preset([history, prefix, { ...prefix, identifier: 'second', content: 'next' }])), prefix.content + '\nnext');
    const absolute = { ...prefix, injection_position: 1, injection_depth: 0 };
    assert.equal(presetPrefill(preset([history, { ...absolute, identifier: 'first', injection_order: 100, content: 'first' },
        { ...absolute, injection_order: 0, content: 'last' }])), 'first\nlast');
});

test('partial JSON and thought prefixes are restored without duplicating full responses', () => {
    assert.equal(responseWithPrefill('"terms":["Alice"]}', '{'), '{"terms":["Alice"]}');
    assert.equal(responseWithPrefill('{"terms":["Alice"]}', '{'), '{"terms":["Alice"]}');
    assert.equal(responseWithPrefill('{"terms":["Alice"]}', '{"terms": '), '{"terms":["Alice"]}');
    assert.equal(responseWithPrefill('reasoning</think>{"terms":[]}', '<think>'), '<think>reasoning</think>{"terms":[]}');
    assert.equal(responseWithPrefill('unchanged'), 'unchanged');
});

test('a complete fenced JSON answer does not receive a duplicate JSON prefix', () => {
    for (const fence of ['```json', '```JSON', '```']) {
        const response = `${fence}\n{"facts":[]}\n\`\`\``;
        assert.equal(responseWithPrefill(response, '{'), response);
    }
    assert.equal(responseWithPrefill('"facts":[]}', '{'), '{"facts":[]}');
    assert.equal(responseWithPrefill('finished</think>\n{"facts":[]}', '<think>'), '<think>finished</think>\n{"facts":[]}');
});

test('feedback remains before the prefill without mutating prior requests', () => {
    const messages = memoryRequestMessages('task', 'system', '{');
    const updated = appendMemoryFeedback(messages, 'Fix missing fields.');
    assert.equal(messages.length, 3);
    assert.equal(requestPrefill(updated), '{');
    assert.equal(updated.at(-2).role, 'user');
    assert.equal(updated.at(-2).content, 'Fix missing fields.');
    assert.equal(memoryRequestMessages('task', 'system').length, 2);
});

test('complete answers with prose or reasoning do not receive duplicate JSON prefixes', () => {
    for (const response of [
        'Here is the extraction:\n```json\n{"facts":[]}\n```',
        '<think>Consider the source.</think>\n{"facts":[]}',
    ]) {
        for (const prefill of ['{', '{"facts":']) {
            assert.equal(responseWithPrefill(response, prefill), response);
            assert.deepEqual(parseJsonResponse(responseWithPrefill(response, prefill)), { facts: [] });
        }
    }
});

test('a partial reasoning prefill can precede complete JSON without a closing tag', () => {
    const prefill = '<think>Consider the source.\n';
    const response = 'Final answer:\n```json\n{"facts":[]}\n```';
    assert.equal(responseWithPrefill(response, prefill), prefill + response);
    assert.deepEqual(parseJsonResponse(responseWithPrefill(response, prefill)), { facts: [] });
    assert.throws(() => parseJsonResponse(responseWithPrefill('Final answer:\n{"facts":[', prefill)), /incomplete/);
});

test('system prompts after a prefix neither suppress it nor execute unrelated macros', () => {
    const expanded = [];
    const data = preset([history, prefix, { identifier: 'jailbreak', role: 'system', content: '{{setvar::unrelated::1}}' }]);
    assert.equal(presetPrefill(data, { substitute: (...args) => {
        assert.equal(args.length, 1, 'Do not pass Array.map indices as macro options');
        expanded.push(args[0]);
        return args[0];
    } }), prefix.content);
    assert.deepEqual(expanded, [prefix.content]);
});
