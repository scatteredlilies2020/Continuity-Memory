import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCorrectionProposal, formatCorrectionPreview, isSuppressedByCorrection, validateCorrectionProposal } from '../extension/memory-correction.js';
import { mergeExtraction, resetWorldMemory, undoLatestDigestExtraction } from '../extension/memory-model.js';
import { sanitizeStateDurability } from '../extension/reconciliation-policy.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { buildHierarchySystemPrompt, HIERARCHY_CONCISION_RULES, PRE_FLEXIBLE_HIERARCHY_CONCISION_RULES, INJECTION_GUIDANCE } from '../extension/prompts.js';
import { createContinuationPackage, prepareContinuationWorld } from '../extension/continuation-handoff.js';
import { forkWorldToBranch } from '../extension/branch-cache.js';
import { fingerprintMessage } from '../extension/message-digest.js';

function world() {
    return { id: 'flexibility', scene: null, entities: [], facts: [], states: [], relationships: [], events: [],
        threads: [], backgrounds: [], capsules: [], arcs: [], eras: [], extractions: [], corrections: [], sources: {} };
}

function digest(target, from, changes = {}, meta = {}) {
    return mergeExtraction(target, {
        scene: null, entities: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [],
        sceneCapsule: { title: `Scene ${from}`, storyTime: '', location: '', participants: ['Mira'],
            opening: 'Mira considers the situation.', beats: [], emotionalArc: '', closing: 'The scene continues.', importance: 2 },
        ...changes,
    }, { chatKey: 'chat', from, to: from + 7, allowStateUpdates: true, messageFingerprints: [], ...meta });
}

function state(value, extra = {}) {
    return { subject: 'Mira', attribute: 'condition', value, previous: '', scope: 'ongoing', operation: 'set', importance: 4, ...extra };
}

function correct(target, category, record, replacement, extra = {}) {
    const proposal = validateCorrectionProposal(target, { summary: 'Correct the recorded condition.', operations: [{
        action: 'update', category, targetId: record.id, reason: 'The source was misread.', recordJson: JSON.stringify(replacement), ...extra,
    }] }, 'Correct this observation without freezing future developments.');
    applyCorrectionProposal(target, proposal);
    return proposal;
}

test('reviewed mutable correction protects old/overlapping ranges but allows later set and clear', () => {
    const target = world();
    digest(target, 0, { states: [state('injured')] });
    const id = target.states[0].id;
    const proposal = correct(target, 'states', target.states[0], state('healing'));
    assert.match(formatCorrectionPreview(proposal), /later source-supported changes are allowed/);
    for (const meta of [ {}, { chatKey: 'chat', from: 0, to: 7 }, { chatKey: 'chat', from: 7, to: 14 },
        { chatKey: 'other', from: 8, to: 15 }, { chatKey: 'chat', from: 8, to: 15, allowStateUpdates: false } ]) {
        assert.equal(isSuppressedByCorrection(target, 'states', state('injured'), meta), true);
    }
    digest(target, 0, { states: [state('injured', { targetId: id })] });
    assert.equal(target.states[0].value, 'healing');
    digest(target, 8, { states: [state('recovered', { previous: 'healing', targetId: id })] });
    assert.equal(target.states[0].value, 'recovered');
    assert.equal(target.states[0].correctionId, undefined);
    digest(target, 16, { states: [state('', { operation: 'clear', targetId: id })] });
    assert.equal(target.states.length, 0);
    assert.equal(target.corrections[0].operations[0].after.value, 'healing');
});

test('correction frontier covers the whole known chat, not only the old record source', () => {
    const target = world();
    digest(target, 0, { states: [state('injured')] });
    digest(target, 8);
    correct(target, 'states', target.states[0], state('healing'));
    digest(target, 8, { states: [state('injured')] });
    assert.equal(target.states[0].value, 'healing');
    digest(target, 16, { states: [state('recovered')] });
    assert.equal(target.states[0].value, 'recovered');
});

test('serialized correction baseline survives evolution, Undo, and preserve-corrections reset', () => {
    let target = world();
    digest(target, 0, { states: [state('injured')] });
    correct(target, 'states', target.states[0], state('healing'));
    target = JSON.parse(JSON.stringify(target));
    digest(target, 8, { states: [state('recovered')] });
    undoLatestDigestExtraction(target, 'chat');
    assert.equal(target.states[0].value, 'healing');
    assert.ok(target.states[0].correctionId);
    digest(target, 8, { states: [state('', { operation: 'clear' })] });
    assert.equal(target.states.length, 0);
    resetWorldMemory(target, { preserveCorrections: true });
    assert.equal(target.states[0].value, 'healing');
    assert.ok(target.states[0].correctionId);
});

test('explicit standing corrections remain locked and old saves fail closed', () => {
    for (const legacy of [false, true]) {
        const target = world();
        digest(target, 0, { states: [state('injured')] });
        correct(target, 'states', target.states[0], state('immortal'), { futurePolicy: 'keep-until-corrected' });
        if (legacy) for (const operation of target.corrections[0].operations) {
            delete operation.futurePolicy;
            delete operation.protectedThrough;
            delete operation.afterRecord;
        }
        digest(target, 8, { states: [state('dead')] });
        assert.equal(target.states[0].value, 'immortal');
    }
});

test('a newly reviewed policy supersedes an older standing lock for the same record', () => {
    const target = world();
    digest(target, 0, { states: [state('injured')] });
    correct(target, 'states', target.states[0], state('immortal'), { futurePolicy: 'keep-until-corrected' });
    correct(target, 'states', target.states[0], state('healing'), { futurePolicy: 'allow-supported-change' });
    digest(target, 8, { states: [state('recovered')] });
    assert.equal(target.states[0].value, 'recovered');
    undoLatestDigestExtraction(target, 'chat');
    assert.equal(target.states[0].value, 'healing');
});

test('correction review also protects already visible but unextracted chat', () => {
    const target = world();
    digest(target, 0, { states: [state('injured')] });
    const proposal = validateCorrectionProposal(target, { summary: 'Correct condition.', operations: [{
        action: 'update', category: 'states', targetId: target.states[0].id, recordJson: JSON.stringify(state('healing')),
    }] });
    applyCorrectionProposal(target, proposal, { chatKey: 'chat', to: 15 });
    digest(target, 8, { states: [state('injured')] });
    assert.equal(target.states[0].value, 'healing');
    digest(target, 16, { states: [state('recovered')] });
    assert.equal(target.states[0].value, 'recovered');
});

test('later relationship and supporting observations can change reviewed mutable records', () => {
    for (const [category, initial, corrected, later, field] of [
        ['relationships', { from: 'Mira', to: 'Sol', kind: 'connection', status: 'hostile', dynamic: 'They distrust each other.' },
            { status: 'neutral', dynamic: 'They are cautious acquaintances.' }, { status: 'friendly', dynamic: 'They trust one another.' }, 'status'],
        ['threads', { title: 'The silver key', detail: 'Mira thinks the key is lost.', status: 'recorded', participants: ['Mira'] },
            { detail: 'Mira thinks the key is stolen.' }, { detail: 'Mira finds the key in the desk.' }, 'detail'],
        ['backgrounds', { topic: 'The silver gate', summary: 'Mira sees a closed gate.', status: 'recorded', certainty: 'observed', participants: ['Mira'] },
            { summary: 'Mira sees a locked gate.' }, { summary: 'Mira sees the gate open.' }, 'summary'],
    ]) {
        const target = world();
        digest(target, 0, { [category]: [initial] });
        const record = target[category][0];
        correct(target, category, record, { ...initial, ...corrected });
        digest(target, 8, { [category]: [{ ...initial, ...later, targetId: record.id }] });
        assert.equal(target[category][0][field], later[field], category);
        undoLatestDigestExtraction(target, 'chat');
        assert.equal(target[category][0][field], corrected[field], `${category} undo`);
    }
});

test('reviewed facts may evolve explicitly, while fixed historical corrections stay protected', () => {
    const target = world();
    const fact = { subject: 'Mira', predicate: 'belief about the key', value: 'lost', category: 'character belief', persistence: 'persistent', importance: 4 };
    digest(target, 0, { facts: [fact] });
    correct(target, 'facts', target.facts[0], { ...fact, value: 'stolen' }, { futurePolicy: 'allow-supported-change' });
    digest(target, 8, { facts: [{ ...fact, value: 'hidden in the desk' }] });
    assert.equal(target.facts[0].value, 'hidden in the desk');
    undoLatestDigestExtraction(target, 'chat');
    assert.equal(target.facts[0].value, 'stolen');
    const event = { id: 'event', title: 'A storm', summary: 'Rain fell.', sources: [{ chatKey: 'chat', from: 0, to: 7 }] };
    target.events.push(event);
    const proposal = correct(target, 'events', event, { ...event, summary: 'Snow fell.' }, { futurePolicy: 'allow-supported-change' });
    assert.equal(proposal.operations[0].futurePolicy, 'keep-until-corrected');
});

test('deleted mutable records can recur only after the reviewed boundary', () => {
    const target = world();
    digest(target, 0, { states: [state('injured')] });
    correct(target, 'states', target.states[0], {}, { action: 'delete' });
    digest(target, 0, { states: [state('injured')] });
    assert.equal(target.states.length, 0);
    digest(target, 8, { states: [state('newly injured')] });
    assert.equal(target.states[0].value, 'newly injured');
});

test('scene corrections expire normally after the protected interval', () => {
    const target = world();
    digest(target, 0, { states: [state('tower', { attribute: 'location', scope: 'scene' })] });
    correct(target, 'states', target.states[0], state('harbor', { attribute: 'location', scope: 'scene' }));
    digest(target, 8);
    assert.equal(target.states.length, 0);
    undoLatestDigestExtraction(target, 'chat');
    assert.equal(target.states[0].value, 'harbor');
});

test('explicit continuation permits new conditions while Undo restores inherited correction', () => {
    const target = world();
    target.name = 'Mira’s journey';
    digest(target, 0, { states: [state('injured')] });
    correct(target, 'states', target.states[0], state('healing'));
    const continued = prepareContinuationWorld(createContinuationPackage(target), { chatKey: 'next' });
    digest(continued, 0, { states: [state('recovered')] }, { chatKey: 'next' });
    assert.equal(continued.states[0].value, 'recovered');
    undoLatestDigestExtraction(continued, 'next');
    assert.equal(continued.states[0].value, 'healing');
    assert.equal(continued.states[0].sources[0].chatKey, continued.continuation.inheritedChatKey);
    assert.equal(target.states[0].value, 'healing');
});

test('branch replay remaps correction boundaries and snapshots without freezing future updates', () => {
    const target = world();
    const messages = Array.from({ length: 18 }, (_, index) => ({ index, name: 'Mira', text: `Message ${index}`, isUser: index % 2 === 0 }));
    const fingerprints = from => messages.slice(from, from + 8).map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) }));
    digest(target, 0, { states: [state('injured')] }, { messageFingerprints: fingerprints(0) });
    correct(target, 'states', target.states[0], state('healing'));
    digest(target, 8, {}, { messageFingerprints: fingerprints(8) });
    const branched = forkWorldToBranch(target, messages, 'branch', 'chat');
    assert.equal(branched.ok, true);
    const operation = branched.world.corrections[0].operations[0];
    assert.equal(operation.protectedThrough.branch, 7);
    assert.equal(operation.protectedThrough.chat, undefined);
    assert.equal(operation.afterRecord.sources[0].chatKey, 'branch');
    digest(branched.world, 16, { states: [state('recovered')] }, { chatKey: 'branch' });
    assert.equal(branched.world.states[0].value, 'recovered');
    undoLatestDigestExtraction(branched.world, 'branch');
    assert.equal(branched.world.states[0].value, 'healing');
    assert.equal(target.states[0].value, 'healing');
});

test('a truncated branch does not inherit temporal locks over parent-only future messages', () => {
    const target = world();
    const messages = Array.from({ length: 32 }, (_, index) => ({ index, name: 'Mira', text: `Message ${index}`, isUser: index % 2 === 0 }));
    for (const from of [0, 8, 16, 24]) digest(target, from, from === 0 ? { states: [state('injured')] } : {}, {
        messageFingerprints: messages.slice(from, from + 8).map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
    });
    correct(target, 'states', target.states[0], state('healing'));
    const branched = forkWorldToBranch(target, messages.slice(0, 16), 'branch', 'chat');
    assert.equal(branched.ok, true);
    assert.equal(branched.world.corrections[0].operations[0].protectedThrough.branch, 15);
    digest(branched.world, 16, { states: [state('recovered')] }, { chatKey: 'branch' });
    assert.equal(branched.world.states[0].value, 'recovered');
});

test('durability is independent of English keywords, paraphrase, and language', () => {
    const values = ['wearing a permanent enchanted collar that cannot be removed',
        'equipped with a permanent enchanted collar that cannot be removed',
        'waiting for a century-long prophecy to be fulfilled', '永久に外せない魔法の首輪を着けている',
        'No injury can penetrate the enchanted skin.'];
    const result = { states: values.map(value => state(value, { attribute: 'physical condition' })) };
    assert.deepEqual(sanitizeStateDurability(result), { discarded: 0, demoted: 0 });
    assert.deepEqual(result.states.map(item => item.value), values);
    assert.ok(result.states.every(item => item.scope === 'ongoing'));
});

test('last-known recall stays scoped and excludes invalid sources and the raw tail', () => {
    const target = world();
    digest(target, 0, { states: [state('Unhealed silver burn')] });
    digest(target, 8);
    const recall = (chatKey, options = {}) => buildMemoryPrompt(target, [{ mes: 'What about Mira’s silver burn?' }], 3000, chatKey, [], undefined, new Map(), options).prompt;
    assert.match(recall('chat'), /\[last-known; not confirmed current\].*Unhealed silver burn/);
    assert.doesNotMatch(recall('other'), /Unhealed silver burn/);
    assert.doesNotMatch(recall('chat', { invalidSourceRanges: [{ chatKey: 'chat', from: 0, to: 7 }] }), /Unhealed silver burn/);
    assert.doesNotMatch(recall('chat', { rawTailRange: { from: 0, to: 15 } }), /Unhealed silver burn/);
});

test('short writer guidance preserves custom additions without hidden paragraphs', () => {
    const custom = 'Write concise dialogue only, in French.';
    const { prompt } = buildMemoryPrompt(world(), [{ mes: 'Continue.' }], 1800, 'chat', [], custom);
    assert.equal(prompt, `<continuity>\n${INJECTION_GUIDANCE}\n${custom}\n</continuity>`);
});

test('default continuity guidance stays lean without duplicating rules', () => {
    const { prompt } = buildMemoryPrompt(world(), [{ mes: 'Continue.' }], 1800, 'chat');
    assert.equal(prompt, `<continuity>\n${INJECTION_GUIDANCE}\n</continuity>`);
    assert.ok(INJECTION_GUIDANCE.split(/\s+/u).length <= 20);
});

test('blank or repeated optional instructions do not duplicate the hardcoded line', () => {
    for (const custom of ['', '   ', INJECTION_GUIDANCE]) {
        const { prompt } = buildMemoryPrompt(world(), [], 1800, 'chat', [], custom);
        assert.equal(prompt, `<continuity>\n${INJECTION_GUIDANCE}\n</continuity>`);
    }
});

test('hierarchy honors custom brevity and upgrades only the exact old shipped rule', () => {
    const custom = 'Make the parent shorter than its children. Use a neutral tone.';
    const prompt = buildHierarchySystemPrompt(`${custom}\n${PRE_FLEXIBLE_HIERARCHY_CONCISION_RULES}`);
    assert.ok(prompt.includes(custom));
    assert.ok(prompt.includes(HIERARCHY_CONCISION_RULES));
    assert.doesNotMatch(prompt, /a parent need not be shorter|Use all space needed|never information/);
    assert.match(prompt, /Respect the requested length, format, and level of detail/);
});
