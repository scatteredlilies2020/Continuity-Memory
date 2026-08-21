import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Story refinement is an explicit UI action and never part of normal generation calls', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    assert.match(html, /id="continuity_story_refine"/);
    assert.match(ui, /#continuity_story_refine/);
    assert.match(engine, /export async function refineRollingStory\(\)/);
    assert.doesNotMatch(engine, /regenerateRollingStory\([^;]+qualityRepair/s);
});
