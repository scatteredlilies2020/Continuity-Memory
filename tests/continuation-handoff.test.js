import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CONTINUATION_PACKAGE_KIND,
    createContinuationPackage,
    isContinuationPackage,
    prepareContinuationWorld,
} from '../extension/continuation-handoff.js';

function world() {
    return {
        schemaVersion: 8,
        id: 'origin-world',
        name: 'Long Roleplay',
        revision: 12,
        scene: { id: 'scene-1', location: 'Harbor', sources: [{ chatKey: 'old-chat', from: 8, to: 15 }] },
        entities: [{ id: 'entity-1', name: 'Alice', sources: [{ chatKey: 'old-chat', from: 0, to: 7 }] }],
        facts: [], beliefs: [{ id: 'belief-1', holder: 'Alice', subject: 'masked visitor', predicate: 'identity', value: 'the prince', truthStatus: 'unknown', sources: [{ chatKey: 'old-chat', from: 0, to: 7 }] }], states: [], relationships: [], events: [],
        capsules: [{ id: 'capsule-1', chatKey: 'old-chat', from: 0, to: 7, sources: [{ chatKey: 'old-chat', from: 0, to: 7 }] }],
        arcs: [{ id: 'arc-1', capsuleIds: ['capsule-1'], sources: [{ chatKey: 'old-chat', from: 0, to: 7 }] }],
        eras: [], extractions: [{ id: 'extraction-1', chatKey: 'old-chat', from: 0, to: 7 }],
        threads: [], backgrounds: [], corrections: [],
        sources: { 'old-chat': { processedMessages: [{ index: 0, fingerprint: 'abc' }] } },
    };
}

test('continuation package is explicit, readable, and preserves the source snapshot', () => {
    const source = world();
    const file = createContinuationPackage(source, '2026-08-11T00:00:00.000Z');
    assert.equal(file.kind, CONTINUATION_PACKAGE_KIND);
    assert.equal(file.source.name, 'Long Roleplay');
    assert.equal(file.world.entities[0].name, 'Alice');
    assert.equal(isContinuationPackage(file), true);
    file.world.entities[0].name = 'Changed copy';
    assert.equal(source.entities[0].name, 'Alice');
});

test('starting a continuation preserves memory but detaches old message fingerprints', () => {
    const file = createContinuationPackage(world(), '2026-08-11T00:00:00.000Z');
    const continued = prepareContinuationWorld(file, {
        chatKey: 'character:2:chat:new-arc',
        attachedAt: '2026-08-11T01:00:00.000Z',
    });
    assert.equal(continued.name, 'Long Roleplay · Continuation');
    assert.deepEqual(continued.sources, {});
    assert.deepEqual(continued.extractions, []);
    assert.equal(continued.entities[0].name, 'Alice');
    assert.equal(continued.entities[0].sources[0].chatKey, 'continuation:origin-world');
    assert.equal(continued.entities[0].sources[0].inherited, true);
    assert.equal(continued.beliefs, undefined);
    assert.equal(continued.facts[0].subject, 'Alice');
    assert.equal(continued.facts[0].category, 'character belief');
    assert.equal(continued.facts[0].sources[0].chatKey, 'continuation:origin-world');
    assert.equal(continued.capsules[0].chatKey, 'continuation:origin-world');
    assert.equal(continued.continuation.attachedChatKey, 'character:2:chat:new-arc');
    assert.equal(continued.revision, -1);
});

test('ordinary memory exports cannot bypass continuation validation', () => {
    assert.equal(isContinuationPackage(world()), false);
    assert.throws(() => prepareContinuationWorld(world(), { chatKey: 'new-chat' }), /not a supported/);
});
