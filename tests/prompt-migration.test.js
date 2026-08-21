import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CANONICAL_EPISTEMIC_MEMORY_RULES,
    EPISTEMIC_MEMORY_RULES,
    PRE_KNOWLEDGE_GAP_EPISTEMIC_MEMORY_RULES,
    PRE_STRUCTURED_KNOWLEDGE_BOUNDARY_RULES,
} from '../extension/prompts.js';
import { retainLatestPromptRule } from '../extension/prompt-migration.js';

test('prompt migration preserves custom instructions and retains one latest epistemic rule', () => {
    const prompt = [
        'Custom opening instruction.',
        PRE_KNOWLEDGE_GAP_EPISTEMIC_MEMORY_RULES,
        'Custom middle instruction.',
        PRE_STRUCTURED_KNOWLEDGE_BOUNDARY_RULES,
        'Knowledge is non-transitive: a historically migrated variation.',
        'For consequential ignorance, retain an older migrated variation.',
        CANONICAL_EPISTEMIC_MEMORY_RULES,
        EPISTEMIC_MEMORY_RULES,
        'Custom closing instruction.',
        EPISTEMIC_MEMORY_RULES,
    ].join('\n');
    const compacted = retainLatestPromptRule(prompt, EPISTEMIC_MEMORY_RULES, [
        CANONICAL_EPISTEMIC_MEMORY_RULES,
        PRE_STRUCTURED_KNOWLEDGE_BOUNDARY_RULES,
        PRE_KNOWLEDGE_GAP_EPISTEMIC_MEMORY_RULES,
    ], [
        'Keep established facts separate from subjective perspectives.',
        'Knowledge is non-transitive:',
        'For consequential ignorance,',
        'Work for a body is not membership.',
    ]);
    assert.match(compacted, /Custom opening instruction\./u);
    assert.match(compacted, /Custom middle instruction\./u);
    assert.match(compacted, /Custom closing instruction\./u);
    assert.equal(compacted.split(EPISTEMIC_MEMORY_RULES).length - 1, 1);
    assert.ok(!compacted.includes(CANONICAL_EPISTEMIC_MEMORY_RULES));
    assert.ok(!compacted.includes('historically migrated variation'));
    assert.ok(compacted.length < prompt.length);
});

test('prompt-rule compaction is idempotent', () => {
    const once = retainLatestPromptRule('Custom instruction.\nOld rule.', 'Latest rule.', ['Old rule.']);
    const twice = retainLatestPromptRule(once, 'Latest rule.', ['Old rule.']);
    assert.equal(twice, once);
});
