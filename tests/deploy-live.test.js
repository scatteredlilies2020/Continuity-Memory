import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deployLive, verifyLiveDeployment } from '../scripts/deploy-live.mjs';

test('live deployment follows the manifest entrypoint and rejects a stale loaded copy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'continuity-deploy-'));
    const source = path.join(root, 'source');
    const target = path.join(root, 'live');
    try {
        await mkdir(path.join(source, 'extension'), { recursive: true });
        await mkdir(path.join(target, 'extension'), { recursive: true });
        await writeFile(path.join(source, 'manifest.json'), JSON.stringify({ js: 'extension/index.js', css: 'extension/style.css', version: 'test.9' }));
        await writeFile(path.join(source, 'extension', 'index.js'), 'export const loaded = 9;\n');
        await writeFile(path.join(source, 'extension', 'coverage.js'), 'export const EXTRACTION_VERSION = 41;\n');
        await writeFile(path.join(source, 'extension', 'style.css'), '/* tested */\n');
        await writeFile(path.join(target, 'manifest.json'), JSON.stringify({ js: 'extension/index.js', css: 'extension/style.css', version: 'test.9' }));
        await writeFile(path.join(target, 'extension', 'index.js'), 'export const loaded = 3;\n');
        await writeFile(path.join(target, 'index.js'), 'export const misleadingSibling = 9;\n');

        await assert.rejects(verifyLiveDeployment(target, source), /differs from tested source/u);
        const receipt = await deployLive(target, source);
        assert.equal(receipt.manifestEntrypoint, 'extension/index.js');
        assert.equal(receipt.extractionVersion, 41);
        assert.match(await readFile(path.join(target, 'extension', 'index.js'), 'utf8'), /loaded = 9/u);
        assert.match(await readFile(path.join(target, 'index.js'), 'utf8'), /misleadingSibling/u);
        await verifyLiveDeployment(target, source);

        await writeFile(path.join(target, 'extension', 'index.js'), 'export const loaded = 9;\r\n');
        await verifyLiveDeployment(target, source);

        await writeFile(path.join(target, 'extension', 'index.js'), 'export const loaded = 3;\n');
        await assert.rejects(verifyLiveDeployment(target, source), /index\.js/u);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
