import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Rebuild Chronicles is beside Build and Stop, outside destructive reset controls', async () => {
    const source = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const processing = source.slice(source.indexOf('<h4>Processing</h4>'));
    const primaryRow = processing.match(/<div class="continuity-button-row continuity-processing-actions"[^>]*>([\s\S]*?)<\/div>/u)?.[1];
    assert.ok(primaryRow);
    for (const id of ['continuity_build', 'continuity_rebuild_hierarchy', 'continuity_stop']) {
        assert.ok(primaryRow.includes(`id="${id}"`), `${id} must be in the main processing row`);
    }
    assert.match(primaryRow, /> Rebuild Chronicles<\/button>/u);
    assert.equal((source.match(/id="continuity_rebuild_hierarchy"/gu) || []).length, 1);
    const resetControls = processing.slice(processing.indexOf('<details>'), processing.indexOf('</details>'));
    assert.ok(resetControls.includes('id="continuity_restart_build"'));
    assert.ok(!resetControls.includes('id="continuity_rebuild_hierarchy"'));
    assert.match(processing, /replacing the saved hierarchy only when the entire rebuild succeeds/u);
});

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

test('context reduction status omits cumulative excluded-history counters only', async () => {
    const source = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(source, /<strong>Last request:<\/strong> kept \$\{tailTurns\} recent turn\(s\)/u);
    assert.match(source, /<strong>Other prompts:<\/strong> ~\$\{fixedPromptTokens\} tokens/u);
    assert.match(source, /<strong>Total sent:<\/strong>/u);
    assert.match(source, /<strong>Safety reserve:<\/strong> \$\{safetyTokens\} tokens/u);
    assert.doesNotMatch(source, /excluded \$\{reduction\.hiddenMessages\} old message/u);
    assert.doesNotMatch(source, /~\$\{reduction\.hiddenTokens\} tokens/u);
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

test('manual memory Build restarts failures, completes vectors, and obeys Stop processing', async () => {
    const source = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(source, /async function runMemoryBuildWithRestart/u);
    assert.match(source, /function buildMemoryWithRestart/u);
    assert.match(source, /Build activity failed \(\$\{error\.message\}\)\. Restarting/u);
    assert.match(source, /vectors = await resumeEmbeddingIndexing\(runtime\.world\)/u);
    assert.match(source, /Completing the selected embedding index to 100%/u);
    assert.match(source, /buildMemoryWithRestart\(\)/u);
    assert.match(source, /stopEmbeddingIndexing\(\);\s*stopRuntime\(\)/u);
    assert.match(source, /state\.stopSequence !== stopSequence/u);
    assert.match(source, /if \(runtime\.paused\) resumeRuntime\(\)/u);
    assert.match(source, /if \(activeMemoryBuild\) return activeMemoryBuild/u);
    assert.match(source, /if \(!buildFailureCanRetry\(error\)\)/u);
});

test('manual Build adopts queued automatic Digest and drains remaining complete groups', async () => {
    const engine = await readFile(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const ui = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(engine, /const queuedAutomaticJob = runtime\.queue\.find/u);
    assert.match(engine, /return force \? queuedAutomaticJob\.promise : null/u);
    assert.match(engine, /promise,\s*\}\);\s*updateRuntime/u);
    assert.match(ui, /while \(true\)[\s\S]*const result = await maybeAutoExtract\(true\)/u);
    assert.match(ui, /await waitForExistingMemoryWork\(stopSequence\)/u);
    assert.doesNotMatch(ui, /No pending Digest messages could be started/u);
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

test('storage upkeep exposes the real server policy without loading it until opened', async () => {
    const html = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const ui = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const api = await readFile(new URL('../extension/api.js', import.meta.url), 'utf8');
    assert.match(html, /id="continuity_storage_upkeep"/u);
    assert.match(html, /id="continuity_shard_retention"[^>]*min="0"[^>]*value="1"/u);
    assert.match(html, /id="continuity_save_storage_policy"[^>]*disabled/u);
    assert.match(ui, /addEventListener\('toggle', async event =>/u);
    assert.match(ui, /await api\.getStoragePolicy\(\)/u);
    assert.match(ui, /await api\.saveStoragePolicy\(/u);
    assert.match(api, /getStoragePolicy:.*storage-policy/u);
    assert.match(html, /1,024 obsolete files/u);
});
