import assert from 'node:assert/strict';
import test from 'node:test';
import { supportingRecords, retainSupportingHistory } from '../extension/supporting-memories.js';
import { mergeExtraction, compactDuplicateMemoryRecords, undoLatestDigestExtraction, removeChatContributions, replaceExtraction } from '../extension/memory-model.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { buildEmbeddingDocuments } from '../extension/embedding-index.js';
import { memoryViewerPage, MEMORY_VIEW_CATEGORIES } from '../extension/memory-viewer.js';
import { sanitizeReconciliationMetadata } from '../extension/reconciliation-policy.js';
import { createContinuationPackage, prepareContinuationWorld } from '../extension/continuation-handoff.js';
import { applyCorrectionProposal } from '../extension/memory-correction.js';
import { buildExtractionSystemPrompt, SUPPORTING_MEMORY_RULES } from '../extension/prompts.js';

const world = () => ({ id: 'test', name: 'Supporting test', revision: 0, entities: [], facts: [], states: [],
    relationships: [], events: [], threads: [], backgrounds: [], capsules: [], extractions: [], sources: {} });
const extraction = overrides => ({ scene: null, sceneCapsule: null, entities: [], facts: [], states: [],
    relationships: [], events: [], threads: [], backgrounds: [], identityResolutions: [], recordMerges: [], ...overrides });
const source = (from, to) => [{ chatKey: 'chat', from, to }];
const meta = (from, to, extra = {}) => ({ chatKey: 'chat', from, to, ...extra });
const recall = (w, query, options = {}) => buildMemoryPrompt(w, [{ name: 'User', mes: query }], 8000, 'chat', [], undefined, new Map(), options);
const observation = (detail, extra = {}) => ({ title: 'Silver gate expedition', detail, participants: ['Mira'], importance: 4, ...extra });

test('legacy records of every lifecycle remain visible and retrievable without rebuilding or mutating storage', () => {
    const w = world();
    w.threads = ['open', 'resolved', 'abandoned'].map((status, i) => ({ id: status,
        ...observation(`Silver gate expedition evidence ${i}.`, { status, sources: source(i * 8, i * 8 + 7) }) }));
    w.backgrounds = ['active', 'resolved', 'dormant'].map((status, i) => ({ id: `b${i}`, topic: 'Silver gate expedition',
        summary: `A messenger reported a distinct consequence ${i}.`, status, certainty: 'reported', sources: source(i * 8, i * 8 + 7) }));
    const before = JSON.stringify(w);
    const page = memoryViewerPage(w, 'supporting');
    assert.equal(page.total, 6);
    assert.ok(MEMORY_VIEW_CATEGORIES.some(item => item.key === 'supporting'));
    assert.ok(!MEMORY_VIEW_CATEGORIES.some(item => ['threads', 'backgrounds'].includes(item.key)));
    const result = recall(w, 'Silver gate expedition');
    for (let i = 0; i < 3; i++) assert.match(result.prompt, new RegExp(`expedition evidence ${i}`));
    assert.match(result.prompt, /reported/);
    assert.doesNotMatch(result.prompt, /OPEN —|Open-thread ledger|\[active|\[resolved/);
    assert.equal(buildEmbeddingDocuments(w).length, 6);
    assert.equal(JSON.stringify(w), before);
});

test('updates and backfills preserve full earlier details, certainty and individual source ranges', () => {
    const w = world();
    const long = `${'Distinct background conditions. '.repeat(30)}The violet writ required a witness.`;
    mergeExtraction(w, extraction({ backgrounds: [{ topic: 'Silver gate expedition', summary: long, certainty: 'reported' }] }), meta(0, 7));
    const id = w.backgrounds[0].id;
    mergeExtraction(w, extraction({ backgrounds: [{ targetId: id, topic: 'Silver gate expedition',
        summary: 'The expedition returned with an amber seal.', certainty: 'confirmed' }] }), meta(16, 23));
    mergeExtraction(w, extraction({ backgrounds: [{ targetId: id, topic: 'Silver gate expedition',
        summary: 'A courier carried the azure invitation.', certainty: 'uncertain' }] }), meta(8, 15, { allowStateUpdates: false }));
    assert.match(w.backgrounds[0].summary, /amber seal/);
    const records = supportingRecords(w, 'backgrounds');
    assert.equal(records.length, 3);
    assert.ok(records.some(item => item.summary === long && item.certainty === 'reported' && item.sources[0].from === 0));
    assert.match(recall(w, 'violet writ witness').prompt, /violet writ required a witness/);
    assert.match(recall(w, 'azure invitation').prompt, /azure invitation/);
    assert.ok(buildEmbeddingDocuments(w).some(item => item.text.includes('violet writ required a witness')));
    const reread = JSON.parse(JSON.stringify(w));
    assert.deepEqual(supportingRecords(reread, 'backgrounds'), records);
});

test('same-title distinct observations do not overwrite each other and exact repeats merge conservatively', () => {
    const w = world();
    mergeExtraction(w, extraction({ threads: [observation('Mira planned a dawn departure.'), observation('Mira required the silver permit.')] }), meta(0, 7));
    assert.equal(w.threads.length, 2);
    const before = supportingRecords(w, 'threads').map(item => item.detail);
    mergeExtraction(w, extraction({ threads: [observation('Mira planned a dawn departure.')] }), meta(0, 7));
    assert.equal(w.threads.length, 2);
    assert.deepEqual(supportingRecords(w, 'threads').map(item => item.detail), before);
});

test('legacy replay snapshots recover overwritten text and migration is idempotent', () => {
    const w = world();
    w.threads = [{ id: 'gate', ...observation('The party returned.'), status: 'resolved', sources: source(8, 15) }];
    w.extractions = [{ ...meta(0, 7), result: extraction({ threads: [observation('The silver gate needed a sapphire key.', { targetId: 'gate', status: 'open' })] }) }];
    assert.match(recall(w, 'sapphire key').prompt, /needed a sapphire key/);
    retainSupportingHistory(w);
    const before = JSON.stringify(w);
    retainSupportingHistory(w);
    assert.equal(JSON.stringify(w), before);
    assert.equal(supportingRecords(w, 'threads').length, 2);
});

test('source-bound earlier evidence survives raw-tail suppression of a later update', () => {
    const w = world();
    mergeExtraction(w, extraction({ threads: [observation('A sapphire key was required.')] }), meta(0, 7));
    mergeExtraction(w, extraction({ threads: [observation('The expedition returned with an amber seal.', { targetId: w.threads[0].id })] }), meta(8, 15));
    const result = recall(w, 'Silver gate expedition sapphire key amber seal', { rawTailRange: { from: 8, to: 15 } });
    assert.match(result.prompt, /sapphire key was required/);
    assert.doesNotMatch(result.prompt, /returned with an amber seal/);
});

test('neutral production validation and compaction never resolve or reopen a stored plan', () => {
    const w = world();
    w.threads = [{ id: 'gate', ...observation('Mira planned a dawn departure.'), status: 'open', sources: source(0, 7) }];
    const original = structuredClone(w.threads);
    const result = extraction({ threads: [observation('Mira departed at noon.', { targetId: 'gate', status: 'resolved' })] });
    assert.doesNotThrow(() => sanitizeReconciliationMetadata(result, w, [], { neutralSupporting: true }));
    assert.equal(result.threads[0].status, 'recorded');
    compactDuplicateMemoryRecords(w);
    assert.deepEqual(w.threads, original);
    const unrelated = recall(w, 'A quiet breakfast beside the lake.');
    assert.doesNotMatch(unrelated.prompt, /dawn departure|Open-thread ledger/);
    assert.match(recall(w, 'Silver gate expedition').prompt, /dawn departure/);
});

test('handoff remaps all historical sources so earlier observations remain retrievable', () => {
    const w = world();
    mergeExtraction(w, extraction({ threads: [observation('The gate required a sapphire key.')] }), meta(0, 7));
    mergeExtraction(w, extraction({ threads: [observation('Mira returned at noon.', { targetId: w.threads[0].id })] }), meta(8, 15));
    const continued = prepareContinuationWorld(createContinuationPackage(w), { chatKey: 'next-chat' });
    const records = supportingRecords(continued, 'threads');
    assert.equal(records.length, 2);
    assert.ok(records.every(item => item.sources.every(s => s.chatKey === continued.continuation.inheritedChatKey)));
    assert.match(buildMemoryPrompt(continued, [{ name: 'User', mes: 'sapphire key' }], 5000, 'next-chat').prompt, /required a sapphire key/);
});

test('explicit corrections retain rejected history in audit only and replay cannot resurrect it', () => {
    const w = world();
    mergeExtraction(w, extraction({ threads: [observation('The gate needed a sapphire key.')] }), meta(0, 7));
    mergeExtraction(w, extraction({ threads: [observation('Mira found a ruby key.', { targetId: w.threads[0].id })] }), meta(8, 15));
    applyCorrectionProposal(w, { instruction: 'Correct the expedition record.', summary: 'Key correction.', operations: [{
        action: 'replace', category: 'threads', targetId: w.threads[0].id, replacement: observation('The gate had no lock.'), reason: 'User correction.',
    }] });
    assert.equal(supportingRecords(w, 'threads').length, 1);
    assert.equal(supportingRecords(w, 'threads')[0].detail, 'The gate had no lock.');
    assert.match(JSON.stringify(w.corrections[0].operations[0].supportingHistoryBefore), /sapphire key/);
    retainSupportingHistory(w);
    assert.equal(supportingRecords(w, 'threads').length, 1);
});

test('custom extraction prompts always receive the neutral supporting-memory contract', () => {
    const prompt = buildExtractionSystemPrompt('Legacy instructions: keep open threads active.');
    assert.ok(prompt.includes(SUPPORTING_MEMORY_RULES));
    assert.match(prompt, /supersede legacy open\/closed/);
});

test('undo latest extraction removes only its observations and preserves earlier recall', () => {
    const w = world();
    mergeExtraction(w, extraction({ threads: [observation('Mira needed a sapphire key.')] }), meta(0, 7));
    const id = w.threads[0].id;
    mergeExtraction(w, extraction({ threads: [observation('Mira returned with an amber seal.', { targetId: id })] }), meta(8, 15));
    undoLatestDigestExtraction(w, 'chat');
    const items = supportingRecords(w, 'threads');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, id);
    assert.match(items[0].detail, /sapphire key/);
    assert.doesNotMatch(recall(w, 'Silver gate expedition').prompt, /amber seal/);
});

test('removing a chat clears nested observations without deleting another chat history', () => {
    const w = world();
    mergeExtraction(w, extraction({ threads: [observation('Mira needed a sapphire key.')] }), meta(0, 7));
    const id = w.threads[0].id;
    mergeExtraction(w, extraction({ threads: [observation('Mira returned with an amber seal.', { targetId: id })] }), meta(8, 15, { chatKey: 'second' }));
    removeChatContributions(w, 'second');
    const items = supportingRecords(w, 'threads');
    assert.equal(items.length, 1);
    assert.match(items[0].detail, /sapphire key/);
    assert.ok(items[0].sources.every(item => item.chatKey === 'chat'));
    assert.doesNotMatch(recall(w, 'Silver gate expedition').prompt, /amber seal/);
});

test('replacing a range cannot leave rejected text in nested supporting history', () => {
    const w = world();
    mergeExtraction(w, extraction({ threads: [observation('Mira needed a sapphire key.')] }), meta(0, 7));
    const id = w.threads[0].id;
    mergeExtraction(w, extraction({ threads: [observation('Mira returned with an amber seal.', { targetId: id })] }), meta(8, 15));
    replaceExtraction(w, extraction({ threads: [observation('Mira returned with a violet writ.', { targetId: id })] }), meta(8, 15));
    const result = recall(w, 'Silver gate expedition');
    assert.match(result.prompt, /sapphire key/);
    assert.match(result.prompt, /violet writ/);
    assert.doesNotMatch(result.prompt, /amber seal/);
});

test('identical cross-channel observations inject once while different evidence stays intact', () => {
    const w = world();
    w.threads = [{ id: 't', ...observation('Mira needed a sapphire key.'), sources: source(0, 7), certainty: 'reported' }];
    w.backgrounds = [{ id: 'b', topic: 'Silver gate expedition', summary: 'Mira needed a sapphire key.',
        participants: ['Mira'], sources: source(0, 7), certainty: 'reported', importance: 4 }];
    const before = JSON.stringify(w);
    const result = recall(w, 'Silver gate expedition');
    assert.equal(result.prompt.split('Mira needed a sapphire key.').length - 1, 1);
    assert.equal(JSON.stringify(w), before);
    w.backgrounds[0].certainty = 'confirmed';
    const distinct = recall(w, 'Silver gate expedition');
    assert.equal(distinct.prompt.split('Mira needed a sapphire key.').length - 1, 2);
});
