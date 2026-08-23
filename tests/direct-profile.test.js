import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DIRECT_PROFILE_ID, directProfileChoice, parseProfileChoice } from '../extension/direct-profile.js';

test('direct provider choices round-trip without leaking synthetic IDs into requests', () => {
    assert.deepEqual(parseProfileChoice('__direct_custom__'), { profileId: DIRECT_PROFILE_ID, provider: 'custom' });
    assert.deepEqual(parseProfileChoice('__direct_openrouter__'), { profileId: DIRECT_PROFILE_ID, provider: 'openrouter' });
    assert.equal(directProfileChoice(DIRECT_PROFILE_ID, 'custom'), '__direct_custom__');
    assert.equal(directProfileChoice(DIRECT_PROFILE_ID, 'openrouter'), '__direct_openrouter__');
});

test('ordinary connection profiles remain unchanged', () => {
    assert.deepEqual(parseProfileChoice('profile-7'), { profileId: 'profile-7', provider: null });
    assert.equal(directProfileChoice('profile-7', 'openrouter'), 'profile-7');
});

test('model-driven Continuity categories expose independent direct controls', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    for (const kind of ['extraction', 'retrieval', 'correction', 'summary']) {
        for (const suffix of ['provider', 'url', 'key', 'save_key', 'fetch_models', 'key_status', 'model_select', 'models_status', 'model']) {
            assert.match(html, new RegExp(`id="continuity_${kind}_direct_${suffix}"`));
        }
    }
    assert.equal((html.match(/value="__direct_custom__"/g) || []).length, 4);
    assert.equal((html.match(/value="__direct_openrouter__"/g) || []).length, 4);
    assert.doesNotMatch(html, /continuity_story_profile/);
    assert.doesNotMatch(html, /continuity_story_direct_/);
});

test('AI retrieval has an independent reasoning control that defaults to Auto', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const settings = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
    const retrieval = readFileSync(new URL('../extension/semantic-retrieval.js', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');

    assert.match(html, /id="continuity_retrieval_thinking"/);
    assert.match(settings, /retrievalThinkingMode:\s*'auto'/);
    assert.equal((retrieval.match(/settings\.retrievalThinkingMode/g) || []).length, 2);
    assert.doesNotMatch(retrieval, /resolveThinkingModeForProfile\(settings\.thinkingMode/);
    assert.match(ui, /setSetting\('#continuity_retrieval_thinking', 'retrievalThinkingMode'\)/);
});
