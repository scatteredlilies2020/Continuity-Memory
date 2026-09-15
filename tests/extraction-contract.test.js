import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompleteExtractionRecords, extractionSchema, EXTRACTION_FIELD_GUIDE, EXTRACTION_COMPLETENESS_RULE, extractionCompletenessFeedback } from '../extension/extraction-contract.js';
import { buildExtractionSystemPrompt } from '../extension/prompts.js';

const fact = { subject: 'Alice', predicate: 'takes tea', value: 'without sugar', category: 'preference' };
for (const field of ['subject', 'predicate', 'value', 'category']) {
    test(`rejects blank fact ${field} without discarding its valid peer`, () => {
        const result = { facts: [fact, { ...fact, [field]: '  ' }] };
        const before = structuredClone(result);
        assert.throws(() => assertCompleteExtractionRecords(result), { code: 'CM_INCOMPLETE_RECORDS' });
        assert.deepEqual(result, before);
        assert.equal(extractionSchema.properties.facts.items.properties[field].pattern, '\\S');
    });
}
test('empty categories and unknown optional details remain valid', () => {
    assertCompleteExtractionRecords({ entities: [], facts: [fact], states: [], relationships: [], events: [], threads: [], backgrounds: [] });
    assertCompleteExtractionRecords({ entities: [{ name: 'Alice', type: 'person', description: '', characterProfile: { roleBackground: [], ageDemographics: [], appearance: [], personalityQuirks: [] } }], events: [{ title: 'Tea', summary: 'Alice makes tea.', storyTime: '', location: '', consequences: '' }] });
});
test('clear remains explicit and blank set cannot erase a state', () => {
    const state = { subject: 'Alice', attribute: 'carrying', value: '', previous: '' };
    assertCompleteExtractionRecords({ states: [{ ...state, operation: 'clear' }] });
    for (const operation of ['set', undefined]) assert.throws(() => assertCompleteExtractionRecords({ states: [{ ...state, operation }] }), /value \(set\)/);
});
for (const [category, record] of Object.entries({
    entities: { name: '', type: 'person' },
    relationships: { from: 'Alice', to: 'Bob', dynamic: '' },
    events: { title: 'Tea', summary: '' },
    threads: { title: 'Promise', detail: '' },
    backgrounds: { topic: 'Road', summary: '' },
    identityResolutions: { reference: 'the traveler', canonical: 'Alice', evidence: '' },
    recordMerges: { canonicalId: 'f1', evidence: 'Same preference.', duplicateIds: [] },
})) test(`rejects incomplete ${category}`, () => {
    assert.throws(() => assertCompleteExtractionRecords({ [category]: [record] }), { code: 'CM_INCOMPLETE_RECORDS' });
});
test('legacy relationship description remains replayable', () => {
    assertCompleteExtractionRecords({ relationships: [{ from: 'Alice', to: 'Bob', description: 'Alice trusts Bob.' }] });
});
test('prompt-only contract uses field definitions, including array profiles and nonblank content', () => {
    const guide = JSON.parse(EXTRACTION_FIELD_GUIDE.slice(EXTRACTION_FIELD_GUIDE.indexOf('{')));
    assert.equal(guide.facts.emptyArrayAllowed, true);
    assert.equal(guide.facts.arrayOf.value, 'string (nonblank)');
    assert.equal(guide.entities.arrayOf.characterProfile.ageDemographics.emptyArrayAllowed, true);
    assert.equal(guide.states.arrayOf.value.includes('clear'), true);
    assert.ok(buildExtractionSystemPrompt('Custom extraction instructions').includes(EXTRACTION_COMPLETENESS_RULE));
});
test('bounded retry explains the missing fields without echoing source content', () => {
    let failure;
    try { assertCompleteExtractionRecords({ facts: [{ ...fact, value: '' }] }); } catch (error) { failure = error; }
    assert.match(extractionCompletenessFeedback(failure), /facts\[0\].value/);
    assert.doesNotMatch(extractionCompletenessFeedback(failure), /Alice/);
    assert.equal(extractionCompletenessFeedback(new Error('Network failed')), '');
});

test('browser extraction rejects incomplete records before reconciliation or saving', async () => {
    const { readFileSync } = await import('node:fs');
    const { runInNewContext } = await import('node:vm');
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const result = { facts: [{ ...fact, value: '' }] };
    assert.throws(() => runInNewContext(engine.match(/function validateResult\([^]*?^}/m)[0] + '\nvalidateResult(result, {}, []);', {
        result, assertCompleteExtractionRecords, migrateLegacyBeliefs: () => {},
        sanitizeReconciliationMetadata: () => assert.fail('Incomplete output reached reconciliation'),
    }), { code: 'CM_INCOMPLETE_RECORDS' });
});
