import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Recursive Chronicle replaces manual rolling-Story actions', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    assert.match(html, /Recursive Chronicle/);
    assert.match(html, /id="continuity_chronicle_capacity"/);
    assert.match(html, /id="continuity_chronicle_fan_in"/);
    assert.doesNotMatch(html, /id="continuity_story_build"/);
    assert.doesNotMatch(html, /id="continuity_story_rebuild"/);
    assert.doesNotMatch(html, /id="continuity_story_delete"/);
    assert.doesNotMatch(ui, /#continuity_story_build/);
    assert.doesNotMatch(ui, /#continuity_story_rebuild/);
    assert.doesNotMatch(ui, /#continuity_story_delete/);
    assert.doesNotMatch(html, /continuity_story_refine/);
    assert.doesNotMatch(html, /continuity_story_stop/);
    assert.doesNotMatch(ui, /#continuity_story_refine/);
    assert.doesNotMatch(ui, /#continuity_story_stop/);
    assert.match(engine, /export async function buildNextChronicle\(/);
});

test('Chronicle rebuild commits only after every replacement parent is ready', () => {
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const rebuild = engine.slice(
        engine.indexOf('export async function restartHierarchyFromDigest()'),
        engine.indexOf('async function saveExtraction(', engine.indexOf('export async function restartHierarchyFromDigest()')),
    );
    const rebuildUi = ui.slice(
        ui.indexOf('async function rebuildHierarchy()'),
        ui.indexOf('async function reviewCorrection()', ui.indexOf('async function rebuildHierarchy()')),
    );

    assert.ok(rebuild.indexOf('resetWorldHierarchy(world)') < rebuild.indexOf('generateChroniclePromotion(nodes)'));
    assert.ok(rebuild.indexOf('generateChroniclePromotion(nodes)') < rebuild.indexOf('api.saveWorld(world)'));
    assert.equal(rebuild.match(/api\.saveWorld\(world\)/g)?.length, 1);
    assert.match(rebuild, /previously saved hierarchy was kept/);
    assert.doesNotMatch(rebuildUi, /purgeEmbeddingIndex|clearRetrievalExpansionCache/);
});
