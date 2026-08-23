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
