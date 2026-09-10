import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('retired standalone Story generation is replaced by non-mutating compatibility errors', async () => {
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    assert.doesNotMatch(engine, /function (?:regenerateRollingStory|verifyRollingStoryQuality|repairRollingStoryQuality|runManualRollingStory|persistRollingStory)\(/);
    const exports = engine.match(/export \{[^}]+\} from '\.\/legacy-support\.js';/u)?.[0];
    assert.ok(exports, 'stale named imports must still resolve to an actionable error');
    const source = exports.replace('./legacy-support.js', new URL('../extension/legacy-support.js', import.meta.url).href);
    const actions = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    const expected = ['buildRollingStory', 'deleteRollingStory', 'maybeAutoUpdateRollingStory', 'rebuildRollingStory', 'refineRollingStory'];
    assert.deepEqual(Object.keys(actions).sort(), expected.sort());
    const world = { facts: [{ id: 'kept', value: 'saved fact' }], storySoFar: { chat: { text: 'saved snapshot' } } };
    const before = structuredClone(world);
    for (const action of Object.values(actions)) {
        await assert.rejects(() => action(world), error => {
            assert.equal(error.code, 'CONTINUITY_LEGACY_STORY_UNSUPPORTED');
            assert.match(error.message, /Update Continuity Memory and reload SillyTavern/);
            assert.match(error.message, /Rebuild every Chronicle layer/);
            assert.match(error.message, /export memory first/i);
            return true;
        });
    }
    assert.deepEqual(world, before);
    assert.match(engine, /planStoryMutationRecovery\(/, 'source-edit recovery still serves saved snapshots');
    assert.match(engine, /compileRollingStorySnapshot\(/, 'old Digest replay can still supply Chronicle entries');
});

test('combined memory build receives Story from Digest without launching a separate Story request', () => {
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const buildStart = ui.indexOf('async function buildMemory(');
    const buildEnd = ui.indexOf('async function repairRollback()', buildStart);
    const build = ui.slice(buildStart, buildEnd);
    assert.match(build, /await continueFailedDigest\(\)/);
    assert.doesNotMatch(build, /buildRollingStory|rebuildRollingStory|startStoryAlongsideMemory/);
});
