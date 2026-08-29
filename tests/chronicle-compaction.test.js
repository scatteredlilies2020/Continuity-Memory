import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assertChronicleCompaction,
    chronicleCompactionInstruction,
    chronicleCompactionPlan,
} from '../extension/chronicle-compaction.js';

const nodes = Array.from({ length: 10 }, (_, index) => ({
    text: `Source ${index} preserves a consequential decision and its durable outcome. `.repeat(4),
    openThreads: [`The unresolved consequence ${index} remains open.`],
}));

test('Chronicle promotion receives an explicit semantic compaction target', () => {
    const plan = chronicleCompactionPlan(nodes);
    assert.ok(plan.targetCharacters < plan.sourceCharacters);
    assert.match(chronicleCompactionInstruction(nodes), /rewriting complete thoughts more densely/i);
    assert.match(chronicleCompactionInstruction(nodes), /never permission to .*cut text/i);
});

test('Chronicle promotion rejects non-compacting output instead of slicing it', () => {
    const sourceCharacters = chronicleCompactionPlan(nodes).sourceCharacters;
    assert.throws(() => assertChronicleCompaction({ summary: 'X'.repeat(sourceCharacters) }, nodes, 'C1'), /did not compact/);
    const complete = { summary: 'The decisions produced durable outcomes while their consequences remained unresolved.' };
    assert.equal(assertChronicleCompaction(complete, nodes, 'C1'), complete);
    assert.equal(complete.summary.endsWith('.'), true);
});
