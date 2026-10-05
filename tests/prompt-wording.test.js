import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    buildExtractionSystemPrompt, buildHierarchySystemPrompt, upgradePromptWording,
    DEFAULT_EXTRACTION_SYSTEM_PROMPT, DEFAULT_CHRONICLE_SYSTEM_PROMPT,
    DURABLE_MEMORY_RULES, CHARACTER_PROFILE_RULE, EPISTEMIC_MEMORY_RULES,
    CHRONICLE_ENTRY_RULE, CHRONICLE_ENTRY_LENGTH_RULE, SOURCE_SCOPE_RULE,
    EXTREME_CANON_FIDELITY_RULE, EXTREME_SUMMARY_FIDELITY_RULE,
} from '../extension/prompts.js';
import { EXTRACTION_COMPLETENESS_RULE, EXTRACTION_OUTPUT_CHECK } from '../extension/extraction-contract.js';

// Captured assembled defaults before the wording revision, not reconstructed from new rules.
const old = JSON.parse(readFileSync(new URL('./helpers/pre-plain-prompts.json', import.meta.url), 'utf8'));

test('old assembled defaults upgrade exactly to current builders without duplicate rules', () => {
    for (const [build, previous, current] of [
        [buildExtractionSystemPrompt, old.extractionSystemPrompt, DEFAULT_EXTRACTION_SYSTEM_PROMPT],
        [buildHierarchySystemPrompt, old.chronicleSystemPrompt, DEFAULT_CHRONICLE_SYSTEM_PROMPT],
    ]) {
        const expected = build(current);
        assert.equal(build(previous), expected);
        assert.equal(build(expected), expected);
        const custom = `Custom prefix.\n${previous}\nCustom suffix.`;
        assert.equal(build(custom), `Custom prefix.\n${expected}\nCustom suffix.`);
        assert.ok(expected.length < previous.length);
    }
});

test('wording upgrader leaves independently written instructions alone', () => {
    const custom = 'Keep my descriptions detailed. Working for a guild can imply membership in this setting.';
    assert.equal(upgradePromptWording(custom), custom);
    assert.equal(upgradePromptWording(upgradePromptWording(old.extractionSystemPrompt)), upgradePromptWording(old.extractionSystemPrompt));
});

test('current state excludes future plans without losing ongoing-state rules', () => {
    assert.match(DURABLE_MEMORY_RULES, /true at the excerpt's end/);
    assert.match(DURABLE_MEMORY_RULES, /scene covers immediate location, activity, pose, or emotion/);
    assert.match(DURABLE_MEMORY_RULES, /Intended or predicted future actions belong in supporting memories, not current state/);
    assert.match(DURABLE_MEMORY_RULES, /current only while the newest Digest reconfirms it/);
    assert.doesNotMatch(DURABLE_MEMORY_RULES, /short-term plan|Predictions and plans stay threads/);
});

test('plain profile and knowledge rules retain attribution and membership distinctions', () => {
    assert.match(CHARACTER_PROFILE_RULE, /Put age and life stage only in ageDemographics/);
    assert.match(CHARACTER_PROFILE_RULE, /Exclude temporary actions, reactions, details about other people, comparison tables, and status panels/);
    assert.match(CHARACTER_PROFILE_RULE, /Use \[\] for unknown groups and all groups of a non-person/);
    assert.match(EPISTEMIC_MEMORY_RULES, /One character knowing something does not mean another knows it/);
    assert.match(EPISTEMIC_MEMORY_RULES, /Narration alone does not mean a character learned it/);
    assert.match(EPISTEMIC_MEMORY_RULES, /Working for an organization does not by itself establish membership/);
});

test('shorter checklist still accompanies full completeness and detail-preservation rules', () => {
    const extraction = buildExtractionSystemPrompt(DEFAULT_EXTRACTION_SYSTEM_PROMPT);
    for (const rule of [EXTRACTION_COMPLETENESS_RULE, CHRONICLE_ENTRY_RULE, CHRONICLE_ENTRY_LENGTH_RULE, SOURCE_SCOPE_RULE, EXTREME_CANON_FIDELITY_RULE]) {
        assert.equal(extraction.split(rule).length - 1, 1);
    }
    assert.ok(DEFAULT_CHRONICLE_SYSTEM_PROMPT.includes(EXTREME_SUMMARY_FIDELITY_RULE));
    assert.ok(DEFAULT_CHRONICLE_SYSTEM_PROMPT.includes(SOURCE_SCOPE_RULE));
    assert.match(EXTRACTION_OUTPUT_CHECK, /targetId matches/);
    assert.match(EXTRACTION_OUTPUT_CHECK, /characterProfile groups and other list fields as arrays/);
    assert.match(EXTRACTION_COMPLETENESS_RULE, /only explicit clear allows an empty value/);
});
