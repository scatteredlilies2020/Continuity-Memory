import { syncChronicleBase, addChroniclePromotion } from '../../extension/chronicle.js';
export function summarizedWorld(base = {}) {
    const world = { ...base, facts: [{ id: 'fact', value: 'Exact binding commitment.' }], threads: [{ id: 'open', status: 'open' }],
        capsules: Array.from({ length: 10 }, (_, i) => ({ id: `capsule-${i}`, chatKey: 'chat', from: i * 2, to: i * 2 + 1,
            title: `Trade ${i}`, beats: [`District ${i} negotiates a transport agreement.`], createdAt: '2026-01-01T00:00:00Z' })), chronicle: [] };
    world.extractions = world.capsules.map(c => ({ id: `replay-${c.id}`, chatKey: c.chatKey, from: c.from, to: c.to, result: { exact: c.beats } }));
    syncChronicleBase(world);
    addChroniclePromotion(world, { summary: 'The districts negotiated transport agreements; the binding commitment and open question remain.' }, [...world.chronicle]);
    return world;
}
