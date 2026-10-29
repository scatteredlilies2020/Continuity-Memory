import assert from 'node:assert/strict';
import test from 'node:test';
import { createDetachedJob, getDetachedJob } from '../plugin/detached-jobs.js';

const extracted = {
    scene: { location: 'Road', time: '', participants: ['Alice'], activity: 'Walking', mood: '' },
    sceneCapsule: {
        title: 'Along the road', storyTime: '', location: 'Road', participants: ['Alice'],
        opening: 'Alice walks along the road.', beats: ['Alice continues walking.'],
        emotionalArc: '', closing: 'Alice continues walking.', importance: 2,
        temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'implicit' },
    },
    entities: [], identityResolutions: [], recordMerges: [], facts: [], states: [],
    relationships: [], events: [], threads: [], backgrounds: [],
    chronicleEntry: 'Alice walks along the road.',
};

function task(indexes) {
    const request = {
        model: 'gemini-test', max_tokens: 8192, reasoning_effort: 'high',
        custom_url: 'http://localhost/extractor',
        messages: [{ role: 'user', content: `Extract ${indexes.join(',')}.` }, { role: 'assistant', content: '{' }],
        continuity_prefill: { prefill: '{' },
    };
    return {
        messages: indexes.map(index => ({ index, name: 'Alice', text: 'Alice walks along the road.' })),
        request,
        fallbackRequest: { ...request, messages: [{ role: 'user', content: `Full fields for ${indexes.join(',')}.` }, request.messages[1]] },
        ...(indexes.length > 1 ? { parts: indexes.map(index => task([index])) } : {}),
    };
}

async function runExtraction(label, root, reply) {
    const req = { socket: { localPort: 3210 }, headers: {}, user: { directories: { root: `output-recovery-${label}` } } };
    let world = { id: 'world', name: 'Test', revision: 0, scene: null, entities: [], facts: [], states: [],
        relationships: [], events: [], capsules: [], chronicle: [], extractions: [], threads: [], backgrounds: [], sources: {} };
    const requests = [];
    let saves = 0;
    const { job } = createDetachedJob(req, { worldId: 'world', chatKey: 'chat', tasks: [root] }, {
        loadWorld: async () => structuredClone(world),
        saveWorld: async (_, value) => { saves++; world = structuredClone(value); },
    }, {
        fetchImpl: async (_, options) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            const replyValue = reply(body, requests.length, saves);
            const finish = typeof replyValue === 'string' ? replyValue : replyValue.finish;
            return new Response(JSON.stringify({ choices: [{
                message: { content: JSON.stringify(replyValue.content ?? extracted) }, finish_reason: finish,
            }] }));
        },
    });
    const deadline = Date.now() + 2000;
    while (['queued', 'processing'].includes(getDetachedJob(req, job.id).status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    return { finished: getDetachedJob(req, job.id), requests, saves, world };
}

test('detached single-message truncation retries with more capacity and saves only the complete response', async () => {
    const result = await runExtraction('single', task([0]), (body, attempt, saves) => {
        assert.equal(saves, 0);
        return attempt === 1 ? 'length' : 'stop';
    });
    assert.equal(result.finished.status, 'complete', result.finished.error);
    assert.deepEqual(result.requests.map(body => body.max_tokens), [8192, 16384]);
    const recovery = result.requests[1];
    assert.equal(recovery.reasoning_effort, 'high');
    assert.equal(recovery.custom_url, 'http://localhost/extractor');
    assert.match(recovery.messages[0].content, /Full fields/);
    assert.match(recovery.messages.at(-2).content, /one complete JSON object/);
    assert.deepEqual(recovery.messages.at(-1), { role: 'assistant', content: '{' });
    assert.equal(result.saves, 1);
    assert.equal(result.world.sources.chat.processedMessages.length, 1);
});

test('a truncated batch splits before its single-message leaf uses recovery', async () => {
    const result = await runExtraction('split', task([0, 1]), (_body, attempt) => attempt < 3 ? 'length' : 'stop');
    assert.equal(result.finished.status, 'complete', result.finished.error);
    assert.deepEqual(result.requests.map(body => body.max_tokens), [8192, 8192, 16384, 8192]);
    assert.equal(result.finished.splits, 1);
    assert.equal(result.saves, 2);
    assert.equal(result.world.sources.chat.processedMessages.length, 2);
});

test('persistent native MAX_TOKENS output limits stop after one recovery and save no coverage', async () => {
    const result = await runExtraction('persistent', task([0]), () => 'MAX_TOKENS');
    assert.equal(result.finished.status, 'error');
    assert.match(result.finished.error, /output limit/);
    assert.equal(result.requests.length, 2);
    assert.equal(result.saves, 0);
    assert.deepEqual(result.world.sources, {});
});

test('truncation after a malformed response still gets exactly one capacity recovery', async () => {
    const result = await runExtraction('late-limit', task([0]), (body, attempt) => {
        // A malformed first result consumes the normal corrective retry.
        return { finish: attempt === 2 ? 'length' : 'stop',
            content: attempt === 1 ? { ...extracted, facts: null } : extracted };
    });
    assert.equal(result.finished.status, 'complete', result.finished.error);
    assert.deepEqual(result.requests.map(body => body.max_tokens), [8192, 8192, 16384]);
    assert.equal(result.saves, 1);
});
