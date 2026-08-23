import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Story So Far exposes only simple manual recovery actions', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    assert.match(html, /id="continuity_story_build"/);
    assert.match(html, /id="continuity_story_rebuild"/);
    assert.match(html, /id="continuity_story_delete"/);
    assert.match(ui, /#continuity_story_build/);
    assert.match(ui, /#continuity_story_rebuild/);
    assert.match(ui, /#continuity_story_delete/);
    assert.doesNotMatch(html, /continuity_story_refine/);
    assert.doesNotMatch(html, /continuity_story_stop/);
    assert.doesNotMatch(ui, /#continuity_story_refine/);
    assert.doesNotMatch(ui, /#continuity_story_stop/);
    assert.match(engine, /export async function refineRollingStory\(\)/);
    assert.doesNotMatch(engine, /regenerateRollingStory\([^;]+qualityRepair/s);
});
