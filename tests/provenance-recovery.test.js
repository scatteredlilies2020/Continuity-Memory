import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { assertAuthoritativeMetaProvenance, authoritativeMetaBoundaries, inWorldSourceEvidence, recoverAuthoritativeMetaProvenance } from '../extension/extraction-context.js';
import { assertCompleteExtractionRecords } from '../extension/extraction-contract.js';
import { captureScenarioContext } from '../extension/scenario-context.js';
import { validateExtractionProvenance } from '../extension/chronicle-provenance.js';
import { chronicleRetryFeedback, retryChroniclePromotion } from '../extension/chronicle-retry.js';

const messages = [
    { index: 20, name: 'Alice', isUser: true, text: 'OOC: The secret route is safe.\n\n"Good morning."' },
    { index: 21, name: 'Narrator', text: 'Alice waits beside the gate. Bob arrives with a lantern.' },
];
const boundaries = authoritativeMetaBoundaries(messages);
const evidence = inWorldSourceEvidence(messages);
const context = captureScenarioContext(messages);

test('raw statboxes and legacy source dumps cannot be accepted as C0 prose', () => {
    for (const chronicleEntry of ['<stat>Time = noon</stat>', '[Source message 424: Narrator] Full original response']) {
        assert.throws(() => assertCompleteExtractionRecords({ chronicleEntry }), { code: 'CM_INCOMPLETE_RECORDS' });
    }
});
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

test('Digest provenance failures never copy source prose or statboxes into C0', () => {
    const result = extraction();
    const before = structuredClone(result);
    assert.throws(() => recoverAuthoritativeMetaProvenance(result, boundaries, evidence, context, messages), {code:'CM_OOC_PROVENANCE'});
    assert.deepEqual(result,before);
});

test('Digest source review rejects invented knowledge without modifying the candidate', async () => {
    const result=extraction(); const before=structuredClone(result);
    await assert.rejects(validateExtractionProvenance(result,messages,[], async prompt => {
        const data=JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2));
        return {assessments:[...new Set(data.flags.map(f=>f.sentence))].map(sentence=>({sentence,violation:true,reason:'Only the author note establishes this.',evidence:[]}))};
    }), {code:'CM_OOC_PROVENANCE'});
    assert.deepEqual(result,before);
});

test('author-only excerpts retain boundaries for review rather than inventing a source account', async () => {
    const source=[{...messages[0],text:'OOC: The secret route is safe.'}];
    await assert.rejects(validateExtractionProvenance(extraction(),source,[],async () => ({assessments:[]})), {code:'CM_PROVENANCE_REVIEW_INVALID'});
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

test('source-grounded Digest review accepts a false positive without replacing prose', async () => {
    const source = [
        { index: 405, name: 'Elsa', isUser: true, text: 'OOC: Advance to lunch later.' },
        { index: 406, name: 'Re Zero', text: 'Rem folds the cloth. "After lunch, if Ram agrees," she answers. "The west guest room, three doors down."' },
    ];
    const result=extraction(); result.facts=[safeFact]; result.scene.activity='Rem folds a cloth.';
    result.sceneCapsule={title:'Lunch',opening:'Rem folds a cloth.',beats:[],closing:''};
    result.chronicleEntry='Rem says later if Ram agrees and gives the west guest room three doors down, then reflects that the child copies her sister.';
    const before=structuredClone(result);
    await validateExtractionProvenance(result,source,[],async prompt=>{
        const data=JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2));
        return {assessments:[...new Set(data.flags.map(f=>f.sentence))].map(sentence=>({sentence,violation:false,reason:'The source establishes the lunch dialogue.',evidence:[{source:1,quote:'After lunch, if Ram agrees'}]}))};
    });
    assert.deepEqual(result,before);
    assert.doesNotMatch(result.chronicleEntry,/Source message|<stat>/);
});

for(const file of ['extension/engine.js','plugin/detached-jobs.js']) test(file+' reviews Digest output before and after reconciliation without source fallback',async()=>{
    const code=await readFile(new URL('../'+file,import.meta.url),'utf8');
    assert.doesNotMatch(code,/recoverAuthoritativeMetaProvenance/);
    const calls=code.match(/await validateExtractionProvenance\(/g)||[];
    assert.equal(calls.length,2);
    assert.ok(code.indexOf('await validateExtractionProvenance') < code.indexOf('= validateResult(parsed'));
});
