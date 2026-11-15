import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicStorageJson, decodeStorageJson, encodeStorageJson, readStorageJson } from '../plugin/storage-json.js';

test('storage packing is lossless for Unicode, precise vectors and nested replay data', async () => {
    const original = { text: '角色記憶 🌸\n'.repeat(500), vector: [0.12345678901234568, -1.2345678901234567e-20],
        records: [{ id: 'original', unknownFutureField: { keep: true, nullable: null } }] };
    const packed = await encodeStorageJson(original, { pack: true });
    assert.equal(JSON.parse(packed).continuityStorage, 'continuity-gzip-json-v1');
    assert.ok(Buffer.byteLength(packed) < Buffer.byteLength(JSON.stringify(original)) / 4);
    assert.deepEqual(await decodeStorageJson(packed), original);
    assert.deepEqual(await decodeStorageJson(JSON.stringify(original, null, 2)), original);
});

test('small records and manifests stay minified readable JSON without envelope overhead', async () => {
    const original = { nested: { kept: 1 }, text: 'small' };
    assert.equal(await encodeStorageJson(original, { pack: true }), `${JSON.stringify(original)}\n`);
    const large = { text: 'unchanged manifest metadata '.repeat(500) };
    assert.equal(await encodeStorageJson(large), `${JSON.stringify(large)}\n`);
});

test('broken, truncated and unknown compressed payloads fail closed', async () => {
    const packed = JSON.parse(await encodeStorageJson({ text: 'history '.repeat(1000) }, { pack: true }));
    for (const value of [{ ...packed, data: packed.data.slice(0, -8) }, { ...packed, data: 'not base64!' },
        { ...packed, data: null }, { ...packed, continuityStorage: 'future-version' }]) {
        await assert.rejects(decodeStorageJson(JSON.stringify(value)));
    }
    await assert.rejects(decodeStorageJson('{broken'));
    await assert.rejects(decodeStorageJson(JSON.stringify({ ...packed, continuityStorage: 'future-version' })),
        error => error.status === 422 && error.code === 'CONTINUITY_UPDATE_REQUIRED');
});

test('atomic storage replaces the same path, leaves no temporary files and reads either encoding', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-json-codec-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'store.json');
    const original = { text: 'exact memory '.repeat(500) };
    await fs.writeFile(file, JSON.stringify(original, null, 2));
    await atomicStorageJson(file, original, { pack: true });
    assert.deepEqual(await readStorageJson(file), original);
    await atomicStorageJson(file, { text: 'newest' }, { pack: true });
    assert.deepEqual(await readStorageJson(file), { text: 'newest' });
    assert.deepEqual(await fs.readdir(directory), ['store.json']);
    await assert.rejects(atomicStorageJson(file, original, {
        pack: true,
        beforeCommit: () => { throw new Error('concurrent update detected'); },
    }), /concurrent update/);
    assert.deepEqual(await readStorageJson(file), { text: 'newest' });
    assert.deepEqual(await fs.readdir(directory), ['store.json']);
    // A failed rename must preserve its target and clean its own staging file.
    const blocked = path.join(directory, 'blocked.json');
    await fs.mkdir(blocked);
    await assert.rejects(atomicStorageJson(blocked, original, { pack: true }));
    assert.equal((await fs.stat(blocked)).isDirectory(), true);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['blocked.json', 'store.json']);
});
