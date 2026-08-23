import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHierarchyResult } from '../extension/hierarchy-result.js';

test('hierarchy output recovers scalar and missing list fields', () => {
    const result = normalizeHierarchyResult({
        summary: 'An arc occurred.',
        participants: 'Alice',
        turningPoints: null,
        openThreads: 'Alice still needs to arrive.',
    }, 'L2');

    assert.deepEqual(result.participants, ['Alice']);
    assert.deepEqual(result.turningPoints, []);
    assert.deepEqual(result.openThreads, ['Alice still needs to arrive.']);
});

test('hierarchy output still rejects object-shaped list fields', () => {
    assert.throws(() => normalizeHierarchyResult({
        summary: 'An arc occurred.',
        participants: { Alice: true },
        turningPoints: [],
        openThreads: [],
    }, 'L2'), /L2 field "participants" is not an array/);
});
