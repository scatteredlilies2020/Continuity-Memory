import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('manual L1-sourced Story builds complete eligible L1 before selecting Story source units', () => {
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const completion = engine.indexOf('Preparing L1-sourced Story: completing');
    const sourceSelection = engine.indexOf('const requiredL1Through = sourceMode === STORY_SOURCE_L1', completion);
    assert.ok(completion >= 0, 'manual Story build should explicitly complete missing L1');
    assert.ok(sourceSelection > completion, 'L1 completion must happen before Story source selection');
    assert.match(engine.slice(completion, sourceSelection), /await maybeAutoExtract\(true, allMessages\)/);
});

test('combined memory build delays an L1-sourced Story until L1 processing finishes', () => {
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(ui, /let storyWork = storyUsesL1 \? null : startStoryAlongsideMemory\(false\);[\s\S]*await continueFailedL1\(\);[\s\S]*if \(storyUsesL1\) storyWork = startStoryAlongsideMemory\(false\);/);
});
