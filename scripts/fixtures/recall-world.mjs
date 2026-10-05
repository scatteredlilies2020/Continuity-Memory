// Fabricated long-history fixtures. No user chat, provider calls, or model output.
import { syncChronicleBase, nextChroniclePromotion, addChroniclePromotion, renderChronicleFrontier } from '../../extension/chronicle.js';

export const CHAT_KEY = 'synthetic-history';
const source = (from = 0) => [{ chatKey: CHAT_KEY, from, to: from + 7 }];
const fact = (id, subject, predicate, value, extra = {}) => ({
    id, subject, predicate, value, importance: 4, persistence: 'persistent', sources: source(), ...extra,
});

export function recallWorld(distractors = 500) {
    const world = {
        id: 'synthetic-recall', revision: 1, scene: null, sources: {}, corrections: [],
        entities: [], states: [], relationships: [], events: [], threads: [], backgrounds: [],
        capsules: [], chronicle: [], storySoFar: {},
        facts: [
            fact('eclipse', 'Lantern seal', 'opening condition', 'The lantern seal opens only during a lunar eclipse.'),
            fact('awake', 'Lantern seal', 'opening condition', 'The lantern seal opens only while its bearer is awake.'),
            fact('old-rule', 'Lantern seal', 'opening history', 'Before the covenant, the lantern seal opened at sunrise.'),
            fact('secret', 'Mira', 'knowledge of vault password', 'Only Mira knows the vault password; Sol has never learned it.', { category: 'knowledge' }),
            fact('belief', 'Sol', 'belief about vault password', 'Sol believes the vault password is amber, but this is unconfirmed.', { category: 'character belief' }),
            fact('recipe', 'Mira', 'chowder recipe', 'Mira seasons chowder with saffron.', { importance: 2 }),
            fact('fresh', 'Lantern seal', 'new inscription', 'The lantern seal now bears a violet inscription.', { sources: source(640) }),
            fact('invalid', 'Lantern seal', 'rejected inscription', 'The lantern seal bears a scarlet inscription.', { sources: source(632) }),
        ],
    };
    world.relationships.push({
        id: 'protocol', from: 'Mira', to: 'Sol', kind: 'boundary protocol',
        dynamic: 'A singular obsidian covenant governs admission.', importance: 4,
        temporal: { referenceId: 'prerequisite' }, sources: source(),
    });
    world.events.push({ id: 'prerequisite', title: 'Moonrise oath', summary: 'The gatekeeper pledged silence.', sources: source(8) });
    world.threads.push(
        { id: 'delivery-plan', title: 'Seal delivery', detail: 'Mira planned delivery tomorrow, only if Sol consented.', status: 'open', sources: source(16), temporalAnchorId: 'delivery-anchor' },
        { id: 'delivery-outcome', title: 'Seal delivery', detail: 'Sol consented and Mira delivered the parcel.', status: 'resolved', sources: source(24) },
    );
    // Mix categories and repeated actors/topics rather than only unique random words.
    for (let index = 0; index < distractors; index++) {
        const shared = { id: `noise-${index}`, importance: 2 + index % 4, sources: source((index % 78) * 8) };
        const subject = index % 4 ? `Archivist ${index % 31}` : 'Mira';
        const detail = `${subject} catalogued pottery shipment ${index} in the southern warehouse.`;
        switch (index % 5) {
            case 0: world.facts.push(fact(shared.id, subject, 'pottery inventory', detail, shared)); break;
            case 1: world.events.push({ ...shared, title: `Pottery shipment ${index}`, summary: detail }); break;
            case 2: world.threads.push({ ...shared, title: `Warehouse inspection ${index}`, detail, participants: [subject], status: 'open' }); break;
            case 3: world.backgrounds.push({ ...shared, topic: `Southern pottery ${index}`, detail }); break;
            case 4: world.relationships.push({ ...shared, from: subject, to: 'Warehouse clerk', kind: 'pottery trade', dynamic: detail }); break;
        }
    }
    // 640 source messages represented by 80 Digests, recursively promoted by
    // production code. Parent prose is fixture-authored, not AI-quality evidence.
    world.capsules = Array.from({ length: 80 }, (_, index) => ({
        id: `digest-${index}`, chatKey: CHAT_KEY, from: index * 8, to: index * 8 + 7,
        title: `Journey interval ${index}`, chronicleText: `The travellers crossed district ${index} and continued their journey.`,
        sources: source(index * 8),
    }));
    syncChronicleBase(world);
    let children;
    while ((children = nextChroniclePromotion(world))) {
        addChroniclePromotion(world, { summary: `The travellers journeyed through districts in source interval ${children[0].from} to ${children.at(-1).to}.` }, children);
    }
    return world;
}

export const recallCases = [
    {
        name: 'exact conditions and history beyond lossy Chronicle',
        query: 'Does the lantern seal open at sunrise or during a lunar eclipse while its bearer is awake?',
        required: ['The lantern seal opens only during a lunar eclipse.', 'The lantern seal opens only while its bearer is awake.', 'Before the covenant, the lantern seal opened at sunrise.'],
        forbidden: ['Mira seasons chowder'],
    },
    {
        name: 'knowledge boundary and attributed uncertainty',
        query: 'Who knows the vault password and what does Sol believe about it?',
        required: ['Only Mira knows the vault password; Sol has never learned it.', 'Sol believes the vault password is amber, but this is unconfirmed.'],
        forbidden: ['Mira seasons chowder'],
    },
    {
        name: 'explicit prerequisite without same-actor distraction',
        query: 'What is the singular obsidian covenant?',
        required: ['A singular obsidian covenant governs admission.', 'The gatekeeper pledged silence.'],
        forbidden: ['Mira seasons chowder', 'Mira planned delivery'],
    },
    {
        name: 'historical plan and evidenced outcome, not a pending reminder',
        query: 'What happened with the seal delivery?',
        required: ['Mira planned delivery tomorrow (relative to delivery-anchor), only if Sol consented.', 'Sol consented and Mira delivered the parcel.', 'Historical observation'],
        forbidden: ['Mira seasons chowder', 'Open-thread ledger'],
    },
    {
        name: 'raw-tail and invalid-source details are not reinjected',
        query: 'What inscription and opening condition does the lantern seal have?',
        required: ['The lantern seal opens only during a lunar eclipse.'],
        forbidden: ['violet inscription', 'scarlet inscription'],
        options: { rawTailRange: { from: 640, to: 647 }, invalidSourceRanges: [{ chatKey: CHAT_KEY, from: 632, to: 639 }] },
    },
    {
        name: 'topic switch retains Chronicle without unrelated reminders',
        query: 'Describe the falling rain.', required: [],
        forbidden: ['Mira seasons chowder', 'Mira planned delivery', 'Event ledger', 'Historical observation'],
    },
];

export function evaluateRecall(world, scenario, result) {
    const missing = scenario.required.filter(value => !result.prompt.includes(value));
    const unwanted = scenario.forbidden.filter(value => result.prompt.includes(value));
    const noise = result.retrievalDiagnostics.selections.filter(row => row.injected && row.id?.startsWith('noise-')).map(row => row.id);
    const chronicle = renderChronicleFrontier(world, CHAT_KEY, node => !(scenario.options?.invalidSourceRanges || [])
        .some(range => node.from <= range.to && node.to >= range.from));
    if (!result.prompt.includes(chronicle)) missing.push('complete eligible Chronicle frontier');
    return { name: scenario.name, passed: !missing.length && !unwanted.length && !noise.length, missing, unwanted, noise, estimatedTokens: result.estimatedTokens };
}
