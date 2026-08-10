import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildExtractionSystemPrompt,
    buildHierarchySystemPrompt,
    CONTINUITY_COVERAGE_RULES,
    DEFAULT_ARC_SYSTEM_PROMPT,
    DEFAULT_ERA_SYSTEM_PROMPT,
    DEFAULT_EXTRACTION_SYSTEM_PROMPT,
    DEFAULT_INJECTION_INSTRUCTION,
    DEFAULT_JB_PROMPT,
    DEFAULT_RETRIEVAL_SYSTEM_PROMPT,
    HIERARCHY_CONCISION_RULES,
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
    assert.match(HIERARCHY_CONCISION_RULES, /never use an ellipsis/i);
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
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /State holds replaceable conditions/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /durable, tense-neutral identity summaries/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /unfinished matters in atomic threads/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /exact supplied thread titles and background topics/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /combine simultaneous values of one predicate/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Most retained items should be 2 or 3/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /reserve 5 for truly foundational continuity/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Use identityResolutions only when the supplied narrative establishes/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /outside franchise knowledge/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Canonical memory context contains relevant existing mutable records/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Omit an existing record when the excerpt only repeats it unchanged/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Coverage and retrieval are separate concerns/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /silently inventory every distinct non-focal continuity-bearing strand/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /output exactly one compact backgrounds record/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Never group unrelated strands/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /confirmed, reported, rumored, or uncertain/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /When uncertain about future relevance, retain one compact low-importance background record/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /separate persistent fact for each established speaker-to-addressee pattern/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /honorifics, titles, nicknames, callsigns, and first-name use/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /form of address for \[canonical addressee\]/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /address shift signals changed familiarity, distance, respect, or hierarchy/);
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /without emphasizing or explaining them/);
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.includes(CONTINUITY_COVERAGE_RULES));
    assert.match(DEFAULT_RETRIEVAL_SYSTEM_PROMPT, /roleplay or simulation/);
    assert.match(DEFAULT_ARC_SYSTEM_PROMPT, /participants need not be people/);
    assert.match(DEFAULT_ERA_SYSTEM_PROMPT, /participants need not be people/);
    assert.match(DEFAULT_ARC_SYSTEM_PROMPT, /Most retained items should be 2 or 3/);
    assert.match(DEFAULT_ERA_SYSTEM_PROMPT, /Most retained items should be 2 or 3/);
});
