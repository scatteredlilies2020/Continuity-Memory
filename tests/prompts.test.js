import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildExtractionSystemPrompt,
    buildHierarchySystemPrompt,
    buildRetrievalSystemPrompt,
    CHRONICLE_ENTRY_RULE,
    CHARACTER_PROFILE_RULE,
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
    EXTREME_CANON_FIDELITY_RULE,
    EXTREME_SUMMARY_FIDELITY_RULE,
    HIERARCHY_CONCISION_RULES,
    L1_EPISTEMIC_COVERAGE_RULE,
    OOC_META_AUTHORITY_RULE,
    PRE_ATOMIC_IDENTITY_L1_EPISTEMIC_COVERAGE_RULE,
    RELATIONSHIP_DESCRIPTION_RULE,
    ROLLING_STORY_QUALITY_RULE,
    ROLLING_STORY_QUALITY_TASK_TEMPLATE,
    ROLLING_STORY_RULE,
    ROLLING_STORY_TASK_TEMPLATE,
    ROLLING_STORY_VERIFY_RULE,
    ROLLING_STORY_VERIFY_TASK_TEMPLATE,
    renderPromptTemplate,
} from '../extension/prompts.js';

test('JB prompt is appended to extraction instructions only when enabled', () => {
    assert.equal(buildExtractionSystemPrompt('Base extraction instructions.', false, '<rules>custom</rules>'), `Base extraction instructions.\n\n${OOC_META_AUTHORITY_RULE}\n\n${CHARACTER_PROFILE_RULE}\n\n${EXTREME_CANON_FIDELITY_RULE}\n\n${CHRONICLE_ENTRY_RULE}`);
    assert.equal(
        buildExtractionSystemPrompt('Base extraction instructions.', true, '<rules>custom</rules>'),
        `Base extraction instructions.\n\n<rules>custom</rules>\n\n${OOC_META_AUTHORITY_RULE}\n\n${CHARACTER_PROFILE_RULE}\n\n${EXTREME_CANON_FIDELITY_RULE}\n\n${CHRONICLE_ENTRY_RULE}`,
    );
    assert.equal(buildExtractionSystemPrompt('Base extraction instructions.', true, '   '), `Base extraction instructions.\n\n${OOC_META_AUTHORITY_RULE}\n\n${CHARACTER_PROFILE_RULE}\n\n${EXTREME_CANON_FIDELITY_RULE}\n\n${CHRONICLE_ENTRY_RULE}`);
    assert.equal(buildExtractionSystemPrompt('', true, '<rules>custom</rules>'), `<rules>custom</rules>\n\n${OOC_META_AUTHORITY_RULE}\n\n${CHARACTER_PROFILE_RULE}\n\n${EXTREME_CANON_FIDELITY_RULE}\n\n${CHRONICLE_ENTRY_RULE}`);
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

test('prompt builders preserve custom instructions without adding prose-style directives', () => {
    assert.equal(buildRetrievalSystemPrompt('Custom retrieval instructions.'), 'Custom retrieval instructions.');
    for (const prompt of [
        buildExtractionSystemPrompt(DEFAULT_EXTRACTION_SYSTEM_PROMPT),
        buildRetrievalSystemPrompt(DEFAULT_RETRIEVAL_SYSTEM_PROMPT),
        buildHierarchySystemPrompt(DEFAULT_ARC_SYSTEM_PROMPT),
        buildHierarchySystemPrompt(DEFAULT_ERA_SYSTEM_PROMPT),
    ]) assert.doesNotMatch(prompt, /avoid em dashes/i);
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
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /out-of-character or meta assertions about scenario continuity are authoritative canon/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Every durable assertion under such a label must appear in structured records/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Only an explicit user OOC\/meta assertion may authorize treating an assertion's embedded proposition as hard objective truth/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /establishes only that the source said, reported, remembered, inferred, or believed it/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /leave the embedded proposition unconfirmed/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /epistemic state; do not promote its embedded proposition/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /statistically extreme, unprecedented, unique, off-scale/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Setting averages and records are context, not ceilings/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /preserve the relational constraint and do not fabricate false precision/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /State is a replaceable condition/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /durable, tense-neutral identity summaries/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /characterProfile fields roleBackground, ageDemographics, appearance, personalityQuirks/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /empty if unknown\/non-person/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /never invent/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /explicit names and third person, never I\/we\/you or player-facing advice/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /unfinished matters in atomic threads/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Threads are atomic unresolved conditions/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /emit its targetId resolved/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Reuse a supplied thread title only while that exact titled condition remains open/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /one canonical relationship record/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /from and to identify the participants only/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /dynamic the authoritative self-contained description/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /never retain a fulfilled or misleading title/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, new RegExp(RELATIONSHIP_DESCRIPTION_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /never mention this block/i);
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /Model access is not character knowledge/);
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /Named knowledge boundaries bar protected information/);
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /discovery or disclosure/);
    assert.match(DEFAULT_INJECTION_INSTRUCTION, /Preserve stated extremes and rankings; lore norms are not ceilings/);
    assert.ok(DEFAULT_INJECTION_INSTRUCTION.length < 350);
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.includes(CONTINUITY_COVERAGE_RULES));
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.includes(EPISTEMIC_MEMORY_RULES));
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /category is "character belief"/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /without inferring a hidden answer/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Knowledge is non-transitive/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /separates objective truth from each focal holder's knowledge/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /Identity links are atomic/);
    assert.match(DEFAULT_EXTRACTION_SYSTEM_PROMPT, /still does not know each consequential hidden link/);
    assert.ok(!DEFAULT_EXTRACTION_SYSTEM_PROMPT.includes(PRE_ATOMIC_IDENTITY_L1_EPISTEMIC_COVERAGE_RULE));
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.includes(L1_EPISTEMIC_COVERAGE_RULE));
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
    assert.ok(DEFAULT_EXTRACTION_SYSTEM_PROMPT.length < 13400);
    assert.ok(DEFAULT_ARC_SYSTEM_PROMPT.length < 2300);
    assert.ok(DEFAULT_ERA_SYSTEM_PROMPT.length < 2300);
});

test('rolling snapshot is bounded, chronological, and sourced only from supplied Story material', () => {
    assert.match(ROLLING_STORY_RULE, /prior snapshot plus new chronological source material only/i);
    assert.match(ROLLING_STORY_RULE, /raw chat or explicitly labeled L1 scene summaries/i);
    assert.match(ROLLING_STORY_RULE, /never consult L2, L3, retrieval results, or other memory/i);
    assert.match(ROLLING_STORY_RULE, /Do not cite or name L1, L2, L3/i);
    assert.match(ROLLING_STORY_RULE, /Record only what has already occurred/i);
    assert.match(ROLLING_STORY_RULE, /do not write current, currently, present, latest, ongoing, now, or at present/i);
    assert.match(ROLLING_STORY_RULE, /plans and expectations belong only in openMatters and remain explicitly unresolved/i);
    assert.match(ROLLING_STORY_RULE, /one dense telegraphic sentence or fragment per array entry/i);
    assert.match(ROLLING_STORY_RULE, /compress wording, never causal meaning/i);
    assert.match(ROLLING_STORY_RULE, /Attribute beliefs, reports, deception, and uncertainty/i);
    assert.match(ROLLING_STORY_RULE, /Return exactly four arrays/i);
    assert.match(ROLLING_STORY_RULE, /premise: the earliest initiating facts/i);
    assert.match(ROLLING_STORY_RULE, /majorDevelopments: only major completed turning points in strict causal chronology/i);
    assert.match(ROLLING_STORY_RULE, /boundaryState: only durable conditions established at the end/i);
    assert.match(ROLLING_STORY_RULE, /openMatters: only unresolved central conflicts/i);
    assert.match(ROLLING_STORY_RULE, /never recency, position, message count, scene length, drama, or prose intensity/i);
    assert.match(ROLLING_STORY_RULE, /newest excerpt has no reserved share/i);
    assert.match(ROLLING_STORY_RULE, /ordinary completed scene normally needs one majorDevelopments entry/i);
    assert.match(ROLLING_STORY_RULE, /removing it would make a later identity/i);
    assert.match(ROLLING_STORY_RULE, /Aggressively collapse counts, percentages, measurements, colors/i);
    assert.match(ROLLING_STORY_RULE, /Retain an exact detail only when that exactness directly controls an unresolved choice/i);
    assert.match(ROLLING_STORY_RULE, /compression never permits weakening semantic magnitude/i);
    assert.ok(ROLLING_STORY_RULE.includes(EXTREME_SUMMARY_FIDELITY_RULE));
    assert.match(ROLLING_STORY_RULE, /combat forms, treatment, and other inventories/i);
    assert.match(ROLLING_STORY_RULE, /majorDevelopments spans the history rather than the newest scene/i);
    assert.match(ROLLING_STORY_RULE, /never end, truncate, or replace text with an ellipsis/i);
    assert.match(ROLLING_STORY_RULE, /overarching ambitions, hidden capabilities, identity secrets, asymmetric knowledge/i);
    assert.match(ROLLING_STORY_RULE, /Treat identity links as atomic/i);
    assert.match(ROLLING_STORY_RULE, /learning one name, alias, role, face, or piece of history does not reveal another undisclosed identity link/i);
    assert.match(ROLLING_STORY_RULE, /each consequential secret identity says exactly who knows which link/i);
    assert.match(ROLLING_STORY_RULE, /no event is duplicated/i);
    assert.match(ROLLING_STORY_RULE, /ownership and provenance remain unchanged/i);
    assert.match(ROLLING_STORY_RULE, /Preserve every unresolved explicit ultimatum or conditional threat/i);
    assert.match(ROLLING_STORY_RULE, /never soften death, destruction, loss, or a deadline/i);
    assert.match(ROLLING_STORY_RULE, /do not intensify injury into near-death/i);
    assert.match(ROLLING_STORY_RULE, /openMatters states each active ultimatum without euphemism/i);
    assert.match(ROLLING_STORY_TASK_TEMPLATE, /silent causal and detail-necessity checks/i);
    assert.match(ROLLING_STORY_TASK_TEMPLATE, /\{\{allowance\}\}/);
    assert.match(ROLLING_STORY_TASK_TEMPLATE, /\{\{targetMinimum\}\}/);
    assert.match(ROLLING_STORY_TASK_TEMPLATE, /\{\{targetMaximum\}\}/);
    assert.match(ROLLING_STORY_TASK_TEMPLATE, /\{\{characterBudget\}\}/);
    const storyTask = renderPromptTemplate(ROLLING_STORY_TASK_TEMPLATE, {
        allowance: 1280,
        targetMinimum: 870,
        targetMaximum: 1024,
        characterBudget: 3840,
        format: 'Return JSON.',
        prior: 'An older causal spine.',
        messages: '[0] A new event.',
    }, ['prior', 'messages']);
    assert.match(storyTask, /absolute limit of 1280 tokens/i);
    assert.match(storyTask, /870–1024 tokens/i);
    assert.match(storyTask, /3840 characters/i);
    assert.doesNotMatch(storyTask, /\{\{/);
    assert.match(DEFAULT_EXTRACTION_TASK_TEMPLATE, /chronicleEntry/i);
    assert.match(DEFAULT_EXTRACTION_TASK_TEMPLATE, /excerpt only/i);
    assert.match(CHRONICLE_ENTRY_RULE, /concealed information|who knows what/i);
    assert.doesNotMatch(buildExtractionSystemPrompt(DEFAULT_EXTRACTION_SYSTEM_PROMPT), /prior snapshot plus new chronological/i);
    assert.ok(buildExtractionSystemPrompt(DEFAULT_EXTRACTION_SYSTEM_PROMPT).includes(CHRONICLE_ENTRY_RULE));
});

test('final Story quality repair protects stakes and removes low-value inventory before save', () => {
    assert.match(ROLLING_STORY_QUALITY_RULE, /objective identity from what each character learned/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /never imply disclosure/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /active ultimatum with its actor, demanded action, and exact stated consequence/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /never replace an order with a warning/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /Never strengthen source severity or certainty/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /never normalize unprecedented, unique, record-breaking, or off-scale canon to merely high/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /Remove rosters, technique lists, injury lists/i);
    const repair = renderPromptTemplate(ROLLING_STORY_QUALITY_TASK_TEMPLATE, {
        allowance: 1500,
        characterBudget: 4500,
        format: 'Return schema-valid JSON.',
        prior: 'Premise: protected history.',
        candidate: 'Premise: draft.',
        messages: 'Development: authoritative evidence.',
        feedback: '(none)',
    }, ['prior', 'candidate', 'messages']);
    assert.match(repair, /PREVIOUS SAVED SNAPSHOT — PROTECTED BASELINE:\nPremise: protected history\./);
    assert.match(repair, /CANDIDATE COMPLETE SNAPSHOT:\nPremise: draft\./);
    assert.match(repair, /AUTHORITATIVE CHRONOLOGICAL EVIDENCE FOR THIS UPDATE:\nDevelopment: authoritative evidence\./);
    assert.match(repair, /VERIFIER FEEDBACK FROM THE PREVIOUS ATTEMPT:\n\(none\)/);
    assert.match(ROLLING_STORY_QUALITY_RULE, /Represent identity knowledge as exact links/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /must not be erased merely because the link remains hidden/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /previous saved snapshot is the protected baseline/i);
    assert.match(ROLLING_STORY_QUALITY_RULE, /Never silently reinterpret older history during continuation/i);
    assert.match(ROLLING_STORY_VERIFY_RULE, /learning that a former apprentice was named A does not mean learning B=A/i);
    assert.match(ROLLING_STORY_VERIFY_RULE, /hiding B=A never permits erasing that the name A was learned/i);
    assert.match(ROLLING_STORY_VERIFY_RULE, /relational rank normalized toward setting averages or records/i);
    const verification = renderPromptTemplate(ROLLING_STORY_VERIFY_TASK_TEMPLATE, {
        format: 'Return validation JSON.',
        prior: 'Toska learned the name Lucas Alcazar.',
        candidate: 'Toska knows the name Lucas.',
        messages: 'Toska does not know Lucifer is Lucas.',
    }, ['prior', 'candidate', 'messages']);
    assert.match(verification, /PREVIOUS SAVED SNAPSHOT — PROTECTED BASELINE:\nToska learned the name Lucas Alcazar\./);
    assert.match(verification, /CANDIDATE SNAPSHOT:\nToska knows the name Lucas\./);
    assert.match(verification, /AUTHORITATIVE CHRONOLOGICAL EVIDENCE:\nToska does not know Lucifer is Lucas\./);
});

test('default structured task prompts avoid repeating full schemas', () => {
    for (const template of [DEFAULT_EXTRACTION_TASK_TEMPLATE, DEFAULT_ARC_TASK_TEMPLATE, DEFAULT_ERA_TASK_TEMPLATE]) {
        assert.match(template, /\{\{format\}\}/);
        assert.doesNotMatch(template, /\{\{schema\}\}/);
    }
});
