import test from 'node:test';
import assert from 'node:assert/strict';
import { nextArcCapsules } from '../extension/hierarchy-policy.js';

function capsules(count, offset = 0, chatKey = 'chat') {
    return Array.from({ length: count }, (_, index) => ({
        id: `l1-${offset + index}`,
        chatKey,
        from: (offset + index) * 10,
        to: (offset + index) * 10 + 9,
    }));
}

const settings = { hierarchyMode: 'l3', arcGroupSize: 24 };

test('L2 waits for a complete group of 24 uncovered L1 records', () => {
    assert.equal(nextArcCapsules({ capsules: capsules(23), arcs: [] }, settings), null);
    assert.deepEqual(nextArcCapsules({ capsules: capsules(24), arcs: [] }, settings).map(item => item.id), capsules(24).map(item => item.id));
});

test('the next L2 waits for another complete group of 24 L1 records', () => {
    const allCapsules = capsules(47);
    const firstArc = { capsuleIds: allCapsules.slice(0, 24).map(item => item.id) };
    assert.equal(nextArcCapsules({ capsules: allCapsules, arcs: [firstArc] }, settings), null);

    allCapsules.push(...capsules(1, 47));
    assert.deepEqual(
        nextArcCapsules({ capsules: allCapsules, arcs: [firstArc] }, settings).map(item => item.id),
        allCapsules.slice(24, 48).map(item => item.id),
    );
});

test('L2 never combines records from separate chats', () => {
    const world = { capsules: [...capsules(12, 0, 'a'), ...capsules(12, 0, 'b')], arcs: [] };
    assert.equal(nextArcCapsules(world, settings), null);
});
