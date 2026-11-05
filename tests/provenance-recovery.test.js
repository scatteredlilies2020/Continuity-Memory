import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { assertAuthoritativeMetaProvenance, authoritativeMetaBoundaries, inWorldSourceEvidence, recoverAuthoritativeMetaProvenance } from '../extension/extraction-context.js';
import { assertCompleteExtractionRecords } from '../extension/extraction-contract.js';
import { captureScenarioContext } from '../extension/scenario-context.js';
import { chronicleRetryFeedback, retryChroniclePromotion } from '../extension/chronicle-retry.js';

const messages = [
    { index: 20, name: 'Alice', isUser: true, text: 'OOC: The secret route is safe.\n\n"Good morning."' },
    { index: 21, name: 'Narrator', text: 'Alice waits beside the gate. Bob arrives with a lantern.' },
];
const boundaries = authoritativeMetaBoundaries(messages);
const evidence = inWorldSourceEvidence(messages);
const context = captureScenarioContext(messages);
const unsupported = 'Bob learned the secret route was safe.';
const safeFact = { subject: 'Bob', predicate: 'carries', value: 'a lantern', category: 'possession' };
function extraction() {
    return {
        entities: [], facts: [safeFact, { subject: 'Bob', predicate: 'knowledge', value: unsupported, category: 'knowledge' }],
        states: [], relationships: [], events: [], threads: [], backgrounds: [],
        scene: { location: 'gate', activity: unsupported },
        sceneCapsule: { title: 'Arrival', opening: unsupported, beats: [unsupported], closing: '' },
        chronicleEntry: unsupported,
    };
}

test('uncertain provenance preserves the complete source and safe records without throwing or inventing canon', () => {
    const result = extraction();
    const recovery = recoverAuthoritativeMetaProvenance(result, boundaries, evidence, context, messages);
    assert.ok(recovery.conflicts);
    assert.equal(recovery.withheldRecords, 1);
    assert.deepEqual(result.facts, [safeFact]);
    assertCompleteExtractionRecords(result);
    assert.doesNotMatch(JSON.stringify(result), /Bob learned/);
    assert.match(result.chronicleEntry, /Source message 20: Alice/);
    assert.match(result.chronicleEntry, /Alice waits beside the gate/);
    assert.match(result.chronicleEntry, /Author-level context: OOC: The secret route is safe/);
    assert.ok(result.sceneCapsule.opening);
    assertAuthoritativeMetaProvenance(result, boundaries, evidence);
    const before = structuredClone(result);
    assert.equal(recoverAuthoritativeMetaProvenance(result, boundaries, evidence, context, messages).conflicts, 0);
    assert.deepEqual(result, before, 'Repeated validation must not duplicate or erase the source fallback.');
});

test('OOC-only extraction retains author canon in its original scope', () => {
    const source = messages.slice(0, 1).map(message => ({ ...message, text: 'OOC: The secret route is safe.' }));
    const result = extraction();
    recoverAuthoritativeMetaProvenance(result, authoritativeMetaBoundaries(source), [], captureScenarioContext(source), source);
    assert.match(result.chronicleEntry, /^Author-level context: OOC: The secret route is safe/);
    assert.doesNotMatch(JSON.stringify(result), /Bob learned/);
    assertCompleteExtractionRecords(result);
});

test('Chronicle provenance uncertainty requests correction without rewriting the generated parent', () => {
    const result = { title: unsupported, summary: unsupported, participants: ['Alice', 'Bob'], turningPoints: [unsupported, 'Bob arrives.'], openThreads: [] };
    const before = structuredClone(result);
    assert.throws(() => recoverAuthoritativeMetaProvenance(result, boundaries, evidence), { code: 'CM_OOC_PROVENANCE' });
    assert.deepEqual(result, before, 'Validation must not replace the summary or rewrite its detail fields.');
});

test('Chronicle correction saves model-written prose, never a source concatenation', async () => {
    const sourcesBefore = JSON.stringify({ boundaries, evidence });
    let calls = 0;
    const corrected = { title: 'Arrival', summary: 'Bob arrives at the gate with a lantern.', participants: ['Bob'], turningPoints: [], openThreads: [] };
    const accepted = await retryChroniclePromotion(previous => {
        calls++;
        if (previous) {
            assert.equal(previous.code, 'CM_OOC_PROVENANCE');
            const feedback = chronicleRetryFeedback(previous);
            assert.match(feedback, /author notes must not become character speech/);
            assert.match(feedback, /do not paste the source nodes back/);
        }
        const result = calls === 1 ? { ...corrected, summary: unsupported } : structuredClone(corrected);
        recoverAuthoritativeMetaProvenance(result, boundaries, evidence);
        return result;
    }, { wait: async () => {} });
    assert.equal(calls, 2);
    assert.deepEqual(accepted, corrected);
    assert.notEqual(accepted.summary, evidence.join('\n\n'));
    assert.equal(JSON.stringify({ boundaries, evidence }), sourcesBefore);
});

test('persistent Chronicle attribution failures stop without copying or modifying sources', async () => {
    const result = { title: 'Arrival', summary: unsupported, turningPoints: [] };
    const before = JSON.stringify({ result, boundaries, evidence });
    let calls = 0;
    await assert.rejects(retryChroniclePromotion(() => {
        calls++;
        recoverAuthoritativeMetaProvenance(result, boundaries, evidence);
    }, { wait: async () => {} }), error => error.code === 'CONTINUITY_INVALID_RESPONSE' && error.cause.code === 'CM_OOC_PROVENANCE');
    assert.equal(calls, 3);
    assert.equal(JSON.stringify({ result, boundaries, evidence }), before);
});

test('source-supported output remains unchanged', () => {
    const result = { summary: 'Alice waits beside the gate. Bob arrives with a lantern.' };
    const before = structuredClone(result);
    assert.equal(recoverAuthoritativeMetaProvenance(result, boundaries, evidence).conflicts, 0);
    assert.deepEqual(result, before);
});

test('lunch stage directions overlapping ordinary Rem dialogue recover without another extraction', () => {
    const source = [
        { index: 405, name: 'Elsa', isUser: true, text: 'OOC: Advance to lunch later.' },
        { index: 406, name: 'Re Zero', text: 'Rem folds the cloth. "After lunch, if Ram agrees," she answers. "The west guest room, three doors down."' },
    ];
    const result = extraction();
    result.facts = [safeFact];
    result.chronicleEntry = 'Rem says later if Ram agrees and gives the west guest room three doors down, then reflects that the child copies her sister.';
    const scope = authoritativeMetaBoundaries(source);
    const excerpts = inWorldSourceEvidence(source);
    assert.throws(() => assertAuthoritativeMetaProvenance(result, scope, excerpts), /OOC provenance violation/);
    assert.ok(recoverAuthoritativeMetaProvenance(result, scope, excerpts, captureScenarioContext(source), source).conflicts);
    assert.match(result.chronicleEntry, /After lunch, if Ram agrees/);
    assert.deepEqual(result.facts, [safeFact]);
    assertAuthoritativeMetaProvenance(result, scope, excerpts);
});

for (const file of ['extension/engine.js', 'plugin/detached-jobs.js']) test(`${file} recovers provenance before and after reconciliation`, async () => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /assertAuthoritativeMetaProvenance/, 'Every production path, including Chronicle saves, must use recovery.');
    const validate = source.match(/^function validateResult\([^]*?^}/m)[0];
    const result = extraction();
    const validated = runInNewContext(`${validate}\nvalidateResult(result, {}, messages)`, {
        result, messages, authoritativeMetaBoundaries, inWorldSourceEvidence, recoverAuthoritativeMetaProvenance,
        captureScenarioContext, assertCompleteExtractionRecords,
        migrateLegacyBeliefs: () => {},
        sanitizeReconciliationMetadata: candidate => {
            assert.doesNotMatch(JSON.stringify(candidate), /Bob learned/, 'First recovery runs before reconciliation.');
            candidate.relationships = [{ from: 'Alice', to: 'Bob', dynamic: unsupported }];
            return {};
        },
    });
    assert.equal(validated.result.relationships.length, 0, 'Reconciliation must not reintroduce an unsafe generated record.');
    assert.match(validated.validation.warnings[0], /source account/);
    assert.deepEqual(validated.result._sourceScenarioContext, context);
    assertAuthoritativeMetaProvenance(validated.result, boundaries, evidence);
});
