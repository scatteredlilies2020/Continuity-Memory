import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderInjectionSections } from '../extension/injection-layout.js';
import { buildMemoryPrompt, prepareRetrievalCorpus } from '../extension/retrieval.js';
import { CHAT_KEY, recallWorld, recallCases } from '../scripts/fixtures/recall-world.mjs';
import { fingerprint, injectionEvidence } from './helpers/injection-layout-evidence.js';

const baseline = JSON.parse(readFileSync(new URL('./helpers/injection-layout-baseline.json', import.meta.url), 'utf8'));

for (const expected of baseline) {
    test(`consolidation preserves pre-change evidence and selection: ${expected.budget} / ${expected.scenario}`, async () => {
        const scenario = recallCases.find(item => item.name === expected.scenario);
        const world = recallWorld(100);
        const before = JSON.stringify(world);
        for (const prepared of [false, true]) {
            if (prepared) await prepareRetrievalCorpus(world);
            const result = buildMemoryPrompt(world, [{ is_user: true, mes: scenario.query }], expected.budget,
                CHAT_KEY, [], undefined, new Map(), scenario.options);
            assert.equal(fingerprint(injectionEvidence(result.prompt)), expected.evidence, 'every original non-heading detail survives');
            assert.equal(fingerprint(result.retrievalDiagnostics), expected.diagnostics, 'ranking, packing and provenance are unchanged');
            assert.equal(JSON.stringify(world), before, 'stored memories are untouched');
            assert.match(result.prompt, /\nStory so far:\n/);
        }
    });
}

test('consolidated groups preserve complete bodies, qualifiers, duplicates and within-category chronology', () => {
    const sections = [
        { title: 'Checkpoint', rows: ['- Location: the tower', '- Time: dusk'] },
        { title: 'User corrections', rows: [`- ${'Long correction. '.repeat(100)}COMPLETE_CORRECTION_END`] },
        { title: 'Knowledge boundaries — hard constraints', rows: ['- Sol does not know. [HARD LIMIT: world truth elsewhere does not grant this character knowledge.]'] },
        { title: 'Addresses', rows: ['- Mira→Sol: captain'] },
        { title: 'Established character knowledge', rows: ['- Mira knows the password.'] },
        { title: 'Recent continuity', rows: ['- A remembered scene.'] },
        { title: 'Supporting memories', rows: ['- [Historical observation — messages 8–15; rumored] A conditional plan, not a pending task.'] },
        { title: 'Entities', rows: ['- Mira: full profile; aliases: Keeper'] },
        { title: 'Current state', rows: ['- Mira — injury: a cut'] },
        { title: 'Last-known ongoing conditions (not reconfirmed)', rows: ['- [last-known; not confirmed current] Mira had the key.'] },
        { title: 'Relationships', rows: ['- Mira ↔ Sol: Description: Trust. Type: ally. Status: strained.'] },
        { title: 'Character perspectives (not established facts)', rows: ['- Sol believes amber. [subjective; not an established fact]'] },
        { title: 'Facts', rows: ['- Seal: only during an eclipse AND while its bearer is awake.'] },
        { title: 'Past events', rows: ['- First event: full cause.', '- Second event: full consequence.'] },
        { title: 'Supporting continuity', rows: ['- [fact] The source named a different holder.', '- [fact] The source named a different holder.'] },
        { title: 'Compact continuity ledger', rows: ['- Event ledger (latest): Later event'] },
    ];
    const before = structuredClone(sections);
    const result = renderInjectionSections(sections);
    const legacy = sections.map(section => `\n${section.title}:\n${section.rows.join('\n')}\n`).join('');
    assert.deepEqual(injectionEvidence(result), injectionEvidence(legacy));
    assert.deepEqual(sections, before);
    assert.deepEqual(result.split('\n').filter(line => /^(?:Memory constraints|Current context|Relevant details):$/u.test(line)),
        ['Memory constraints:', 'Current context:', 'Relevant details:']);
    assert.match(result, /\[Current state\] Mira — injury/);
    assert.match(result, /\[last-known; not confirmed current\]/);
    assert.match(result, /\[Established character knowledge\] Mira knows/);
    assert.match(result, /\[subjective; not an established fact\]/);
    assert.ok(result.indexOf('First event:') < result.indexOf('Second event:'));
});

test('layout has no empty headings and never discards unknown categories or multiline details', () => {
    assert.equal(renderInjectionSections([]), '');
    assert.equal(renderInjectionSections([{ title: 'Facts', rows: [] }]), '');
    const body = '- Complete first line\nSecond line with its own attribution.';
    assert.equal(renderInjectionSections([{ title: 'Future evidence type', rows: [body] }]),
        '\nRelevant details:\n- [Future evidence type] Complete first line\nSecond line with its own attribution.\n');
});
