import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatStructuredResponseGuide, schemaFieldGuide } from '../extension/extraction-contract.js';
import { parseJsonResponse } from '../extension/json-response.js';
import * as prefill from '../extension/preset-prefill.js';
import * as profile from '../extension/profile-request-policy.js';
import * as thinking from '../extension/thinking-policy.js';
import { augmentCorrectionChronology, selectCorrectionContext, validateCorrectionProposal } from '../extension/memory-correction.js';

const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
function load(name, dependencies) {
    const start = engine.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    const end = start + engine.slice(start).search(/^\}$/m) + 1;
    return new Function(...Object.keys(dependencies), `${engine.slice(start, end).replace(/^export /, '')}; return ${name};`)(...Object.values(dependencies));
}

const constants = engine.slice(engine.indexOf('const correctionSchema ='), engine.indexOf('const ARC_JSON_SHAPE_EXAMPLE ='));
const contract = new Function('formatStructuredResponseGuide', 'schemaFieldGuide',
    `${constants}; return { correctionSchema, correctionJsonSchema, CORRECTION_SYSTEM_PROMPT };`)(formatStructuredResponseGuide, schemaFieldGuide);
const guide = formatStructuredResponseGuide(schemaFieldGuide(contract.correctionSchema));
const plan = {
    summary: 'Alice prefers cake.',
    operations: [{ action: 'update', category: 'facts', targetId: 'fact-snack', reason: 'The user corrected the preference.',
        recordJson: JSON.stringify({ subject: 'Alice', predicate: 'favorite snack', value: 'cake', category: 'preference', importance: 3, persistence: 'persistent' }),
        futurePolicy: 'allow-supported-change' }],
};
const json = JSON.stringify(plan);
const openPrefix = '<think>Consider the stored records.\n';

function setup(profileId, prefix, response, { rejectSchema = false } = {}) {
    const world = { id: 'world', revision: 1,
        entities: [], states: [], relationships: [], events: [], capsules: [], threads: [], backgrounds: [],
        facts: [{ id: 'fact-snack', subject: 'Alice', predicate: 'favorite snack', value: 'bread', category: 'preference', importance: 3, persistence: 'persistent', sources: [] }] };
    const before = structuredClone(world.facts);
    const settings = { memoryProfileId: profileId, correctionProfileId: '', thinkingMode: 'off' };
    const requests = [];
    const answer = body => {
        requests.push(body);
        assert.ok(body.messages[0].content.includes(guide), 'the correction format must survive without a native schema');
        assert.ok(body.messages[1].content.includes('fact-snack'));
        assert.equal(prefill.requestPrefill(body.messages), prefix);
        if (prefix) assert.ok(!body.json_schema, 'prefill requests use the prompt format instead of a native schema');
        if (rejectSchema && requests.length === 1) {
            assert.ok(body.json_schema);
            throw new Error('JSON schema unsupported');
        }
        return response;
    };
    const deps = {
        ...prefill, ...profile, ...thinking, ...contract,
        runtime: { world, health: { schemaVersion: 7 }, generation: 0, paused: true },
        getSettings: () => settings, getBoundWorldId: () => world.id, getChatKey: () => 'chat', getContext: () => ({ chat: [] }),
        selectCorrectionContext, validateCorrectionProposal, augmentCorrectionChronology, parseJsonResponse,
        resolveCorrectionResponseTokens: () => 8000,
        DIRECT_PROFILE_ID: '__direct__', resolveMemoryPrefill: () => prefix, resolveThinkingModeForProfile: mode => mode,
        resolveMemoryResponseTokens: () => undefined, outputTokenPayload: () => ({}), updateRuntime: () => {},
        directRequestConfig: () => ({ provider: 'custom', model: 'gpt-5.6-luna', url: 'https://example.invalid' }),
        prepareMemoryRequest: async body => ({ ...body, continuity_prefill: { prefill: prefill.requestPrefill(body.messages) } }),
        generateEndpointMemory: async () => null, applyExtractionRequestSettings: () => {}, getRequestHeaders: () => ({}),
        console: { warn() {} }, assertCompletionNotTruncated: () => {}, extractMessageFromData: value => value,
        generateRaw: async options => answer({ json_schema: options.jsonSchema,
            messages: prefill.memoryRequestMessages(options.prompt, options.systemPrompt, options.prefill) }),
        fetch: async (_, options) => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: answer(JSON.parse(options.body)) } }] }) }),
        ConnectionManagerRequestService: {
            getProfile: () => ({ name: 'Luna', model: 'gpt-5.6-luna' }),
            validateProfile: () => ({ source: 'custom', selected: 'openai' }),
            sendRequest: async (_, messages, maxTokens, options, payload) => answer({ ...payload, messages }),
        },
    };
    deps.rootErrorMessage = load('rootErrorMessage', deps);
    deps.shouldRetryWithoutSchema = load('shouldRetryWithoutSchema', deps);
    deps.generateWithThinkingPolicy = load('generateWithThinkingPolicy', { ...deps, activeExtractionThinkingMode: null });
    deps.requestDirectStructured = load('requestDirectStructured', deps);
    deps.extractProfileResponse = load('extractProfileResponse', deps);
    deps.sendMemoryProfileRequest = (...args) => deps.ConnectionManagerRequestService.sendRequest(...args);
    deps.requestStructured = load('requestStructured', deps);
    return { review: load('reviewMemoryCorrection', deps), requests, world, before };
}

for (const profileId of ['', '__direct__', 'luna-profile']) {
    const route = profileId || 'active';
    for (const sample of [
        { name: 'native open reasoning prefix', prefix: openPrefix, response: json },
        { name: 'echoed open reasoning prefix', prefix: openPrefix, response: `${openPrefix}Final answer:\n${json}` },
        { name: 'continued reasoning with a closing tag', prefix: openPrefix, response: `Completed the review.</think>\n${json}` },
        { name: 'partial JSON prefix', prefix: '{"summary":', response: json.slice('{"summary":'.length) },
    ]) test(`${route}: correction review accepts ${sample.name} with format instructions`, async () => {
        const fixture = setup(profileId, sample.prefix, sample.response);
        const proposal = await fixture.review('Alice prefers cake, not bread.');
        assert.equal(proposal.operations[0].replacement.value, 'cake');
        assert.equal(fixture.requests.length, 1);
        assert.deepEqual(fixture.world.facts, fixture.before, 'review must not apply the proposed correction');
    });

    test(`${route}: correction schema fallback retains the complete format`, async () => {
        const fixture = setup(profileId, '', json, { rejectSchema: true });
        const proposal = await fixture.review('Alice prefers cake, not bread.');
        assert.equal(proposal.operations[0].replacement.value, 'cake');
        assert.equal(fixture.requests.length, 2);
        assert.ok(!fixture.requests[1].json_schema);
    });

    for (const sample of [
        { name: 'truncated JSON', response: `${openPrefix}Final answer:\n${json.slice(0, -1)}`, error: /incomplete/ },
        { name: 'wrong correction shape', response: `${openPrefix}{"facts":[]}`, error: /no summary/ },
        { name: 'closed reasoning without an answer', response: `${openPrefix}${json}</think>`, error: /valid JSON object/ },
    ]) test(`${route}: correction review rejects ${sample.name} after an open prefix`, async () => {
        const fixture = setup(profileId, openPrefix, sample.response);
        await assert.rejects(fixture.review('Alice prefers cake, not bread.'), sample.error);
        assert.deepEqual(fixture.world.facts, fixture.before);
    });
}
