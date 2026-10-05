import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_INJECTION_INSTRUCTION, PRE_LEAN_INJECTION_INSTRUCTIONS, CHARACTER_PROFILE_RULE, OOC_META_AUTHORITY_RULE, EPISTEMIC_MEMORY_RULES, CHRONICLE_HISTORY_RULE, SCENARIO_NOTE_RULE, PERSPECTIVE_SCOPE_RULE, PRE_PERSPECTIVE_SCOPE_OOC_META_AUTHORITY_RULE, PRE_PERSPECTIVE_SCOPE_EPISTEMIC_MEMORY_RULES, PRE_PERSPECTIVE_SCOPE_HIERARCHY_ATTRIBUTION_RULE, HIERARCHY_ATTRIBUTION_RULE, DEFAULT_CHRONICLE_SYSTEM_PROMPT } from '../extension/prompts.js';

const settingsUrl = new URL('../extension/settings.js', import.meta.url);
let instance = 0;

test('saved shipped prompts receive plain wording without resetting custom additions or memory bindings', async () => {
    const old = JSON.parse(readFileSync(new URL('./helpers/pre-plain-prompts.json', import.meta.url), 'utf8'));
    const current = (await loadSettings()).getSettings();
    for (const priorVersions of [{}, current]) {
        const { getSettings } = await loadSettings({
            ...priorVersions,
            extractionSystemPrompt: `Custom opening.\n${old.extractionSystemPrompt}\nCustom ending.`,
            chronicleSystemPrompt: `Custom Chronicle opening.\n${old.chronicleSystemPrompt}\nCustom Chronicle ending.`,
            chatWorlds: { 'character:1:chat:1': 'saved-world' },
        });
        const once = structuredClone(getSettings());
        const normalize = settings => Object.fromEntries(Object.entries(settings).map(([key, value]) => [
            key, typeof value === 'string' && key.endsWith('SystemPrompt') ? value.replace(/\n{2,}/g, '\n') : value,
        ]));
        assert.deepEqual(normalize(getSettings()), normalize(once), 'repeated reads do not duplicate rules or change settings');
        assert.equal(once.chatWorlds['character:1:chat:1'], 'saved-world');
        assert.ok(once.extractionSystemPrompt.includes('Custom opening.'));
        assert.ok(once.extractionSystemPrompt.includes('Custom ending.'));
        assert.ok(once.chronicleSystemPrompt.startsWith('Custom Chronicle opening.'));
        assert.ok(once.chronicleSystemPrompt.includes('Custom Chronicle ending.'));
        for (const rule of [CHARACTER_PROFILE_RULE, OOC_META_AUTHORITY_RULE, EPISTEMIC_MEMORY_RULES, CHRONICLE_HISTORY_RULE, SCENARIO_NOTE_RULE]) {
            assert.equal(once.extractionSystemPrompt.split(rule).length - 1, 1, rule);
        }
        assert.equal(once.chronicleSystemPrompt.split(CHRONICLE_HISTORY_RULE).length - 1, 1);
        assert.doesNotMatch(once.extractionSystemPrompt, /scenario's ontology|Knowledge is non-transitive|Work for a body|short-term plan/);
    }
});

test('saved attribution rules scope uncertainty once without losing custom instructions or bindings', async () => {
    const { getSettings } = await loadSettings({
        ...(await loadSettings()).getSettings(),
        epistemicPromptVersion: 9,
        extractionSystemPrompt: `Custom opening.\n${PRE_PERSPECTIVE_SCOPE_OOC_META_AUTHORITY_RULE}\n${PRE_PERSPECTIVE_SCOPE_EPISTEMIC_MEMORY_RULES}\nCustom ending.`,
        chronicleSystemPrompt: `Custom Chronicle opening.\n${DEFAULT_CHRONICLE_SYSTEM_PROMPT.replace(HIERARCHY_ATTRIBUTION_RULE, PRE_PERSPECTIVE_SCOPE_HIERARCHY_ATTRIBUTION_RULE)}\nCustom Chronicle ending.`,
        chatWorlds: { 'character:1:chat:1': 'saved-world' },
    });
    const once = structuredClone(getSettings());
    const normalize = settings => Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, typeof value === 'string' && key.endsWith('SystemPrompt') ? value.replace(/\n{2,}/g, '\n') : value]));
    assert.deepEqual(normalize(getSettings()), normalize(once), 'repeated reads retain one consistent set of rules');
    assert.equal(once.epistemicPromptVersion, 10);
    assert.equal(once.chatWorlds['character:1:chat:1'], 'saved-world');
    for (const prompt of [once.extractionSystemPrompt, once.chronicleSystemPrompt]) {
        assert.equal(prompt.split(PERSPECTIVE_SCOPE_RULE).length - 1, 1);
        assert.ok(prompt.includes('Custom'));
        assert.ok(prompt.includes('ending.'));
    }
    assert.ok(once.extractionSystemPrompt.includes(OOC_META_AUTHORITY_RULE));
    assert.doesNotMatch(once.extractionSystemPrompt, /Without an explicit OOC\/meta or scenario-note confirmation, character claims remain attributed claims/);
});

async function loadSettings(saved = {}) {
    // Exercise the real migrations with only SillyTavern's host API stubbed.
    let source = readFileSync(settingsUrl, 'utf8')
        .replace("import { saveSettingsDebounced } from '/script.js';", 'const saveSettingsDebounced = () => {};')
        .replace("import { extension_settings } from '/scripts/extensions.js';", `const extension_settings = { continuityMemory: ${JSON.stringify(saved)} };`)
        .replace("import { getContext } from '/scripts/st-context.js';", 'const getContext = () => ({});')
        .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, settingsUrl).href}'`);
    source += `\n// isolated settings instance ${++instance}\n`;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('fresh settings retain lean guidance without retired migration add-ons', async () => {
    const { getSettings } = await loadSettings();
    assert.equal(getSettings().injectionInstruction, DEFAULT_INJECTION_INSTRUCTION);
});

for (const [index, instruction] of PRE_LEAN_INJECTION_INSTRUCTIONS.entries()) {
    test(`lean guidance migrates shipped default ${index} with or without previous migrations`, async () => {
        const current = (await loadSettings()).getSettings();
        for (const saved of [{}, { ...current, leanInjectionInstructionVersion: 1 }]) {
            const { getSettings } = await loadSettings({ ...saved, injectionInstruction: instruction });
            assert.equal(getSettings().injectionInstruction, DEFAULT_INJECTION_INSTRUCTION);
            assert.equal(getSettings().injectionInstruction, DEFAULT_INJECTION_INSTRUCTION, 'migration is idempotent');
            assert.equal(getSettings().leanInjectionInstructionVersion, 2);
        }
    });
}

test('lean guidance migration preserves custom instructions, including modified old defaults', async () => {
    for (const instruction of ['', 'Write concise dialogue only, in French.', ...PRE_LEAN_INJECTION_INSTRUCTIONS.map(old => `${old} Custom requirement.`)]) {
        const { getSettings } = await loadSettings({ injectionInstruction: instruction, leanInjectionInstructionVersion: 1 });
        assert.equal(getSettings().injectionInstruction, instruction);
        assert.equal(getSettings().injectionInstruction, instruction);
    }
});

test('fresh settings use local retrieval and do not create retired Story controls', async () => {
    const { getSettings } = await loadSettings();
    const settings = getSettings();
    assert.equal(settings.retrievalMode, 'local');
    assert.equal(settings.retrievalDefaultVersion, 3);
    assert.equal(settings.retrievalQueryMessages, 6);
    assert.equal(settings.storySoFarEnabled, true);
    for (const key of ['storySoFarTokens', 'storySourceMode', 'storyBatchMessages', 'storyThinkingMode', 'storyProfileId', 'storyDirectUrl', 'storyDirectModel']) {
        assert.equal(Object.hasOwn(settings, key), false, key);
    }
});

for (const mode of ['local', 'ai-expanded', 'embedding-hybrid']) {
    test(`migration of ${mode} preserves saved configuration and memory bindings`, async () => {
        const saved = {
            retrievalMode: mode,
            retrievalDefaultVersion: 1,
            retrievalQueryMessages: 9,
            retrievalProfileId: 'saved-profile',
            retrievalDirectSecretId: 'opaque-secret-reference',
            storyDirectModel: 'legacy-model',
            storySoFarTokens: 4200,
            chatWorlds: { 'character:1:chat:test': 'world-1' },
            deletedWorldIds: ['world-2'],
        };
        const { getSettings } = await loadSettings(saved);
        const settings = getSettings();
        assert.equal(settings.retrievalMode, mode);
        for (const [key, value] of Object.entries(saved)) {
            if (['retrievalMode', 'retrievalDefaultVersion'].includes(key)) continue;
            assert.deepEqual(settings[key], value, key);
        }
        const trackedKeys = Object.keys(saved);
        const snapshot = value => Object.fromEntries(trackedKeys.map(key => [key, structuredClone(value[key])]));
        const migrated = snapshot(settings);
        assert.deepEqual(snapshot(getSettings()), migrated, 'retrieval migration must be idempotent');
    });
}

test('configuration reset restores local defaults without losing memory bindings', async () => {
    const { getSettings, resetConfigurationSettings } = await loadSettings({
        retrievalMode: 'embedding-hybrid', retrievalDefaultVersion: 2,
        chatWorlds: { chat: 'world' }, deletedWorldIds: ['deleted'],
        storyDirectModel: 'legacy-model',
    });
    resetConfigurationSettings();
    const settings = getSettings();
    assert.equal(settings.retrievalMode, 'local');
    assert.deepEqual(settings.chatWorlds, { chat: 'world' });
    assert.deepEqual(settings.deletedWorldIds, ['deleted']);
    assert.equal(settings.storyDirectModel, 'legacy-model');
});

test('visible retrieval controls describe only active behavior', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
    for (const id of ['story_so_far_tokens', 'embedding_messages']) {
        assert.doesNotMatch(html, new RegExp(`id="continuity_${id}"`));
        assert.doesNotMatch(ui, new RegExp(`#continuity_${id}['"]`));
    }
    assert.match(html, /value="ai-expanded"/);
    assert.match(html, /Local matching \(default/);
    assert.match(html, /Semantic embeddings &amp;|Semantic embeddings \+/);
    for (const key of ['embedding_top_k', 'embedding_threshold']) assert.ok(html.includes(`id="continuity_${key}"`));
    assert.match(html, /complete active Chronicle frontier is included without token clipping/);
    assert.match(html, /Soft packing target/);
    assert.match(html, /id="continuity_retrieval_messages"/);
    assert.doesNotMatch(index, /embeddingQueryMessages|resolveStoryBudget/);
    assert.doesNotMatch(ui, /embeddingQueryMessages|resolveStoryBudget/);
    assert.match(index, /await resolveRetrievalAssist/);
    assert.match(ui.slice(ui.indexOf('export async function previewInjection')), /settings\.retrievalQueryMessages/);
});
