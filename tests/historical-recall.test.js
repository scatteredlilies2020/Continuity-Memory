import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { deduplicateSupportingRecall } from '../extension/supporting-memories.js';

const chat = 'character:7:chat:journey';
const source = (from, to, chatKey = chat) => [{ chatKey, from, to }];
const world = overrides => ({ entities: [], facts: [], relationships: [], states: [], events: [],
    threads: [], backgrounds: [], capsules: [], corrections: [], chronicle: [], ...overrides });
const observation = (id, from, detail, chatKey = chat) => ({ id, title: 'Mira and Sol travel', detail,
    participants: ['Mira', 'Sol'], certainty: 'confirmed', temporalAnchorId: `Digest-aaaa-${from}-${from + 7}`,
    sources: source(from, from + 7, chatKey), importance: 5 });

test('recorded ignorance has source time and cannot become a behavior directive', () => {
    const w = world({ facts: [{ id: 'gap', subject: 'Mira', predicate: 'knowledge of the silver gate password',
        value: 'Mira did not know the silver gate password.', category: 'knowledge boundary', sources: source(0, 7) }],
    threads: [observation('reveal', 8, 'Sol told Mira the silver gate password at dawn.')] });
    const before = JSON.stringify(w);
    const { prompt } = buildMemoryPrompt(w, [{ is_user: true, mes: 'Mira asks Sol about the silver gate password.' }], 6000, chat);
    assert.match(prompt, /Records describe history, not required behavior/);
    assert.match(prompt, /\[Recorded knowledge — this chat messages 0–7\]/);
    assert.match(prompt, /Mira did not know the silver gate password/);
    assert.match(prompt, /Sol told Mira the silver gate password at dawn/);
    assert.doesNotMatch(prompt, /HARD LIMIT|Memory constraints:/);
    assert.equal(JSON.stringify(w), before);
});

test('recall removes device-alias duplicates while keeping later agreement and the original history', () => {
    const refusal = observation('refusal', 0, 'Mira refused Sol’s offer of passage.');
    const alias = { ...refusal, id: 'alias', temporalAnchorId: 'Digest-bbbb-0-7', sources: source(0, 7, 'character:99:chat:journey') };
    const agreement = observation('agreement', 8, 'Mira accepted Sol’s offer of passage after seeing the permit.');
    const w = world({ threads: [alias, refusal, agreement] });
    const before = JSON.stringify(w);
    const result = buildMemoryPrompt(w, [{ is_user: true, mes: 'Mira and Sol discuss the offer of passage and the permit.' }], 6000, chat);
    assert.equal(result.prompt.split(refusal.detail).length - 1, 1);
    assert.equal(result.prompt.split(agreement.detail).length - 1, 1);
    assert.match(result.prompt, /Historical observation/);
    assert.equal(JSON.stringify(w), before);
});

test('recall deduplication retains distinct times, chats, uncertainty and conditions', () => {
    const first = observation('first', 0, 'Mira refused Sol’s offer of passage.');
    const records = [first,
        observation('later', 8, first.detail),
        observation('other-chat', 0, first.detail, 'character:7:chat:other'),
        { ...first, id: 'uncertain', certainty: 'reported' },
        { ...first, id: 'condition', detail: first.detail + ' She required a permit.' },
        { ...first, id: 'frame', temporal: { frame: 'a different loop' } },
    ];
    assert.deepEqual(deduplicateSupportingRecall(records, chat), records);
});
