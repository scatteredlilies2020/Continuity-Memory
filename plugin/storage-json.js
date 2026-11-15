import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const PACKING = 'continuity-gzip-json-v1';

// A JSON envelope keeps existing sync/versioning filenames and MIME types valid.
// Small records stay minified JSON when the envelope would make them larger.
export async function encodeStorageJson(value, { pack = false } = {}) {
    const plain = `${JSON.stringify(value)}\n`;
    if (!pack || Buffer.byteLength(plain) < 1024) return plain;
    const data = await compress(Buffer.from(plain));
    const packed = `${JSON.stringify({ continuityStorage: PACKING, data: data.toString('base64') })}\n`;
    return Buffer.byteLength(packed) + 64 < Buffer.byteLength(plain) ? packed : plain;
}

export async function decodeStorageJson(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'continuityStorage')) return value;
    if (value.continuityStorage !== PACKING) throw Object.assign(
        new Error('Unsupported Continuity Memory storage encoding; update the server plugin.'),
        { status: 422, code: 'CONTINUITY_UPDATE_REQUIRED' },
    );
    if (typeof value.data !== 'string') throw new Error('Invalid compressed memory payload');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.toString('base64') !== value.data) throw new Error('Invalid compressed memory payload');
    const plain = await decompress(bytes);
    return JSON.parse(plain.toString('utf8'));
}

export async function readStorageJson(file) {
    return decodeStorageJson(await fs.readFile(file, 'utf8'));
}

export async function atomicStorageJson(file, value, options = {}) {
    return atomicStorageText(file, await encodeStorageJson(value, options), options);
}

async function atomicStorageText(file, text, options = {}) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temporary, text, { flag: 'wx' });
        const fileStamp = storageFileStamp(await fs.lstat(temporary));
        await options.beforeCommit?.();
        await fs.rename(temporary, file);
        return { fileStamp };
    } finally {
        try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

export function storageFileStamp(stat) {
    // mtime alone is insufficient: sync tools can preserve it when replacing
    // an older copy. Include change time and file identity, as well as size.
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

// Bulk maintenance must not follow a linked file or directory into other data.
export async function assertPlainStoragePath(filename, { directory = false } = {}) {
    let current = path.resolve(filename);
    const leaf = current;
    while (true) {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || current === leaf && !(directory ? stat.isDirectory() : stat.isFile())) {
            throw new Error(`Storage conversion refused linked or unexpected path: ${current}`);
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}

// Caller holds the corresponding world/collection writer lock. Preserve the
// exact logical payload (including old shard versions and recovery-only fields).
export async function repackStorageJson(file, transform = value => value) {
    await assertPlainStoragePath(file);
    const fileStamp = storageFileStamp(await fs.lstat(file));
    const original = await fs.readFile(file, 'utf8');
    if (storageFileStamp(await fs.lstat(file)) !== fileStamp) {
        throw Object.assign(new Error('Storage changed while reading for conversion; retry.'), { status: 409 });
    }
    const value = await decodeStorageJson(original);
    const next = await transform(value);
    const text = await encodeStorageJson(next, { pack: true });
    const bytesSaved = Buffer.byteLength(original) - Buffer.byteLength(text);
    if (text === original || bytesSaved <= 0 && JSON.stringify(value) === JSON.stringify(next)) {
        return { converted: false, bytesSaved: 0, fileStamp };
    }
    const committed = await atomicStorageText(file, text, { beforeCommit: async () => {
        await assertPlainStoragePath(file);
        if (await fs.readFile(file, 'utf8') !== original) {
            throw Object.assign(new Error('Storage changed during conversion; newer data was kept. Retry conversion.'), { status: 409 });
        }
    } });
    return { converted: true, bytesSaved: Math.max(0, bytesSaved), fileStamp: committed.fileStamp };
}
