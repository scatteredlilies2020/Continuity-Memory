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
