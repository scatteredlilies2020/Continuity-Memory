import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.dirname(path.dirname(scriptPath));
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.txt']);

async function json(filename) {
    return JSON.parse(await readFile(filename, 'utf8'));
}

async function filesUnder(root, directory = root) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await filesUnder(root, absolute));
        else if (entry.isFile()) files.push(path.relative(root, absolute));
    }
    return files.sort();
}

async function digest(filename) {
    const bytes = await readFile(filename);
    const content = TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase())
        ? bytes.toString('utf8').replace(/\r\n?/gu, '\n')
        : bytes;
    return createHash('sha256').update(content).digest('hex');
}

export async function liveLayout(targetRoot, sourceRoot = repositoryRoot) {
    const manifest = await json(path.join(sourceRoot, 'manifest.json'));
    if (!manifest.js) throw new Error('Root manifest has no js entrypoint.');
    const entryFile = manifest.js.split('?')[0];
    const sourceEntry = path.resolve(sourceRoot, entryFile);
    const targetEntry = path.resolve(targetRoot, entryFile);
    const sourceCodeRoot = path.dirname(sourceEntry);
    const targetCodeRoot = path.dirname(targetEntry);
    if (!sourceEntry.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) throw new Error('Manifest js escapes the repository.');
    if (!targetEntry.startsWith(`${path.resolve(targetRoot)}${path.sep}`)) throw new Error('Manifest js escapes the live extension directory.');
    return { manifest, sourceEntry, targetEntry, sourceCodeRoot, targetCodeRoot };
}

export async function verifyLiveDeployment(targetRoot, sourceRoot = repositoryRoot) {
    const layout = await liveLayout(targetRoot, sourceRoot);
    const liveManifest = await json(path.join(targetRoot, 'manifest.json'));
    if (liveManifest.js !== layout.manifest.js) throw new Error(`Live manifest loads ${liveManifest.js}; source manifest loads ${layout.manifest.js}.`);
    if (liveManifest.version !== layout.manifest.version) throw new Error(`Live version ${liveManifest.version} does not match tested version ${layout.manifest.version}.`);
    const mismatches = [];
    const files = await filesUnder(layout.sourceCodeRoot);
    const liveFiles = await filesUnder(layout.targetCodeRoot);
    const sourceFiles = new Set(files);
    for (const relative of liveFiles) {
        if (!sourceFiles.has(relative)) mismatches.push(`${relative} (stale)`);
    }
    for (const relative of files) {
        const source = path.join(layout.sourceCodeRoot, relative);
        const target = path.join(layout.targetCodeRoot, relative);
        try {
            if (await digest(source) !== await digest(target)) mismatches.push(relative);
        } catch {
            mismatches.push(relative);
        }
    }
    if (mismatches.length) throw new Error(`Manifest-loaded directory differs from tested source: ${mismatches.join(', ')}`);
    const coverage = await readFile(path.join(layout.targetCodeRoot, 'coverage.js'), 'utf8');
    const extractionVersion = Number(/EXTRACTION_VERSION\s*=\s*(\d+)/u.exec(coverage)?.[1]);
    if (!Number.isFinite(extractionVersion)) throw new Error('Cannot verify the live extraction schema version.');
    return { ...layout, files: files.length, extractionVersion };
}

export async function deployLive(targetRoot, sourceRoot = repositoryRoot) {
    const layout = await liveLayout(targetRoot, sourceRoot);
    // liveLayout proves this directory is the manifest entrypoint's directory
    // and that it remains inside targetRoot. Replace it completely so renamed
    // or deleted modules cannot survive an update and remain browser-loadable.
    await rm(layout.targetCodeRoot, { recursive: true, force: true });
    await mkdir(layout.targetCodeRoot, { recursive: true });
    await cp(layout.sourceCodeRoot, layout.targetCodeRoot, { recursive: true, force: true });
    await cp(path.join(sourceRoot, 'manifest.json'), path.join(targetRoot, 'manifest.json'), { force: true });
    const verified = await verifyLiveDeployment(targetRoot, sourceRoot);
    const receipt = {
        version: verified.manifest.version,
        manifestEntrypoint: verified.manifest.js,
        extractionVersion: verified.extractionVersion,
        verifiedFiles: verified.files,
        verifiedAt: new Date().toISOString(),
    };
    await writeFile(path.join(targetRoot, 'continuity-deployment.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const verifyOnly = process.argv.includes('--verify-only');
    const targetRoot = process.argv.slice(2).find(value => value !== '--verify-only');
    if (!targetRoot) throw new Error('Usage: node scripts/deploy-live.mjs [--verify-only] <SillyTavern Continuity_Memory directory>');
    const result = verifyOnly
        ? await verifyLiveDeployment(path.resolve(targetRoot))
        : await deployLive(path.resolve(targetRoot));
    console.log(JSON.stringify({
        ok: true,
        mode: verifyOnly ? 'verify' : 'deploy',
        version: result.version || result.manifest.version,
        manifestEntrypoint: result.manifestEntrypoint || result.manifest.js,
        extractionVersion: result.extractionVersion,
        verifiedFiles: result.verifiedFiles || result.files,
    }));
}
