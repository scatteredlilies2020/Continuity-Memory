import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeExtraction } from '../extension/memory-model.js';
import { activeChronicleNodes, addChroniclePromotion, syncChronicleBase } from '../extension/chronicle.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { compileRollingStorySnapshot } from '../extension/story-snapshot.js';

function extract(chronicle, target = { sources: {} }, from = 0) {
    mergeExtraction(target, {
        sceneCapsule: { title: 'Journey', opening: 'Mira entered the city.', beats: [], closing: 'Mira returned.' },
        ...chronicle,
    }, { chatKey: 'chat', from, to: from + 7 });
    return target;
}

test('accepted C0 prose survives the former 2400-character boundary and a tiny injection target', () => {
    for (const length of [80, 2399, 2400, 2401, 9000]) {
        const ending = 'Only Mira knows the vault password.';
        const entry = `${'x'.repeat(length - ending.length - 1)} ${ending}`;
        const target = extract({ chronicleEntry: entry });
        assert.equal(target.capsules[0].chronicleText, entry);
        assert.equal(target.chronicle[0].text, entry);
        assert.equal(target.extractions[0].result.chronicleEntry, entry);
        const stored = JSON.parse(JSON.stringify(target));
        syncChronicleBase(stored);
        const result = buildMemoryPrompt(stored, [{ is_user: true, mes: 'Continue.' }], 128, 'chat');
        assert.ok(result.prompt.includes(entry), `complete ${length}-character entry`);
        assert.ok(stored.storySoFar.chat.text.includes(entry));
    }
});

test('legacy story snapshot fallback retains complete consequential prose', () => {
    const snapshot = { premise: ['A journey began. '.repeat(180)], boundaryState: ['Only Mira knows the password.'] };
    const expected = compileRollingStorySnapshot(snapshot).replace(/\s+/g, ' ').trim();
    const target = extract({ storySoFar: snapshot });
    assert.ok(expected.length > 2400);
    assert.equal(target.capsules[0].chronicleText, expected);
    assert.equal(target.chronicle[0].text, expected);
});

test('promotion receives complete C0 accounts and keeps the accepted parent complete', () => {
    const entry = `${'Consequential journey detail. '.repeat(100)}Only Mira knows the password.`;
    const target = extract({ chronicleEntry: entry });
    extract({ chronicleEntry: 'Mira met Sol but did not disclose the password.' }, target, 8);
    const children = activeChronicleNodes(target, 'chat');
    assert.equal(children[0].text, entry);
    const summary = children.map(child => child.text).join(' ');
    addChroniclePromotion(target, { summary }, children);
    const restored = JSON.parse(JSON.stringify(target));
    syncChronicleBase(restored);
    assert.equal(activeChronicleNodes(restored, 'chat').length, 1);
    const result = buildMemoryPrompt(restored, [{ is_user: true, mes: 'Continue.' }], 128, 'chat');
    assert.ok(result.prompt.includes(summary));
});
