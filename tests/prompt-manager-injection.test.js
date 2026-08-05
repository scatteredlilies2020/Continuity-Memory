import assert from 'node:assert/strict';
import test from 'node:test';
import { clearPromptManagerInjection, configurePromptManagerInjection, PROMPT_MANAGER_ID } from '../extension/prompt-manager-injection.js';

function manager() {
    const prompts = [];
    const order = ['main', 'charDescription', 'scenario', 'dialogueExamples', 'chatHistory', 'jailbreak']
        .map(identifier => ({ identifier, enabled: true }));
    return {
        activeCharacter: { id: 1 },
        getPromptOrderForCharacter: () => order,
        getPromptById: identifier => prompts.find(prompt => prompt.identifier === identifier) || null,
        addPrompt(prompt, identifier) { prompts.push({ identifier, ...prompt }); },
        prompts,
        order,
    };
}

test('places dynamic memory before or after real Prompt Manager anchors with any role', () => {
    const before = manager();
    assert.equal(configurePromptManagerInjection(before, { injectionPosition: 'before-jailbreak', injectionRole: 'system' }, 'memory'), true);
    assert.equal(before.order.findIndex(item => item.identifier === PROMPT_MANAGER_ID), before.order.findIndex(item => item.identifier === 'jailbreak') - 1);
    assert.equal(before.getPromptById(PROMPT_MANAGER_ID).role, 'system');

    const after = manager();
    assert.equal(configurePromptManagerInjection(after, { injectionPosition: 'after-example-messages', injectionRole: 'assistant' }, 'memory'), true);
    assert.equal(after.order.findIndex(item => item.identifier === PROMPT_MANAGER_ID), after.order.findIndex(item => item.identifier === 'dialogueExamples') + 1);
    assert.equal(after.getPromptById(PROMPT_MANAGER_ID).role, 'assistant');
    clearPromptManagerInjection(after);
    assert.equal(after.getPromptById(PROMPT_MANAGER_ID).content, '');
});
