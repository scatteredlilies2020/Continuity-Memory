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

test('every model-driven Continuity category exposes independent direct controls', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    for (const kind of ['extraction', 'retrieval', 'story', 'correction', 'summary']) {
        for (const suffix of ['provider', 'url', 'key', 'save_key', 'fetch_models', 'key_status', 'model_select', 'models_status', 'model']) {
            assert.match(html, new RegExp(`id="continuity_${kind}_direct_${suffix}"`));
        }
    }
    assert.equal((html.match(/value="__direct_custom__"/g) || []).length, 5);
    assert.equal((html.match(/value="__direct_openrouter__"/g) || []).length, 5);
});

test('AI retrieval automatically inherits reasoning without another user setting', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const retrieval = readFileSync(new URL('../extension/semantic-retrieval.js', import.meta.url), 'utf8');

    assert.doesNotMatch(html, /id="continuity_retrieval_thinking"/);
    assert.equal((retrieval.match(/resolveThinkingModeForProfile\('auto', profileId\)/g) || []).length, 2);
    assert.doesNotMatch(retrieval, /resolveThinkingModeForProfile\(settings\.thinkingMode/);
});
