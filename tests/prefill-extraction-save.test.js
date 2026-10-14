import assert from 'node:assert/strict';
import test from 'node:test';
import { createDetachedJob, getDetachedJob } from '../plugin/detached-jobs.js';

const extracted = {
    scene: { location: 'Road', time: '', participants: ['Alice'], activity: 'Walking', mood: '' },
    sceneCapsule: {
        title: 'Along the road', storyTime: '', location: 'Road', participants: ['Alice'],
        opening: 'Alice walks along the road.', beats: ['Alice says her favorite snack is cake.'],
        emotionalArc: '', closing: 'Alice continues walking.', importance: 2,
        temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'implicit' },
    },
    entities: [], identityResolutions: [], recordMerges: [],
    facts: [{ targetId: '', subject: 'Alice', predicate: 'favorite snack', value: 'cake', category: 'preference', importance: 3, persistence: 'persistent' }],
    states: [], relationships: [], events: [], threads: [], backgrounds: [],
    chronicleEntry: 'Alice walks along the road and says her favorite snack is cake.',
};
const json = JSON.stringify(extracted);
const prefix = '<think>Consider the source.\n';

const cases = [
    { name: 'native open reasoning prefill', prefill: prefix, text: `Final answer:\n${json}`, valid: true },
    { name: 'echoed open reasoning prefill', prefill: prefix, text: `${prefix}Final answer:\n${json}`, valid: true },
    { name: 'complete fenced response to a JSON prefill', prefill: '{', text: `Here is the extraction:\n\`\`\`json\n${json}\n\`\`\``, valid: true },
    { name: 'structured string with an open reasoning wrapper', prefill: prefix,
        structured: { nlToken: '<NL>' }, text: JSON.stringify({ value: `${prefix}Final answer:\n${json}`.replaceAll('\n', '<NL>') }), valid: true },
    { name: 'Gemini fields with an open reasoning wrapper', prefill: prefix,
        structured: { multiField: true, keys: ['p0', 'p1'] }, text: JSON.stringify({ p1: json, p0: prefix }), valid: true },
    { name: 'truncated JSON after an open reasoning prefill', prefill: prefix, text: `Final answer:\n${json.slice(0, -1)}`, valid: false },
    { name: 'malformed JSON after an open reasoning prefill', prefill: prefix, text: `Final answer:\n${json.slice(0, -1)},}`, valid: false },
    { name: 'wrong extraction shape after an open reasoning prefill', prefill: prefix, text: '{"draft":true}', valid: false },
    { name: 'closed reasoning containing only a draft', prefill: prefix, text: `${prefix}${json}</think>`, valid: false },
];

for (const sample of cases) test(`${sample.name} ${sample.valid ? 'saves memory and coverage' : 'saves no memory or coverage'}`, async () => {
    const req = { socket: { localPort: 3210 }, headers: {}, user: { directories: { root: `prefill-save-${sample.name}` } } };
    let world = {
        id: 'world', name: 'Test', revision: 0, scene: null,
        entities: [], facts: [], states: [], relationships: [], events: [], capsules: [],
        chronicle: [], extractions: [], threads: [], backgrounds: [], sources: {},
    };
    const before = structuredClone(world);
    let requests = 0;
    let saves = 0;
    const { job } = createDetachedJob(req, {
        worldId: world.id, chatKey: 'chat', tasks: [{
            messages: [{ index: 0, name: 'Alice', text: 'Alice walks along the road. Alice says her favorite snack is cake.' }],
            request: {
                model: 'test', messages: [{ role: 'user', content: 'Extract memory.' }, { role: 'assistant', content: sample.prefill }],
                continuity_prefill: { prefill: sample.prefill, structured: sample.structured },
            },
        }],
    }, {
        loadWorld: async () => structuredClone(world),
        saveWorld: async (_, value) => { saves++; world = structuredClone(value); },
    }, {
        fetchImpl: async (_, options) => {
            requests++;
            assert.equal(JSON.parse(options.body).continuity_prefill, undefined);
            return new Response(JSON.stringify({ choices: [{ message: { content: sample.text }, finish_reason: 'stop' }] }));
        },
    });
    const deadline = Date.now() + 2000;
    while (['queued', 'running'].includes(getDetachedJob(req, job.id).status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    const finished = getDetachedJob(req, job.id);
    assert.equal(finished.status, sample.valid ? 'complete' : 'error', finished.error);
    assert.equal(requests, sample.valid ? 1 : 2);
    assert.equal(saves, sample.valid ? 1 : 0);
    if (sample.valid) {
        assert.ok(world.facts.some(fact => fact.subject === 'Alice' && fact.value === 'cake'));
        assert.equal(world.capsules.length, 1);
        assert.equal(world.sources.chat.lastProcessedIndex, 0);
        assert.equal(world.sources.chat.processedMessages.length, 1);
    } else {
        assert.deepEqual(world, before);
    }
});
