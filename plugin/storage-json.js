import crypto from 'node:crypto';
import fs from 'node:fs/promises';
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
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temporary, await encodeStorageJson(value, options), { flag: 'wx' });
        await options.beforeCommit?.();
        await fs.rename(temporary, file);
    } finally {
        try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
