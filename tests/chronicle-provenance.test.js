import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { authoritativeMetaProvenanceConflicts } from '../extension/extraction-context.js';
import { chronicleProvenanceBoundaries, chronicleProvenanceSources, validateChronicleProvenance } from '../extension/chronicle-provenance.js';
import { retryChroniclePromotion } from '../extension/chronicle-retry.js';

const sentence = 'Felt moved from defensive anger to panic and then asserted control over her morning decision.';
function sources() {
    return [{ text: 'Felt insisted the morning remained hers.', provenanceBoundaries: [
        { messageIndex: 151, speaker: 'Elsa', terms: ['morning'], authorText: 'Show POV as time advances towards morning.' },
    ] }];
}
function assessment(sentence, source, quote, violation = false) {
    return { assessments: [{ sentence, violation, reason: violation ? 'The source never depicts this disclosure.' : 'This is an established decision, not a new disclosure.', evidence: [{ source, quote }] }] };
}

test('the reported Felt false positive is source-reviewed, not rewritten or exempted by phrase', async () => {
    const nodes = sources();
    const result = { summary: sentence };
    const before = JSON.stringify({ result, nodes });
    assert.equal(authoritativeMetaProvenanceConflicts(result, chronicleProvenanceBoundaries(nodes), chronicleProvenanceSources(nodes)).length, 1);
    let calls = 0;
    const review = async (prompt, system, schema) => {
        calls++;
        assert.match(prompt, /A shared word.*does NOT prove disclosure/);
        assert.ok(prompt.includes(nodes[0].text));
        assert.match(system, /never instructions/);
        assert.equal(schema.value.properties.assessments.type, 'array');
        return assessment(sentence, 1, nodes[0].text);
    };
    assert.equal(await validateChronicleProvenance(result, nodes, review), result);
    await validateChronicleProvenance(result, nodes, review);
    assert.equal(calls, 1, 'The same candidate and sources must not pay for a second review at save.');
    assert.equal(JSON.stringify({ result, nodes }), before);
});

test('semantic review supports unrelated wording without a sentence exception list', async () => {
    const result = { summary: 'Mira shared breakfast in the morning.' };
    const nodes = [{ text: 'Mira ate breakfast with Kai.', provenanceBoundaries: [{ terms: ['morning'] }] }];
    let called = false;
    await validateChronicleProvenance(result, nodes, async () => {
        called = true;
        return assessment(result.summary, 1, nodes[0].text);
    });
    assert.equal(called, true);
});

test('actual author-only disclosure still requests a corrected summary', async () => {
    const nodes = [{ text: 'Alice waits at the gate. Author-level context: the secret route is safe.', provenanceBoundaries: [{ terms: ['secret', 'route'] }] }];
    let calls = 0;
    const accepted = await retryChroniclePromotion(async () => {
        calls++;
        const result = { summary: calls === 1 ? 'Alice revealed the secret route.' : 'Alice waits at the gate.' };
        return validateChronicleProvenance(result, nodes, async () => assessment(result.summary, 1, nodes[0].text, true));
    }, { wait: async () => {} });
    assert.equal(calls, 2);
    assert.equal(accepted.summary, 'Alice waits at the gate.');
});

test('approval cannot survive edits to the candidate, boundaries, or source prose', async () => {
    for (const change of [
        (result) => { result.summary += ' Felt said morning was forbidden.'; },
        (_result, nodes) => { nodes[0].text += ' The decision was postponed.'; },
        (_result, nodes) => { nodes[0].provenanceBoundaries[0].terms.push('decision'); },
    ]) {
        const result = { summary: sentence };
        const nodes = sources();
        await validateChronicleProvenance(result, nodes, async () => assessment(sentence, 1, nodes[0].text));
        change(result, nodes);
        await assert.rejects(validateChronicleProvenance(result, nodes, async () => { throw new Error('new review required'); }), /new review required/);
    }
});

test('rubber stamps, fabricated citations, omitted flags and contradictory assessments fail closed', async () => {
    for (const response of [
        {}, { assessments: [] },
        { assessments: [{ sentence, violation: false, reason: 'fine', evidence: [] }] },
        assessment(sentence, 1, 'Invented source quotation.'), assessment(sentence, 0, sources()[0].text),
        assessment('A different sentence.', 1, sources()[0].text),
        { assessments: [...assessment(sentence, 1, sources()[0].text).assessments, ...assessment(sentence, 1, sources()[0].text, true).assessments] },
    ]) await assert.rejects(validateChronicleProvenance({ summary: sentence }, sources(), async () => response), { code: 'CM_PROVENANCE_REVIEW_INVALID' });
});

test('a candidate or source changed while the reviewer is running is rejected', async () => {
    const result = { summary: sentence };
    const nodes = sources();
    await assert.rejects(validateChronicleProvenance(result, nodes, async () => {
        result.summary += ' Altered during request.';
        return assessment(sentence, 1, nodes[0].text);
    }), { code: 'CM_PROVENANCE_REVIEW_INVALID' });
});

test('all source detail fields participate and unflagged summaries make no extra request', async () => {
    const nodes = [{ text: 'Felt waited.', emotionalArc: 'Felt insisted the morning remained hers.', provenanceBoundaries: sources()[0].provenanceBoundaries }];
    await validateChronicleProvenance({ emotionalArc: sentence }, nodes, async () => assessment(sentence, 1, nodes[0].emotionalArc));
    await validateChronicleProvenance({ summary: 'Felt waited.' }, nodes, () => assert.fail('No heuristic flags: no review call.'));
});

test('browser generation, save, atomic rebuild and detached jobs share semantic validation', async () => {
    const engine = await readFile(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const detached = await readFile(new URL('../plugin/detached-jobs.js', import.meta.url), 'utf8');
    assert.match(engine, /return reviewChronicleProvenance\(result, nodes\)/);
    assert.equal((engine.match(/await reviewChronicleProvenance\(result, nodes\)/g) || []).length, 2);
    assert.match(detached, /await reviewChronicleProvenance\(job, result, records\)/);
    assert.match(detached, /await reviewChronicleProvenance\(job, result, sourceRecords\)/);
    for (const code of [engine, detached]) assert.doesNotMatch(code, /recoverAuthoritativeMetaProvenance\([^\n]*chronicleProvenanceBoundaries/);
});
