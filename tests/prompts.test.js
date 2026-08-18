import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildExtractionSystemPrompt,
    buildHierarchySystemPrompt,
    CONTINUITY_COVERAGE_RULES,
    DEFAULT_ARC_SYSTEM_PROMPT,
    DEFAULT_ARC_TASK_TEMPLATE,
    DEFAULT_ERA_SYSTEM_PROMPT,
    DEFAULT_ERA_TASK_TEMPLATE,
    DEFAULT_EXTRACTION_SYSTEM_PROMPT,
    DEFAULT_EXTRACTION_TASK_TEMPLATE,
    DEFAULT_INJECTION_INSTRUCTION,
    DEFAULT_JB_PROMPT,
    DEFAULT_RETRIEVAL_SYSTEM_PROMPT,
    EPISTEMIC_MEMORY_RULES,
    HIERARCHY_CONCISION_RULES,
    RELATIONSHIP_DESCRIPTION_RULE,
    renderPromptTemplate,
} from '../extension/prompts.js';

test('JB prompt is appended to extraction instructions only when enabled', () => {
    assert.equal(buildExtractionSystemPrompt('Base extraction instructions.', false, '<rules>custom</rules>'), 'Base extraction instructions.');
    assert.equal(
        buildExtractionSystemPrompt('Base extraction instructions.', true, '<rules>custom</rules>'),
        'Base extraction instructions.\n\n<rules>custom</rules>',
    );
    assert.equal(buildExtractionSystemPrompt('Base extraction instructions.', true, '   '), 'Base extraction instructions.');
    assert.equal(buildExtractionSystemPrompt('', true, '<rules>custom</rules>'), '<rules>custom</rules>');
    assert.match(DEFAULT_JB_PROMPT, /^<rules>[\s\S]*<\/rules>$/);
});

test('custom prompt templates cannot omit required payloads', () => {
    const rendered = renderPromptTemplate('Custom instruction only.', {
        schema: '{"required":true}',
        messages: 'User: hello',
    }, ['schema', 'messages']);
    assert.match(rendered, /Custom instruction only\./);
    assert.match(rendered, /\{"required":true\}/);
    assert.match(rendered, /User: hello/);
});

test('hierarchy concision rules apply to defaults and custom instructions', () => {
    assert.equal(buildHierarchySystemPrompt(DEFAULT_ARC_SYSTEM_PROMPT), DEFAULT_ARC_SYSTEM_PROMPT);
    assert.equal(buildHierarchySystemPrompt(DEFAULT_ERA_SYSTEM_PROMPT), DEFAULT_ERA_SYSTEM_PROMPT);
    assert.equal(buildHierarchySystemPrompt('Custom hierarchy instructions.'), `Custom hierarchy instructions.\n\n${HIERARCHY_CONCISION_RULES}`);
    assert.match(HIERARCHY_CONCISION_RULES, /without omission ellipses/i);
});

test('prompt templates replace optional and required placeholders', () => {
    const rendered = renderPromptTemplate('{{detail}}\n{{messages}}', {
        detail: 'Detailed.',
        messages: 'Character: response',
    }, ['messages']);
    assert.equal(rendered, 'Detailed.\nCharacter: response');
});

test('default prompts support arbitrary scenario ontologies and calibrate importance', () => {
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /scenario's ontology/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /people, groups, institutions, places, objects, resources, processes, systems, or concepts/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /reports, logs, turns, status updates, or simulation results/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /State is a replaceable condition/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /durable, tense-neutral identity summaries/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /unfinished matters in atomic threads/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Threads are atomic unresolved conditions/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /emit its targetId resolved/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Reuse a supplied thread title only while that exact titled condition remains open/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /one canonical relationship record/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /from and to identify the participants only/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /dynamic the authoritative self-contained description/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /never retain a fulfilled or misleading title/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, new RegExp(RELATIONSHIP_DESCRIPTION_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /Relationship ↔ is direction-neutral/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /include a named person being visited, met, contacted, or reported to/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /exclude someone mentioned only as an object's former owner/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /combine simultaneous values of one predicate/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Most items are 2 or 3/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /5 only for foundational continuity/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Use identityResolutions only when the narrative establishes/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Never resolve from outside knowledge/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /When canonical context supplies targetId/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Omit unchanged records/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Silently inventory distinct non-focal strands/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /output exactly one compact background record/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Never group unrelated strands/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /confirmed, reported, rumored, or uncertain/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /If future relevance is uncertain, retain at most one compact low-importance background record/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /one fact per speaker-addressee pair/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /honorifics, titles, nicknames, callsigns, or first-name use/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /direct, name-like vocative/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /not a sentence, clause/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Subject says it/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /calls ACTUAL_CANONICAL_NAME.*recipient/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Never output placeholder text or brackets/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /omit absence, silence, indirect replies, and claims that no address is established/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /One meaningful shift is enough/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /message author is not automatically the speaker/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Self-directed facts require explicit self-use of the form/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /never infer self-address from another speaker/i);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Value: list all exact current forms and meaningful former forms only/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /keep coexisting forms together/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /shift signals changed familiarity, distance, respect, or hierarchy/);
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /without explanation/);
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /private information unless current chat or memory establishes that they learned it/);
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.includes(CONTINUITY_COVERAGE_RULES));
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.includes(EPISTEMIC_MEMORY_RULES));
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /category is "character belief"/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /without inferring a hidden answer/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Knowledge is non-transitive/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Mere solitary discovery does not require a thread/);
    assert.match(DEFAULT_RETRIEVAL_SYSTEM_PROMPT, /roleplay or simulation/);
    assert.match(DEFAULT_RETRIEVAL_SYSTEM_PROMPT, /immediate next response/);
    assert.match(DEFAULT_RETRIEVAL_SYSTEM_PROMPT, /every phrase independently searchable/);
    assert.match(DEFAULT_RETRIEVAL_SYSTEM_PROMPT, /include those actors in that same phrase/);
    assert.match(DEFAULT_ARC_SYSTEM_PROMPT, /participants need not be people/);
    assert.match(DEFAULT_ERA_SYSTEM_PROMPT, /participants need not be people/);
    assert.match(DEFAULT_ARC_SYSTEM_PROMPT, /consequential knowledge gaps as open threads/);
    assert.match(DEFAULT_ARC_SYSTEM_PROMPT, /Most items are 2 or 3/);
    assert.match(DEFAULT_ERA_SYSTEM_PROMPT, /Most items are 2 or 3/);
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.length < 10000);
    assert.ok(DEFAULT_ARC_SYSTEM_PROMPT.length < 1800);
    assert.ok(DEFAULT_ERA_SYSTEM_PROMPT.length < 1800);
});

test('default structured task prompts avoid repeating full schemas', () => {
    for (const template of [DEFAULT_EXTRACTION_TASK_TEMPLATE, DEFAULT_ARC_TASK_TEMPLATE, DEFAULT_ERA_TASK_TEMPLATE]) {
        assert.match(template, /\{\{format\}\}/);
        assert.doesNotMatch(template, /\{\{schema\}\}/);
    }
});
