import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsUrl = new URL('../extension/settings.js', import.meta.url);
let instance = 0;

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

test('fresh settings use local retrieval and do not create retired Story controls', async () => {
    const { getSettings } = await loadSettings();
    const settings = getSettings();
    assert.equal(settings.retrievalMode, 'local');
    assert.equal(settings.retrievalDefaultVersion, 2);
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
        assert.equal(settings.retrievalMode, mode === 'embedding-hybrid' ? mode : 'local');
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
    for (const id of ['story_so_far_tokens', 'retrieval_profile', 'retrieval_thinking', 'retrieval_prompt', 'retrieval_template', 'embedding_messages', 'embedding_top_k', 'embedding_threshold']) {
        assert.doesNotMatch(html, new RegExp(`id="continuity_${id}"`));
        assert.doesNotMatch(ui, new RegExp(`#continuity_${id}['"]`));
    }
    assert.doesNotMatch(html, /value="ai-expanded"/);
    assert.match(html, /Local matching \(default/);
    assert.match(html, /does not improve reply retrieval in this version/);
    assert.match(html, /complete active Chronicle frontier is included without token clipping/);
    assert.match(html, /Soft packing target/);
    assert.match(html, /id="continuity_retrieval_messages"/);
    assert.doesNotMatch(index, /expandRetrievalTerms|embeddingQueryMessages|resolveStoryBudget/);
    assert.doesNotMatch(ui, /embeddingQueryMessages|resolveStoryBudget/);
    assert.match(index, /mode: 'local', phase, executed: true/);
    assert.match(ui.slice(ui.indexOf('export function previewInjection')), /settings\.retrievalQueryMessages/);
});
