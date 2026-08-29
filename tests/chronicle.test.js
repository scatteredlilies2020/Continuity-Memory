import assert from 'node:assert/strict';
import test from 'node:test';
import {
    activeChronicleNodes,
    addChroniclePromotion,
    nextChroniclePromotion,
    renderChronicleFrontier,
    syncChronicleBase,
} from '../extension/chronicle.js';

function capsule(index, chatKey = 'chat') {
    return {
        id: `capsule-${index}`,
        chatKey,
        from: index * 4,
        to: index * 4 + 3,
        title: `Scene ${index}`,
        storyTime: `Day ${index}`,
        chronicleText: `The scene-${index} decision changed the situation.`,
        createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    };
}

function world(count) {
    const value = { capsules: Array.from({ length: count }, (_, index) => capsule(index)), chronicle: [], storySoFar: {} };
    syncChronicleBase(value);
    return value;
}

function promote(value, children, label = 'Parent') {
    return addChroniclePromotion(value, {
        title: label,
        storyTime: `${children[0].storyTime} to ${children.at(-1).storyTime}`,
        summary: `${label} preserves the causal changes from ${children.length} source nodes.`,
        turningPoints: ['A consequential decision was made.'],
        emotionalArc: 'Trust changed.',
        closingState: 'The resulting situation persisted.',
        openThreads: ['The consequence remains unresolved.'],
        participants: ['A', 'B'],
        importance: 4,
    }, children);
}

test('C0 Chronicle entries are source-linked and materialize the active frontier', () => {
    const value = world(3);
    assert.equal(value.chronicle.length, 3);
    assert.deepEqual(value.chronicle[0].capsuleIds, ['capsule-0']);
    assert.equal(value.chronicle[0].text, 'The scene-0 decision changed the situation.');
    assert.equal(value.storySoFar.chat.sourceMode, 'chronicle');
    assert.deepEqual(value.storySoFar.chat.nodeIds, value.chronicle.map(item => item.id));
});

test('promotion is oldest-first, same-layer, non-destructive, and capacity-gated', () => {
    const value = world(9);
    const settings = { chronicleLayerCapacity: 8, chroniclePromotionSize: 3 };
    const children = nextChroniclePromotion(value, settings);
    assert.deepEqual(children.map(item => item.id), ['chronicle_capsule-0', 'chronicle_capsule-1', 'chronicle_capsule-2']);
    const parent = promote(value, children);
    assert.equal(parent.level, 1);
    assert.deepEqual(parent.childIds, children.map(item => item.id));
    assert.deepEqual(parent.capsuleIds, ['capsule-0', 'capsule-1', 'capsule-2']);
    assert.equal(value.chronicle.length, 10);
    assert.equal(activeChronicleNodes(value, 'chat').includes(parent), true);
    assert.equal(activeChronicleNodes(value, 'chat').some(item => item.id === children[0].id), false);
    assert.equal(nextChroniclePromotion(value, settings), null);
});

test('recursive promotion creates higher layers while retaining every lower node', () => {
    const value = world(40);
    const settings = { chronicleLayerCapacity: 8, chroniclePromotionSize: 3 };
    let promotions = 0;
    while (true) {
        const children = nextChroniclePromotion(value, settings);
        if (!children) break;
        promote(value, children, `Promotion ${promotions}`);
        promotions++;
        assert.ok(promotions < 100);
    }
    assert.ok(value.chronicle.some(item => item.level === 2));
    assert.equal(value.chronicle.filter(item => item.level === 0).length, 40);
    const frontier = activeChronicleNodes(value, 'chat');
    for (const level of new Set(frontier.map(item => item.level))) {
        assert.ok(frontier.filter(item => item.level === level).length <= 8);
    }
});

test('changing a C0 source invalidates all dependent ancestors but keeps unrelated parents', () => {
    const value = world(9);
    const first = promote(value, value.chronicle.slice(0, 3), 'Affected');
    const second = promote(value, value.chronicle.slice(3, 6), 'Unaffected');
    value.capsules[0].chronicleText = 'A corrected decision replaces the old account.';
    syncChronicleBase(value);
    assert.equal(value.chronicle.some(item => item.id === first.id), false);
    assert.equal(value.chronicle.some(item => item.id === second.id), true);
    assert.equal(value.chronicle.find(item => item.id === 'chronicle_capsule-0').text, 'A corrected decision replaces the old account.');
});

test('frontier rendering can exclude raw-tail or invalid nodes without deleting them', () => {
    const value = world(3);
    const rendered = renderChronicleFrontier(value, 'chat', item => !item.text.includes('scene-1'));
    assert.match(rendered, /scene-0/);
    assert.doesNotMatch(rendered, /scene-1/);
    assert.match(rendered, /scene-2/);
    assert.equal(value.chronicle.length, 3);
});

test('frontier rendering honors its injection allowance while retaining every active range', () => {
    const world = { chronicle: [] };
    for (let index = 0; index < 24; index++) {
        world.chronicle.push({
            id: `c0-${index}`, chatKey: 'chat', level: 0,
            title: `Chronicle interval ${index}`,
            text: `Important development ${index}. `.repeat(40),
            from: index * 10, to: index * 10 + 9,
            childIds: [], capsuleIds: [`l1-${index}`],
        });
    }
    const rendered = renderChronicleFrontier(world, 'chat', () => true, 1500);
    assert.ok(rendered.length <= 6000);
    for (let index = 0; index < 24; index++) assert.match(rendered, new RegExp(`\\[C0 ${index * 10}–${index * 10 + 9}\\]`));
});
