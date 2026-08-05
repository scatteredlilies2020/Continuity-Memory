import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInjectionPlacement } from '../extension/injection-placement.js';

const types = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

test('supports user-role chat injection at depth four', () => {
    assert.deepEqual(resolveInjectionPlacement({ injectionPosition: 'at-depth', injectionDepth: 4, injectionRole: 'user' }, types, roles), {
        position: types.IN_CHAT,
        depth: 4,
        role: roles.USER,
    });
    assert.equal(resolveInjectionPlacement({ injectionPosition: 'at-depth', injectionDepth: 4 }, types, roles).role, roles.USER);
});

test('supports main and Prompt Manager fallbacks while clamping chat placement', () => {
    assert.equal(resolveInjectionPlacement({ injectionPosition: 'before-main' }, types, roles).position, types.BEFORE_PROMPT);
    assert.equal(resolveInjectionPlacement({ injectionPosition: 'after-main' }, types, roles).position, types.IN_PROMPT);
    assert.equal(resolveInjectionPlacement({ injectionPosition: 'before-jailbreak' }, types, roles).position, types.BEFORE_PROMPT);
    assert.equal(resolveInjectionPlacement({ injectionPosition: 'after-jailbreak' }, types, roles).position, types.IN_PROMPT);
    assert.deepEqual(resolveInjectionPlacement({ injectionPosition: 'before-chat-history', injectionRole: 'user' }, types, roles), {
        position: types.BEFORE_PROMPT,
        depth: 0,
        role: roles.USER,
    });
    assert.deepEqual(resolveInjectionPlacement({ injectionPosition: 'at-depth', injectionDepth: 500, injectionRole: 'assistant' }, types, roles), {
        position: types.IN_CHAT,
        depth: 100,
        role: roles.ASSISTANT,
    });
});
