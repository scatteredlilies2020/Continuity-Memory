// Optional source-compatibility check. No network, credentials, or inference.
// Usage: node scripts/check-prefill-host.mjs <grab990 checkout> <upstream snapshot directory>
// Snapshot filenames: {release,staging}-{openai.js,script.js,shared.js,prompt-converters.js}.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStructuredPrefillSchema } from '../extension/structured-prefill-schema.js';
import { memoryRequestMessages } from '../extension/preset-prefill.js';

const [fork, snapshots] = process.argv.slice(2);
if (!fork || !snapshots) throw new Error('Supply a fork checkout and upstream snapshot directory.');
function fn(source, name) {
    const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, `Host exports/defines ${name}`);
    const end = start + source.slice(start).search(/^\}\s*$/m) + 1;
    return source.slice(start, end).replace(/^export /, '');
}
const source = readFileSync(join(fork, 'public/scripts/openai.js'), 'utf8');
const encoderNames = ['escapeRegexForSchema', 'escapePrefixLiteral', 'getStructuredPrefillPatternMode',
    'isGeminiSource', 'anyCharPattern', 'curlyQuoteLiteralsOutsideSlots', 'buildSlotRegex', 'buildPrefixRegex',
    'buildGeminiStructuredPrefillSchema', 'buildStructuredPrefillSchema'];
const referenceEncoder = new Function('chat_completion_sources', `${encoderNames.map(name => fn(source, name)).join('\n')}; return buildStructuredPrefillSchema;`)({ CLAUDE: 'claude' });
let cases = 0;
for (const [provider, model] of [['makersuite', 'gemini-test'], ['vertexai', 'gemini-test'], ['claude', 'claude-test'], ['openrouter', 'vendor/claude-test'], ['custom', 'model']]) {
    for (const prefix of ['Prefix\n', 'A [[w:2-3]] B', '[[opt:a|b]] [[free]]', '[[keep]]first\r\nsecond', '<NL>collision\n', '[[re:a+]]']) {
        const settings = { structured_prefill_min_length: 1 };
        assert.deepEqual(buildStructuredPrefillSchema(prefix, settings, provider, model), referenceEncoder(prefix, settings, provider, model));
        cases++;
    }
}
// Real fork SDK converter: verify schema/proxy retention, not just mocks.
const sdkSource = readFileSync(join(fork, 'public/scripts/sdk-options.js'), 'utf8');
const capabilities = { mode: 'unknown', effort: { map: {} }, thinking: { supported: false } };
const toSdkRequest = new Function('resolveReasoningCapabilities', 'isKimiK3Model', 'REASONING_TOGGLE_TYPES', 'getProviderReasoningEffort',
    `${fn(sdkSource, 'googleThinkingBudget')}\n${fn(sdkSource, 'toSdkRequest')}; return toSdkRequest;`)(() => capabilities, () => false, {}, (_, value) => value);
for (const provider of ['custom', 'makersuite', 'vertexai', 'claude', 'openrouter']) {
    const body = { chat_completion_source: provider, model: 'model', max_tokens: 128, reverse_proxy: 'https://proxy.example.invalid',
        proxy_password: 'fabricated-test-only', secret_id: 'fake-reference', json_schema: { value: { type: 'object' } }, messages: memoryRequestMessages('task', 'system', '{') };
    const result = toSdkRequest(structuredClone(body));
    for (const key of ['reverse_proxy', 'proxy_password', 'secret_id', 'json_schema', 'messages']) assert.deepEqual(result[key], body[key]);
    assert.equal(result.maxOutputTokens, 128);
    cases++;
}
for (const branch of ['release', 'staging']) {
    const script = readFileSync(join(snapshots, `${branch}-script.js`), 'utf8');
    const shared = readFileSync(join(snapshots, `${branch}-shared.js`), 'utf8');
    const openai = readFileSync(join(snapshots, `${branch}-openai.js`), 'utf8');
    const converters = readFileSync(join(snapshots, `${branch}-prompt-converters.js`), 'utf8');
    assert.match(script, /prompt\.push\(\{ role: 'assistant', content: prefill \}\)/);
    assert.match(shared, /reverse_proxy: proxyPreset\?\.url/);
    assert.match(shared, /proxy_password: proxyPreset\?\.password/);
    assert.match(shared, /\.\.\.overridePayload/);
    assert.doesNotMatch(openai, /export function consumeStructuredPrefillInfo/);
    const addPrefix = new Function(`${fn(converters, 'addAssistantPrefix')}; return addAssistantPrefix;`)();
    for (const flag of ['prefix', 'partial']) {
        const messages = addPrefix(memoryRequestMessages('task', 'system', '{'), [], flag);
        assert.equal(messages.at(-1).content, '{');
        assert.equal(messages.at(-1)[flag], true);
        cases++;
    }
    const convertClaude = new Function('humanMsgFix', `${fn(converters, 'convertClaudeMessages')}; return convertClaudeMessages;`)('Hello');
    const result = convertClaude(memoryRequestMessages('task', 'system', '{'), '', true, false, {});
    assert.equal(result.messages.at(-1).role, 'assistant');
    assert.ok(JSON.stringify(result.messages.at(-1).content).includes('{'));
    cases++;
}
console.log(`Host source compatibility: ${cases} checks passed (fork encoders/SDK, upstream release/staging native converters and proxy routing).`);
