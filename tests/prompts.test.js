import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_ARC_SYSTEM_PROMPT,
    DEFAULT_ERA_SYSTEM_PROMPT,
    DEFAULT_EXTRACTION_SYSTEM_PROMPT,
    DEFAULT_RETRIEVAL_SYSTEM_PROMPT,
    renderPromptTemplate,
} from '../extension/prompts.js';

test('custom prompt templates cannot omit required payloads', () => {
    const rendered = renderPromptTemplate('Custom instruction only.', {
        schema: '{"required":true}',
        messages: 'User: hello',
    }, ['schema', 'messages']);
    assert.match(rendered, /Custom instruction only\./);
    assert.match(rendered, /\{"required":true\}/);
    assert.match(rendered, /User: hello/);
});

test('prompt templates replace optional and required placeholders', () => {
    const rendered = renderPromptTemplate('{{detail}}\n{{messages}}', {
        detail: 'Detailed.',
        messages: 'Character: response',
    }, ['messages']);
    assert.equal(rendered, 'Detailed.\nCharacter: response');
});

test('default prompts support arbitrary scenario ontologies and calibrate importance', () => {
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /scenario's own ontology/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /person, group, institution, place, object, resource, process, system, or concept/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /reports, logs, turns, status updates, simulation results/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Use state for replaceable values or conditions/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /several simultaneous values, combine the complete set/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Most retained items should be 2 or 3/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /reserve 5 for truly foundational continuity/);
    assert.match(DEFAULT_RETRIEVAL_SYSTEM_PROMPT, /roleplay or simulation/);
    assert.match(DEFAULT_ARC_SYSTEM_PROMPT, /participants need not be people/);
    assert.match(DEFAULT_ERA_SYSTEM_PROMPT, /participants need not be people/);
    assert.match(DEFAULT_ARC_SYSTEM_PROMPT, /Most retained items should be 2 or 3/);
    assert.match(DEFAULT_ERA_SYSTEM_PROMPT, /Most retained items should be 2 or 3/);
});
