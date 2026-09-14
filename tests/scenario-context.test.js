import assert from 'node:assert/strict';
import test from 'node:test';
import { captureScenarioContext, collectScenarioContext } from '../extension/scenario-context.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { mergeExtraction, resetWorldHierarchy } from '../extension/memory-model.js';
import { addChroniclePromotion } from '../extension/chronicle.js';
import { createContinuationPackage, prepareContinuationWorld } from '../extension/continuation-handoff.js';

const blank = () => ({ id: 'test', name: 'Test', entities: [], facts: [], states: [], relationships: [], events: [],
    capsules: [], arcs: [], eras: [], chronicle: [], extractions: [], threads: [], backgrounds: [], corrections: [], sources: {} });
const query = [{ is_user: true, mes: 'Continue with breakfast.' }];
const message = (text, index = 0, isUser = false) => ({ index, isUser, name: 'Narrator', text });
const scan = (world, messages) => mergeExtraction(world, {
    entities: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [],
    sceneCapsule: { title: 'A meal', opening: 'They ate breakfast.', beats: [], closing: 'They left.', participants: [] },
    chronicleEntry: 'They ate breakfast and left.',
    _sourceScenarioContext: captureScenarioContext(messages),
}, { chatKey: 'chat', from: messages[0].index, to: messages.at(-1).index, allowStateUpdates: true });
const render = (world, options = {}) => buildMemoryPrompt(world, query, 128, 'chat', [], undefined, new Map(), options);

test('different RP settings survive a summarizer omitting every premise and an unrelated tiny-budget query', () => {
    for (const text of [
        '**Timeline:** Before powered flight.\n**Note:** No radios; the regent has not been crowned.',
        'Premise: The ship cannot travel faster than light; only the engineer knows the reactor is failing.',
        'Scenario: A mundane school drama; nobody has supernatural abilities.',
        'OOC: The tribunal accepts testimony only with two witnesses, unless the accused waives that protection.',
    ]) {
        const world = blank();
        const messages = [message(text)];
        scan(world, messages);
        assert.deepEqual(world.capsules[0].sourceScenarioContext, captureScenarioContext(messages));
        assert.ok(!world.capsules[0].chronicleText.includes(text));
        const before = JSON.stringify(world);
        const result = render(world, { includeStorySoFar: false });
        assert.ok(result.prompt.includes(JSON.stringify(text).slice(1, -1)));
        assert.equal(result.retrievalDiagnostics.scenarioContext.count, 1);
        assert.equal(JSON.stringify(world), before);
    }
});

test('premise text is not capped and exact source duplicates render only once', () => {
    const text = `Setting: ${'A detailed era restriction. '.repeat(160)}No flight unless the treaty permits it.`;
    const world = blank();
    scan(world, [message(text)]);
    world.capsules.push(structuredClone(world.capsules[0]));
    const prompt = render(world).prompt;
    assert.ok(prompt.includes(text));
    assert.equal(prompt.split(text).length - 1, 1);
});

test('source preservation does not consume the separate structured recall allowance', () => {
    const world = blank();
    world.facts = Array.from({ length: 8 }, (_, index) => ({ id: `fact-${index}`, subject: 'Breakfast',
        predicate: `custom ${index}`, value: `Breakfast detail ${index}: fruit is served with tea.`, importance: 4 }));
    const build = scenarioSourceMessages => buildMemoryPrompt(world, [{ is_user: true, mes: 'Breakfast fruit and tea details.' }], 2500, 'chat', [], undefined, new Map(), { scenarioSourceMessages });
    const without = build([]).prompt;
    const withSource = build([message(`Setting: ${'A long premise. '.repeat(1500)}`)]).prompt;
    const selected = world.facts.filter(fact => without.includes(fact.value));
    assert.ok(selected.length > 1, 'baseline must pack more than one representative');
    assert.deepEqual(world.facts.filter(fact => withSource.includes(fact.value)), selected);
});

test('live source fallback repairs old-memory omissions without writes and honors edits/deletions', () => {
    const world = blank();
    scan(world, [message('Era: Before the regency.')]);
    const before = JSON.stringify(world);
    const fixed = render(world, { scenarioSourceMessages: [message('Era: After the regency.')] });
    assert.match(fixed.prompt, /After the regency/);
    assert.doesNotMatch(fixed.prompt, /Before the regency/);
    const deleted = render(world, { scenarioSourceMessages: [] });
    assert.doesNotMatch(deleted.prompt, /Before the regency/);
    assert.equal(JSON.stringify(world), before);
});

test('current raw notes are not duplicated, while unrelated chats and invalid stored ranges are excluded', () => {
    const world = blank();
    scan(world, [message('Note: The council has not voted.', 8)]);
    assert.equal(collectScenarioContext(world, 'other').length, 0);
    assert.equal(collectScenarioContext(world, 'chat', { rawTailRange: { from: 8, to: 15 } }).length, 0);
    assert.equal(collectScenarioContext(world, 'chat', { invalidSourceRanges: [{ chatKey: 'chat', from: 8, to: 15 }] }).length, 0);
});

test('later corrections and reassertions retain source order, roles and exact scope', () => {
    const world = blank();
    const notes = collectScenarioContext(world, 'chat', { scenarioSourceMessages: [
        message('Setting: There are no radios.', 0),
        message('OOC: Correction: radio exists, but the island has no receivers.', 8, true),
        message('Setting: There are no radios.', 16),
    ] });
    assert.deepEqual(notes.map(note => note.messageIndex), [0, 8, 16]);
    assert.deepEqual(notes.map(note => note.role), ['assistant', 'user', 'assistant']);
    assert.match(render(world, { scenarioSourceMessages: [message('OOC: Could radios exist?', 8, true)] }).prompt,
        /Questions, hypotheticals, and writing requests are not world facts/);
});

test('quoted notes and code blocks are not treated as canon; an unlabelled opening preserves source attribution', () => {
    for (const text of ['> Note: The queen is immortal.', '"OOC: The queen is immortal."', '```\nSetting: The queen is immortal.\n```']) {
        assert.deepEqual(captureScenarioContext([message(text, 8)]), []);
    }
    const text = 'The colony has no spacecraft. Mara says, "I own the moon."';
    const notes = captureScenarioContext([message(text)]);
    assert.equal(notes[0].text, text);
    assert.equal(notes[0].kind, 'opening');
    assert.match(render(blank(), { scenarioSourceMessages: [message(text)] }).prompt, /not blanket author-level authority/);
});

test('labelled setup does not discard the surrounding unlabelled opening premise', () => {
    const notes = captureScenarioContext([message('The colony has no spacecraft.\n\nSetting: The lunar winter.\n\nMara says, "I own the moon."')]);
    assert.deepEqual(notes.map(note => note.kind), ['opening', 'scenario-note', 'opening']);
    assert.deepEqual(notes.map(note => note.text), ['The colony has no spacecraft.', 'Setting: The lunar winter.', 'Mara says, "I own the moon."']);
    const prompt = render(blank(), { scenarioSourceMessages: [message(notes.map(note => note.text).join('\n\n'))] }).prompt;
    for (const note of notes) assert.ok(prompt.includes(JSON.stringify(note.text).slice(1, -1)));
    assert.match(prompt, /Explicit user corrections take precedence/);
});

test('promotion, hierarchy reset and continuation retain source premises even when AI parents omit them', () => {
    const world = blank();
    scan(world, [message('Era: Before steam engines.')]);
    scan(world, [message('They slept.', 8)]);
    addChroniclePromotion(world, { title: 'Daily life', summary: 'They ate and slept.' }, world.chronicle.slice(0, 2));
    assert.match(render(world).prompt, /Before steam engines/);
    resetWorldHierarchy(world);
    assert.match(render(world).prompt, /Before steam engines/);
    const continued = prepareContinuationWorld(createContinuationPackage(world), { chatKey: 'next' });
    const prompt = buildMemoryPrompt(continued, query, 128, 'next', [], undefined, new Map(), { scenarioSourceMessages: [] }).prompt;
    assert.match(prompt, /Before steam engines/);
});
