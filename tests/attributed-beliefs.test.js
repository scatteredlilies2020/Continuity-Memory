import assert from 'node:assert/strict';
import test from 'node:test';
import { isAttributedBeliefFact, migrateLegacyBeliefs } from '../extension/attributed-beliefs.js';

test('migrates legacy belief records, replay data, and corrections into attributed facts', () => {
    const world = {
        facts: [],
        beliefs: [{
            id: 'belief-alice', holder: 'Alice', subject: 'masked visitor', predicate: 'identity', value: 'the prince',
            confidence: 'certain', status: 'held', truthStatus: 'unknown', importance: 4,
            sources: [{ chatKey: 'chat', from: 0, to: 3 }],
        }],
        extractions: [{
            result: {
                facts: [],
                beliefs: [{ holder: 'Bob', subject: 'masked visitor', predicate: 'identity', value: 'a spy', status: 'held' }],
                recordMerges: [{ category: 'beliefs', canonicalId: 'belief-alice', duplicateIds: [], evidence: 'same belief' }],
            },
        }],
        corrections: [{
            operations: [{
                category: 'beliefs', targetId: 'belief-alice', beforeSelector: 'alice|masked visitor|identity',
                before: { holder: 'Alice', subject: 'masked visitor', predicate: 'identity', value: 'the prince', confidence: 'certain', status: 'held', truthStatus: 'unknown', importance: 4 },
                after: { holder: 'Alice', subject: 'masked visitor', predicate: 'identity', value: 'not the prince', confidence: 'doubted', status: 'revised', truthStatus: 'unknown', importance: 4 },
            }],
        }],
    };

    assert.equal(migrateLegacyBeliefs(world), 2);
    assert.equal(world.beliefs, undefined);
    assert.equal(world.facts[0].id, 'belief-alice');
    assert.equal(world.facts[0].subject, 'Alice');
    assert.equal(world.facts[0].predicate, 'belief about masked visitor — identity');
    assert.equal(world.facts[0].category, 'character belief');
    assert.match(world.facts[0].value, /holder confidence: certain/);
    assert.equal(isAttributedBeliefFact(world.facts[0]), true);
    assert.equal(world.extractions[0].result.beliefs, undefined);
    assert.equal(world.extractions[0].result.facts[0].subject, 'Bob');
    assert.equal(world.extractions[0].result.recordMerges[0].category, 'facts');
    assert.equal(world.corrections[0].operations[0].category, 'facts');
    assert.equal(world.corrections[0].operations[0].before.subject, 'Alice');
    assert.equal(world.corrections[0].operations[0].beforeSelector, 'alice|belief about masked visitor — identity');
    assert.equal(migrateLegacyBeliefs(world), 0);
});

test('recognizes new attributed beliefs without a separate collection', () => {
    assert.equal(isAttributedBeliefFact({ subject: 'Alice', predicate: 'belief about Bob — motive', category: 'character belief' }), true);
    assert.equal(isAttributedBeliefFact({ subject: 'Bob', predicate: 'identity', category: 'identity' }), false);
});
