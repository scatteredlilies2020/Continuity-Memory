import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digestNarrativeIssue, digestRepairInstruction } from '../extension/digest-repair.js';
import { selectCorrectionContext, correctionDigestSources, validateCorrectionProposal, applyCorrectionProposal, augmentCorrectionChronology } from '../extension/memory-correction.js';
import { collectFingerprintMessages } from '../extension/message-digest.js';
import { syncChronicleBase, addChroniclePromotion, chronicleTextFromCapsule } from '../extension/chronicle.js';
import { planContinuityRecheck, runContinuityRecheck, applyContinuityRecheck, RECHECK_PROMPT } from '../extension/continuity-recheck.js';

function fixture() {
    const capsule = { id: 'Digest-damaged-0-1', chatKey: 'chat', from: 0, to: 1, title: 'Arrival', storyTime: 'Morning',
        opening: 'Alice arrives at the inn.', beats: ['Bob greets Alice.'], closing: 'They sit down.', chronicleText: 'R', importance: 3,
        participants: ['Alice', 'Bob'], sources: [{ chatKey: 'chat', from: 0, to: 1 }] };
    const second = { ...capsule, id: 'Digest-safe-2-3', from: 2, to: 3, chronicleText: 'Alice and Bob talk at the table.',
        sources: [{ chatKey: 'chat', from: 2, to: 3 }] };
    const world = { id: 'world', revision: 1, capsules: [capsule, second], chronicle: [], facts: [], entities: [], states: [], events: [],
        relationships: [], threads: [], backgrounds: [], extractions: [], corrections: [], arcs: [], eras: [], storySoFar: {}, sources: {} };
    syncChronicleBase(world); // The rebuilt C0 is already healthy; stored Digest is not.
    addChroniclePromotion(world, { title: 'Meeting', summary: 'Alice arrives and sits with Bob.' }, world.chronicle.slice());
    return world;
}
const messages = [{ index: 0, name: 'Alice', isUser: true, text: 'Alice arrives at the inn.' },
    { index: 1, name: 'Bob', isUser: false, text: 'Bob greets Alice. They sit down.' },
    { index: 2, name: 'Alice', isUser: true, text: 'Alice asks Bob how he is.' },
    { index: 3, name: 'Bob', isUser: false, text: 'Bob says he is well.' }];
const review = records => ({ reviewedKeys: records.map(entry => entry.key), changes: [], issues: [], contextRanges: [] });

test('Digest diagnostics distinguish damaged stored narratives from intentional source fallback', () => {
    for (const value of ['R', ' !R! ', '...', 7, null, {}, ' ']) assert.match(digestNarrativeIssue({ chronicleText: value }), /Malformed/);
    for (const value of [undefined, '', '到家', 'Alice arrives.']) assert.equal(digestNarrativeIssue({ chronicleText: value }), '');
});

test('Repair Digest instructions target the exact record, without relying on generic lexical matches', () => {
    const world = fixture(), target = world.capsules[0], instruction = digestRepairInstruction(target);
    world.capsules.push({ ...target, id: 'other-digest', chronicleText: 'S' });
    world.facts.push({ id: 'unrelated-fact', subject: 'Repair Digest', value: 'Unrelated repair vocabulary.' });
    const candidates = selectCorrectionContext(world, instruction, { chatKey: 'chat' });
    assert.deepEqual(candidates.map(item => item.id), [target.id]);
    assert.equal(candidates[0].record.chronicleText, 'R');
    assert.match(candidates[0].structuralIssues[0], /Malformed/);
    assert.deepEqual(candidates[0].sourceRange, { chatKey: 'chat', from: 0, to: 1 });
    assert.match(instruction, /original zero-based/);
});

test('typed Digest message ranges select only an exact local range, never an overlapping or foreign range', () => {
    const world = fixture(), original = world.capsules[0];
    world.capsules.push({ ...original, id: 'overlap', from: 1, to: 2 }, { ...original, id: 'foreign', chatKey: 'other' });
    const candidates = selectCorrectionContext(world, 'Repair Digest messages 0–1', { chatKey: 'chat' });
    assert.deepEqual(candidates.map(item => item.id), [original.id]);
    assert.equal(selectCorrectionContext(world, 'Repair Digest messages 9–10', { chatKey: 'chat' }).length, 0);
});

test('generic damaged-Digest repair requests surface defects even with no matching narrative words', () => {
    const world = fixture();
    assert.equal(selectCorrectionContext(world, 'fix broken digest', { chatKey: 'chat' })[0].id, world.capsules[0].id);
});

test('narrative-only repair preserves omitted long Digest prose and lists exactly', () => {
    const world = fixture(), target = world.capsules[0];
    target.opening = '  Original prose.\n'.repeat(500);
    target.beats = Array.from({ length: 12 }, (_, index) => `${index}: ${'Unabridged beat. '.repeat(100)}`);
    const before = structuredClone(target);
    const proposal = validateCorrectionProposal(world, { summary: 'Repair narrative only', operations: [{ action: 'update', category: 'capsules',
        targetId: target.id, record: { chronicleText: 'Alice arrives and sits with Bob.' } }] });
    assert.equal(proposal.operations[0].replacement.opening, before.opening);
    assert.deepEqual(proposal.operations[0].replacement.beats, before.beats);
    applyCorrectionProposal(world, proposal, { chatKey: 'chat' });
    assert.equal(world.capsules[0].opening, before.opening);
    assert.deepEqual(world.capsules[0].beats, before.beats);
});

test('targeted correction supplies complete local evidence and explicitly identifies missing and cross-chat sources', () => {
    const world = fixture(), original = world.capsules[0];
    const candidates = selectCorrectionContext(world, digestRepairInstruction(original));
    const long = messages.slice(0, 2).map(message => ({ ...message, text: message.text + ' Original prose.'.repeat(5000) }));
    assert.deepEqual(correctionDigestSources(candidates, long, 'chat').originalMessages, long);
    assert.deepEqual(correctionDigestSources(candidates, messages, 'other').unavailableDigestIds, [original.id]);
    assert.deepEqual(correctionDigestSources(candidates, messages.slice(0, 1), 'chat').originalMessages, []);
});

test('reviewed correction repairs chronicleText explicitly and keeps a durable replay baseline', () => {
    const world = fixture(), original = structuredClone(world.capsules[0]), narrative = world.chronicle[0].text;
    const proposal = validateCorrectionProposal(world, { summary: 'Restore the damaged Digest narrative.', operations: [{ action: 'update',
        category: 'capsules', targetId: original.id, recordJson: JSON.stringify({ chronicleText: narrative }), reason: 'Intact source prose.' }] }, digestRepairInstruction(original));
    assert.equal(proposal.operations[0].preserveChronicleText, true);
    assert.equal(world.capsules[0].chronicleText, 'R'); // Review is not apply.
    const result = applyCorrectionProposal(world, proposal);
    const repaired = world.capsules[0];
    assert.equal(repaired.chronicleText, narrative);
    for (const field of ['id', 'from', 'to', 'chatKey', 'opening', 'beats', 'closing']) assert.deepEqual(repaired[field], original[field]);
    assert.equal(result.correction.operations[0].afterRecord.chronicleText, narrative);
    assert.equal(result.invalidatedChronicle, 0); // Same effective C0 narrative.
    assert.equal(world.chronicle.length, 3);
});

test('correction narrative repair rejects placeholders and preserves complete long replacements', () => {
    const world = fixture(), before = structuredClone(world);
    const proposal = value => ({ summary: 'Repair Digest', operations: [{ action: 'update', category: 'capsules', targetId: world.capsules[0].id,
        recordJson: JSON.stringify({ chronicleText: value }) }] });
    for (const value of ['C', '...', null, 2]) assert.throws(() => validateCorrectionProposal(world, proposal(value)), /complete prose/);
    assert.deepEqual(world, before);
    const narrative = 'Alice arrives at the inn. '.repeat(400);
    assert.equal(validateCorrectionProposal(world, proposal(narrative)).operations[0].replacement.chronicleText, narrative);
    assert.equal(validateCorrectionProposal(world, proposal('')).operations[0].preserveChronicleText, true);
});

test('Recheck sees the raw damaged Digest despite an already healthy C0 and applies a reviewed source-grounded repair', async () => {
    const world = fixture(), before = structuredClone(world), narrative = world.chronicle[0].text;
    const proposal = await runContinuityRecheck({ world, messages, chatKey: 'chat', request: async prompt => {
        const { records, originalMessages } = JSON.parse(prompt), digest = records.find(entry => entry.target.category === 'capsules');
        assert.equal(digest.fields.find(field => field.key === 'chronicleText').value, 'R');
        assert.match(digest.structuralIssues[0], /Malformed/);
        assert.deepEqual(originalMessages, messages);
        return { ...review(records), changes: [{ key: digest.key, patchJson: JSON.stringify({ chronicleText: narrative }),
            reason: 'Original RP verifies the preserved Digest prose.', evidence: [0, 1] }] };
    } });
    assert.equal(proposal.changes.length, 1);
    assert.equal(proposal.issues.length, 0);
    assert.deepEqual(world, before);
    const result = applyContinuityRecheck(world, proposal, { chatKey: 'chat', to: 1 });
    assert.equal(result.changed, 1);
    assert.equal(result.world.capsules[0].chronicleText, narrative);
    assert.deepEqual(result.world.chronicle, world.chronicle);
    assert.deepEqual(result.world.corrections[0].recheckEvidence.indices, [0, 1]);
});

test('Recheck cannot silently approve an unrepaired malformed Digest or override a standing correction', async () => {
    const world = fixture();
    world.capsules[0].correctionId = 'standing-correction';
    const proposal = await runContinuityRecheck({ world, messages, chatKey: 'chat', request: async prompt => review(JSON.parse(prompt).records) });
    assert.equal(proposal.changes.length, 0);
    assert.match(proposal.issues.find(issue => issue.key.includes(world.capsules[0].id)).detail, /Unresolved: Malformed/);
    assert.equal(world.capsules[0].chronicleText, 'R');
});

test('Recheck can explicitly clear a damaged narrative to use intact prose and cannot replace it with another letter', async () => {
    const world = fixture();
    const request = value => async prompt => {
        const records = JSON.parse(prompt).records, digest = records.find(entry => entry.target.category === 'capsules');
        return { ...review(records), changes: [{ key: digest.key, patchJson: JSON.stringify({ chronicleText: value }), reason: 'Use verified intact prose.', evidence: [0] }] };
    };
    await assert.rejects(runContinuityRecheck({ world, messages, chatKey: 'chat', request: request('C') }), /complete prose/);
    const proposal = await runContinuityRecheck({ world, messages, chatKey: 'chat', request: request('') });
    assert.equal(proposal.issues.length, 0);
    const result = applyContinuityRecheck(world, proposal, { chatKey: 'chat', to: 1 });
    assert.equal(result.world.capsules[0].chronicleText, '');
    assert.equal(chronicleTextFromCapsule(result.world.capsules[0]), world.chronicle[0].text);
});

test('unavailable Digest evidence remains explicitly unreviewed, and repair UI stages a request rather than executing it', () => {
    const world = fixture();
    assert.equal(planContinuityRecheck(world, [], 'chat').unavailable, 3);
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(ui, /text\('Repair Digest'\)/);
    assert.match(ui, /val\(digestRepairInstruction\(digest\)\)/);
    assert.match(RECHECK_PROMPT, /check it even when opening\/beats\/closing and the derived C0 are correct/);
});

function engineReview(world, requestStructured) {
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const source = engine.match(/export async function reviewMemoryCorrection\([^]*?^}/m)[0].replace(/^export /, '');
    const deps = { runtime: { world, health: { schemaVersion: 7 }, generation: 0, paused: true },
        getContext: () => ({ chat: messages.map(message => ({ mes: message.text, name: message.name, is_user: message.isUser })) }),
        getBoundWorldId: () => world.id, getChatKey: () => 'chat', getSettings: () => ({}),
        selectCorrectionContext, correctionDigestSources, collectFingerprintMessages, validateCorrectionProposal, augmentCorrectionChronology,
        resolveCorrectionResponseTokens: () => 8000, DIRECT_PROFILE_ID: 'direct', CORRECTION_SYSTEM_PROMPT: 'Repair.',
        correctionJsonSchema: {}, updateRuntime: () => {}, requestStructured, parseJsonResponse: JSON.parse };
    return new Function(...Object.keys(deps), `${source}; return reviewMemoryCorrection;`)(...Object.values(deps));
}

test('Correct memory engine routes a targeted Digest repair with raw damage and original source evidence, without saving', async () => {
    const world = fixture(), before = structuredClone(world);
    const reviewCorrection = engineReview(world, async prompt => {
        assert.ok(prompt.includes('"chronicleText":"R"'));
        assert.ok(prompt.includes('"originalMessages":[{"index":0'));
        assert.ok(prompt.includes(messages[1].text));
        assert.ok(!prompt.includes('Digest-safe-2-3'));
        return { summary: 'Repair the damaged Digest narrative.', operations: [{ action: 'update', category: 'capsules',
            targetId: world.capsules[0].id, recordJson: JSON.stringify({ chronicleText: world.chronicle[0].text }) }] };
    });
    const proposal = await reviewCorrection(digestRepairInstruction(world.capsules[0]));
    assert.equal(proposal.operations[0].preserveChronicleText, true);
    assert.equal(proposal.baseRevision, world.revision);
    assert.deepEqual(world, before);
});

test('targeted Correct memory review rejects model changes outside its selected candidates', async () => {
    const world = fixture();
    world.facts.push({ id: 'unrelated-fact', subject: 'Bob', predicate: 'occupation', value: 'A musician.' });
    const reviewCorrection = engineReview(world, async () => ({ summary: 'Unrelated rewrite.', operations: [{ action: 'update', category: 'facts',
        targetId: 'unrelated-fact', recordJson: JSON.stringify({ value: 'A baker.' }) }] }));
    await assert.rejects(reviewCorrection(digestRepairInstruction(world.capsules[0])), /only update the selected Digest/);
    assert.equal(world.facts[0].value, 'A musician.');
});

test('Digest repair review rejects additions and deletions rather than expanding its scope', async () => {
    const world = fixture();
    for (const operation of [
        { action: 'add', category: 'facts', record: { subject: 'Bob', predicate: 'occupation', value: 'A baker.' } },
        { action: 'delete', category: 'capsules', targetId: world.capsules[0].id },
        { action: 'update', category: 'capsules', targetId: world.capsules[1].id, record: { chronicleText: 'An unrelated rewrite.' } },
    ]) {
        const reviewCorrection = engineReview(world, async () => ({ summary: 'Expand scope.', operations: [operation] }));
        await assert.rejects(reviewCorrection(digestRepairInstruction(world.capsules[0])), /only update the selected Digest|outside the reviewed candidates/);
    }
    assert.equal(world.capsules.length, 2);
    assert.equal(world.facts.length, 0);
});
