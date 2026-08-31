import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('manual Digest-sourced Story builds complete eligible Digest before selecting Story source units', () => {
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const completion = engine.indexOf('Preparing Digest-sourced Story: completing');
    const sourceSelection = engine.indexOf('const requiredDigestThrough = sourceMode === STORY_SOURCE_DIGEST', completion);
    assert.ok(completion >= 0, 'manual Story build should explicitly complete missing Digest');
    assert.ok(sourceSelection > completion, 'Digest completion must happen before Story source selection');
    assert.match(engine.slice(completion, sourceSelection), /await maybeAutoExtract\(true, allMessages\)/);
});

test('combined memory build receives Story from Digest without launching a separate Story request', () => {
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const buildStart = ui.indexOf('async function buildMemory(');
    const buildEnd = ui.indexOf('async function repairRollback()', buildStart);
    const build = ui.slice(buildStart, buildEnd);
    assert.match(build, /await continueFailedDigest\(\)/);
    assert.doesNotMatch(build, /buildRollingStory|rebuildRollingStory|startStoryAlongsideMemory/);
});
