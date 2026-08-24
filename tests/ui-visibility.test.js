import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('runtime settings remain live regardless of drawer visibility', async () => {
    const source = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /continuityPanelIsOpen/u);
    assert.doesNotMatch(source, /defer all coverage scans and DOM work/u);
    assert.match(source, /createRenderScheduler\(\(\) => renderRuntime\(false\)[\s\S]*minInterval: 250/u);
    assert.match(source, /continuity_memory_viewer_details'\)\.prop\('open'\)/u);
});

test('browser resume repaints settings and restores persisted world and vector coverage', async () => {
    const source = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(source, /function recoverLiveUiAfterResume/u);
    assert.match(source, /repaintLiveSettings\(\)/u);
    assert.match(source, /const world = await refreshWorlds\(\)/u);
    assert.match(source, /await inspectEmbeddingIndex\(world\)/u);
    assert.match(source, /document\.addEventListener\('visibilitychange'/u);
    assert.match(source, /window\.addEventListener\('pageshow'/u);
    assert.match(source, /window\.addEventListener\('focus'/u);
});

test('generation waits for an existing bound world instead of treating its chat as unprocessed', async () => {
    const source = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(source, /async function loadBoundWorldOnce/u);
    assert.match(source, /loadingBoundWorld\?\.id === expectedWorldId/u);
    assert.match(source, /await loadBoundWorldOnce\(boundWorldId\)/u);
    assert.doesNotMatch(source, /getBoundWorldId\(\) && !recoverStaleBinding\) return runtime\.world/u);
});

test('loading a bound world does not run blocking whole-world maintenance', async () => {
    const source = await readFile(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const start = source.indexOf('export async function loadBoundWorld()');
    const end = source.indexOf('export function continueQueue()', start);
    const loader = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(loader, /compactDuplicateMemoryRecords/u);
    assert.doesNotMatch(loader, /removeInvalidStoredAddressFacts/u);
    assert.match(loader, /promoteStoredTailSnapshot/u);
});

test('manual Build restarts failures, completes embeddings, and obeys Stop processing', async () => {
    const source = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(source, /async function buildMemoryWithRestart/u);
    assert.match(source, /Build activity failed \(\$\{error\.message\}\)\. Restarting/u);
    assert.match(source, /vectors = await resumeEmbeddingIndexing\(runtime\.world\)/u);
    assert.match(source, /buildMemoryWithRestart\(\)/u);
    assert.match(source, /stopEmbeddingIndexing\(\);\s*stopRuntime\(\)/u);
    assert.match(source, /state\.stopSequence === stopSequence && !state\.paused/u);
});

test('embedding settings appear directly after retrieval mode and before Story so far', async () => {
    const source = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const retrievalMode = source.indexOf('id="continuity_retrieval_mode"');
    const embeddingCard = source.indexOf('class="continuity-embedding-setting continuity-card-inset"');
    const storyToggle = source.indexOf('id="continuity_story_so_far"');

    assert.ok(retrievalMode >= 0);
    assert.ok(embeddingCard > retrievalMode);
    assert.ok(storyToggle > embeddingCard);
    assert.equal((source.match(/class="continuity-embedding-setting continuity-card-inset"/g) || []).length, 1);
});
