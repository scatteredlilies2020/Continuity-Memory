import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule } from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionRoot = path.join(root, 'extension');

// SillyTavern's Git extension installer requires the manifest at repository root.
const installManifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const asset of ['js', 'css']) {
    if (!installManifest[asset]) throw new Error(`Root manifest is missing ${asset}`);
    const assetPath = path.resolve(root, installManifest[asset].split('?')[0]);
    if (!assetPath.startsWith(`${root}${path.sep}`)) throw new Error(`Root manifest ${asset} escapes the repository`);
    readFileSync(assetPath);
}

const extensionFiles = readdirSync(extensionRoot).filter(name => name.endsWith('.js'));
for (const blockedName of ['fingerprint.js']) {
    if (extensionFiles.includes(blockedName)) {
        throw new Error(`Browser extension asset ${blockedName} is blocked by common privacy filter lists`);
    }
}
for (const folder of ['extension', 'plugin']) {
    for (const file of readdirSync(path.join(root, folder)).filter(name => name.endsWith('.js'))) {
        execFileSync(process.execPath, ['--check', path.join(root, folder, file)], { stdio: 'inherit' });
    }
}

// Browser module imports are validated before any extension code executes. Link the
// complete local graph so a misspelled or moved named export fails before release.
const externalExports = new Map();
const importPattern = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
for (const file of extensionFiles) {
    const source = readFileSync(path.join(extensionRoot, file), 'utf8');
    for (const match of source.matchAll(importPattern)) {
        const [, clause, specifier] = match;
        const resolved = path.resolve(extensionRoot, path.dirname(file), specifier.split('?')[0]);
        if (resolved.startsWith(`${extensionRoot}${path.sep}`)) continue;
        const names = externalExports.get(resolved) || new Set();
        const named = clause.match(/\{([\s\S]*?)\}/)?.[1] || '';
        for (const entry of named.split(',')) {
            const imported = entry.trim().split(/\s+as\s+/i)[0]?.trim();
            if (imported) names.add(imported);
        }
        if (/^\s*[A-Za-z_$][\w$]*(?:\s*,|\s*$)/.test(clause)) names.add('default');
        externalExports.set(resolved, names);
    }
}

const modules = new Map();
const stubs = new Map();
function localModule(filename) {
    const clean = filename.split('?')[0];
    if (modules.has(clean)) return modules.get(clean);
    const module = new SourceTextModule(readFileSync(clean, 'utf8'), {
        identifier: clean,
        initializeImportMeta(meta) { meta.url = `file://${clean}`; },
    });
    modules.set(clean, module);
    return module;
}

function externalModule(filename) {
    if (stubs.has(filename)) return stubs.get(filename);
    const names = [...(externalExports.get(filename) || [])];
    const module = new SyntheticModule(names, function initialize() {
        for (const name of names) this.setExport(name, undefined);
    }, { identifier: `external:${filename}` });
    stubs.set(filename, module);
    return module;
}

const entry = localModule(path.join(extensionRoot, 'index.js'));
await entry.link((specifier, referencingModule) => {
    const resolved = path.resolve(path.dirname(referencingModule.identifier), specifier.split('?')[0]);
    return resolved.startsWith(`${extensionRoot}${path.sep}`) ? localModule(resolved) : externalModule(resolved);
});

console.log('Syntax and browser module graph checks passed.');
