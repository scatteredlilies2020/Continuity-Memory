import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHierarchyResult } from '../extension/hierarchy-result.js';

test('hierarchy output recovers scalar and missing list fields', () => {
    const result = normalizeHierarchyResult({
        summary: 'An arc occurred.',
        participants: 'Alice',
        turningPoints: null,
        openThreads: 'Alice still needs to arrive.',
    }, 'C1');

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
    }, 'C1'), /C1 field "participants" is not an array/);
});
