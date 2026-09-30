import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryPrompt, prepareRetrievalCorpus } from '../extension/retrieval.js';
import { CHAT_KEY, recallWorld, recallCases, evaluateRecall } from '../scripts/fixtures/recall-world.mjs';

for (const scenario of recallCases) {
    test(`synthetic long-history recall: ${scenario.name}`, async () => {
        const world = recallWorld();
        const before = JSON.stringify(world);
        const messages = [{ is_user: true, mes: scenario.query }];
        const cold = buildMemoryPrompt(world, messages, 6000, CHAT_KEY, [], undefined, new Map(), scenario.options);
        const prepared = structuredClone(world);
        assert.equal(await prepareRetrievalCorpus(prepared), true);
        const warm = buildMemoryPrompt(prepared, messages, 6000, CHAT_KEY, [], undefined, new Map(), scenario.options);
        assert.equal(warm.prompt, cold.prompt);
        const report = evaluateRecall(world, scenario, warm);
        assert.equal(report.passed, true, JSON.stringify(report));
        assert.equal(JSON.stringify(world), before, 'retrieval must not rewrite the source history');
        assert.equal(JSON.stringify(prepared), before);
    });
}

test('recall evaluator detects lost details, irrelevant injection, and a missing Chronicle', () => {
    const world = recallWorld(0);
    const scenario = recallCases[0];
    const result = buildMemoryPrompt(world, [{ is_user: true, mes: scenario.query }], 6000, CHAT_KEY);
    assert.equal(evaluateRecall(world, scenario, result).passed, true);
    const missing = evaluateRecall(world, scenario, { ...result, prompt: result.prompt.replace(scenario.required[0], '') });
    assert.deepEqual(missing.missing, [scenario.required[0]]);
    assert.equal(missing.passed, false);
    const polluted = evaluateRecall(world, scenario, { ...result, prompt: result.prompt + scenario.forbidden[0] });
    assert.deepEqual(polluted.unwanted, [scenario.forbidden[0]]);
    assert.equal(polluted.passed, false);
    assert.ok(evaluateRecall(world, scenario, { ...result, prompt: '' }).missing.includes('complete eligible Chronicle frontier'));
});

test('prepared supporting tokens cannot hide edits under the same record ID', async () => {
    const world = recallWorld(0);
    await prepareRetrievalCorpus(world);
    const query = [{ is_user: true, mes: 'What happened with the seal delivery?' }];
    const build = options => buildMemoryPrompt(world, query, 6000, CHAT_KEY, [], undefined, new Map(), options);
    assert.match(build().prompt, /only if Sol consented/);
    // Even before persistence advances the revision, fresh evidence must not
    // inherit the cached wrapper's body, temporal anchor or source visibility.
    Object.assign(world.threads[0], {
        detail: 'Mira planned delivery tomorrow, only if the keeper consented.',
        temporalAnchorId: 'revised-anchor', certainty: 'reported',
        sources: [{ chatKey: CHAT_KEY, from: 640, to: 647 }],
    });
    const edited = build();
    assert.match(edited.prompt, /tomorrow \(relative to revised-anchor\), only if the keeper consented/);
    assert.doesNotMatch(edited.prompt, /only if Sol consented|delivery-anchor/);
    assert.doesNotMatch(build({ rawTailRange: { from: 640, to: 647 } }).prompt, /only if the keeper consented/);
    world.revision++;
    await prepareRetrievalCorpus(world);
    assert.equal(build().prompt, edited.prompt);
});

test('prepared supporting tokens preserve different historical holders and conditions', async () => {
    const world = recallWorld(0);
    world.threads[0].history = [
        { title: 'Seal delivery', detail: 'Mira planned delivery only if Sol consented.', participants: ['Mira'], certainty: 'reported', sources: [{ chatKey: CHAT_KEY, from: 8, to: 15 }] },
        { title: 'Seal delivery', detail: 'Sol planned delivery only if Mira consented.', participants: ['Sol'], certainty: 'uncertain', sources: [{ chatKey: CHAT_KEY, from: 16, to: 23 }] },
    ];
    const query = [{ is_user: true, mes: 'What happened with the seal delivery?' }];
    const cold = buildMemoryPrompt(structuredClone(world), query, 6000, CHAT_KEY);
    await prepareRetrievalCorpus(world);
    const prepared = buildMemoryPrompt(world, query, 6000, CHAT_KEY);
    assert.equal(prepared.prompt, cold.prompt);
    assert.match(prepared.prompt, /Mira planned delivery only if Sol consented/);
    assert.match(prepared.prompt, /Sol planned delivery only if Mira consented/);
    assert.match(prepared.prompt, /reported/);
    assert.match(prepared.prompt, /uncertain/);
});
