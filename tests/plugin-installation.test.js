import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

// Exercise the package entrypoint like SillyTavern, in a fresh process outside
// the source checkout. Direct imports in plugin.test.js cannot catch bad installs.
const loadInstalledPlugin = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [installed, frontend] = process.argv.slice(1);
const pkg = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
assert.equal(pkg.main, 'plugin/index.js');
const plugin = await import(pathToFileURL(path.join(installed, pkg.main)).href);
assert.equal(plugin.info.id, 'continuity-memory');
const routes = new Set();
const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method =>
    [method, route => routes.add(method + ' ' + route)]));
await plugin.init(router, { syncExtension: false });
assert.ok(routes.has('get /worlds'));
assert.ok(routes.has('post /worlds'));
// Also check the bundled-extension source derived from import.meta.url.
assert.equal((await plugin.syncBundledExtension({ target: frontend })).status, 'installed');
for (const filename of ['manifest.json', 'index.js', 'storage-compaction.js']) {
    assert.deepEqual(await fs.readFile(path.join(frontend, filename)),
        await fs.readFile(path.join(installed, 'extension', filename)));
}
console.log('Installed plugin verified');
`;

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-plugin-install-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

async function copyPackage(target) {
    await fs.mkdir(target, { recursive: true });
    for (const name of ['package.json', 'plugin', 'extension']) {
        await fs.cp(path.join(repository, name), path.join(target, name), { recursive: true });
    }
}

async function verifyInstall(root, installed, flags = []) {
    const { stdout } = await exec(process.execPath, [
        ...flags, '--input-type=module', '-e', loadInstalledPlugin,
        installed, path.join(root, 'frontend'),
    ], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' } });
    assert.match(stdout, /Installed plugin verified/);
}

test('copied server package loads outside the checkout without a plugins/extension sibling', async t => {
    const root = await fixture(t);
    // The folder name is not part of the plugin's import contract.
    const installed = path.join(root, 'plugins', 'custom-memory-name');
    await copyPackage(installed);
    await verifyInstall(root, installed);
});

for (const preserveSymlinks of [false, true]) {
    test(`repository-root plugin link loads with preserve-symlinks=${preserveSymlinks}`, async t => {
        const root = await fixture(t);
        const checkout = path.join(root, 'checkout');
        const installed = path.join(root, 'plugins', 'continuity-memory');
        await copyPackage(checkout);
        await fs.mkdir(path.dirname(installed));
        // Junctions do not require elevated symlink privileges on Windows.
        await fs.symlink(checkout, installed, process.platform === 'win32' ? 'junction' : 'dir');
        await verifyInstall(root, installed, preserveSymlinks ? ['--preserve-symlinks'] : []);
    });
}

test('development installers link the repository root, not the plugin-only directory', async () => {
    const termux = await fs.readFile(path.join(repository, 'install-termux.sh'), 'utf8');
    assert.match(termux, /^ln -s "\$project_dir" "\$plugin_link"$/m);
    assert.doesNotMatch(termux, /^ln -s "\$project_dir\/plugin"/m);
    const windows = await fs.readFile(path.join(repository, 'install-windows.ps1'), 'utf8');
    assert.match(windows, /^New-Item -ItemType Junction -Path \$PluginPath -Target \$ProjectPath \| Out-Null\r?$/m);
    assert.doesNotMatch(windows, /-Path \$PluginPath -Target \(Join-Path \$ProjectPath 'plugin'\)/);
});
