import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { addChroniclePromotion, syncChronicleBase } from '../extension/chronicle.js';
import { sourcedWhollyInRawTail } from '../extension/state-lifecycle.js';

const older = { chatKey: 'chat', from: 0, to: 7 };
const recent = { chatKey: 'chat', from: 16, to: 23 };
const options = { rawTailRange: { from: 16, to: 23 }, includeSceneCheckpoint: false };
const world = overrides => ({ entities: [], facts: [], states: [], relationships: [], events: [],
    threads: [], backgrounds: [], capsules: [], chronicle: [], corrections: [], ...overrides });
const recall = (target, query, extra = {}) => buildMemoryPrompt(target, [{ is_user: true, mes: query }],
    6000, 'chat', [], undefined, new Map(), { ...options, ...extra });

test('mixed-source lore survives the raw boundary, while wholly raw detail is not repeated', () => {
    const detail = 'The obsidian gate admits Aster only if Beryl consents before dawn.';
    const cases = [
        ['facts', { subject: 'Obsidian gate', predicate: 'admission condition', value: detail, persistence: 'persistent' }],
        ['entities', { name: 'Obsidian gate', type: 'artifact', description: detail }],
        ['relationships', { from: 'Aster', to: 'Beryl', kind: 'obsidian gate admission', dynamic: detail, status: 'active' }],
        ['threads', { title: 'Obsidian gate admission', detail, participants: ['Aster', 'Beryl'], status: 'open' }],
        ['backgrounds', { topic: 'Obsidian gate admission', summary: detail, status: 'active' }],
    ];
    for (const [category, record] of cases) {
        const target = world({ [category]: [{ ...record, id: 'mixed', importance: 5, sources: [older, recent] }] });
        const before = JSON.stringify(target);
        const result = recall(target, 'What is the obsidian gate admission condition for Aster and Beryl?');
        assert.ok(result.retrievalDiagnostics.selections.some(row => row.id === 'mixed'), category);
        assert.ok(result.prompt.includes(detail), category);
        assert.equal(JSON.stringify(target), before);

        const whollyRaw = structuredClone(target);
        whollyRaw[category][0].sources = [recent];
        const rawResult = recall(whollyRaw, 'What is the obsidian gate admission condition for Aster and Beryl?');
        assert.ok(!rawResult.retrievalDiagnostics.selections.some(row => row.id === 'mixed'), category);
        assert.ok(!rawResult.prompt.includes(detail), category);
    }
});

test('a continuation source in another chat is not covered by a same-numbered raw interval', () => {
    const item = { sources: [{ chatKey: 'previous-chat', from: 16, to: 23 }, recent] };
    assert.equal(sourcedWhollyInRawTail(item, 'chat', options.rawTailRange), false);
    assert.equal(sourcedWhollyInRawTail({ sources: [recent] }, 'chat', options.rawTailRange), true);
    assert.equal(sourcedWhollyInRawTail({}, 'chat', options.rawTailRange), false);
    assert.equal(sourcedWhollyInRawTail({ sources: [recent] }, 'chat', null), false);
});

test('Chronicle history spanning the raw boundary stays whole; wholly raw nodes stay out', () => {
    const target = world({ capsules: [
        { id: 'origin', chatKey: 'chat', from: 0, to: 7, title: 'Origin', chronicleText: 'Aster inherited the gate.' },
        { id: 'plan', chatKey: 'chat', from: 8, to: 15, title: 'Plan', chronicleText: 'Aster planned an inspection with Beryl.' },
        { id: 'recent', chatKey: 'chat', from: 16, to: 23, title: 'Recent arrival', chronicleText: 'Aster reached the gate at moonrise.' },
    ] });
    syncChronicleBase(target);
    const parent = addChroniclePromotion(target, { title: 'Gate history',
        summary: 'Aster inherited the gate and later planned an inspection with Beryl.',
        openThreads: ['Aster sought Beryl’s consent before dawn.'],
    }, target.chronicle.slice(0, 2));
    const before = JSON.stringify(target);
    const result = recall(target, 'Continue.', { rawTailRange: { from: 8, to: 23 } });
    assert.ok(result.prompt.includes(parent.text));
    assert.match(result.prompt, /Context at that point: Aster sought Beryl’s consent before dawn/);
    assert.doesNotMatch(result.prompt, /Aster reached the gate at moonrise/);
    assert.equal(JSON.stringify(target), before);
    const unknownBoundary = recall(target, 'Continue.', { rawTailRange: null });
    assert.match(unknownBoundary.prompt, /Aster reached the gate at moonrise/);
});
