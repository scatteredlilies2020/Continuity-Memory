import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_VIEW_CATEGORIES, memoryViewerPage } from '../extension/memory-viewer.js';

const world = {
    scene: { location: 'Music room', sources: [{ from: 10, to: 14 }, { from: 15, to: 20 }] },
    storySoFar: { chat: { text: 'The club formed and prepared for its first concert.', from: 0, to: 42, updatedAt: '2026-08-21T01:02:03.000Z', rebuiltFromRawChat: true } },
    facts: [{ id: 'fact', subject: 'Naruto', predicate: 'rank', value: 'Genin', importance: 4, sources: [{ from: 4, to: 8 }] }],
    backgrounds: [{ id: 'background', topic: 'Qing White Lotus suppression', summary: 'Militia reliance is increasing.', status: 'active', certainty: 'reported', participants: ['Qing China'], importance: 2, sources: [{ from: 12, to: 16 }] }],
    capsules: [
        { id: 'late', title: 'Later', opening: 'Second', from: 20, to: 29 },
        { id: 'early', title: 'Early', opening: 'First', coverageWarnings: ['A durable vow remains only in L1.'], from: 0, to: 9 },
    ],
    arcs: [{ id: 'l2', title: 'Team trial', summary: 'The team learns cooperation.', from: 0, to: 59 }],
    eras: [{ id: 'l3', title: 'Academy transition', summary: 'A major phase.', from: 0, to: 200 }],
};

test('viewer exposes simple L1, L2, and L3 category names', () => {
    assert.deepEqual(MEMORY_VIEW_CATEGORIES.slice(-3).map(item => item.label), ['L1', 'L2', 'L3']);
});

test('viewer labels the scene as an extracted checkpoint with its latest source message', () => {
    const page = memoryViewerPage(world, 'scene');
    assert.equal(page.items[0].title, 'Latest extracted checkpoint (through message 20)');
});

test('viewer exposes only the current chat story with its raw message boundary', () => {
    const page = memoryViewerPage(world, 'story', '', 0, 30, 'chat');
    assert.equal(page.total, 1);
    assert.equal(page.items[0].title, 'Story so far (through message 42)');
    assert.deepEqual(page.items[0].sources, ['Messages 0–42']);
    assert.ok(page.items[0].fields.some(field => field.label === 'Covered raw-chat range' && field.value === 'Messages 0–42'));
    assert.ok(page.items[0].fields.some(field => field.label === 'Stored through' && field.value === 'Message 42'));
    assert.ok(page.items[0].fields.some(field => field.label === 'Narrative' && field.value.includes('first concert')));
    assert.equal(memoryViewerPage(world, 'story', '', 0, 30, 'other-chat').total, 0);
});

test('viewer orders hierarchy records chronologically and exposes message ranges', () => {
    const page = memoryViewerPage(world, 'l1');
    assert.deepEqual(page.items.map(item => item.title), ['Early', 'Later']);
    assert.deepEqual(page.items[0].sources, ['Messages 0–9']);
    assert.ok(page.items[0].fields.some(field => field.label === 'Coverage warnings' && field.value.includes('durable vow')));
});

test('viewer searches structured content and paginates safely', () => {
    const result = memoryViewerPage(world, 'facts', 'Genin', 10, 1);
    assert.equal(result.total, 1);
    assert.equal(result.page, 0);
    assert.equal(result.items[0].title, 'Naruto — rank');
    assert.deepEqual(result.items[0].sources, ['Messages 4–8']);
});

test('viewer exposes compact background status and certainty', () => {
    const result = memoryViewerPage(world, 'backgrounds', 'White Lotus');
    assert.equal(result.total, 1);
    assert.equal(result.items[0].title, 'Qing White Lotus suppression');
    assert.ok(result.items[0].fields.some(field => field.label === 'Certainty' && field.value === 'reported'));
});
