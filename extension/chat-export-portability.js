import { createPortableSnapshot } from './portable-state.js';

function parseLines(raw) {
    const text = String(raw ?? '');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const trailingNewline = text.endsWith('\n');
    const lines = text.split(/\r?\n/u);
    if (trailingNewline) lines.pop();
    if (!lines.length || !lines[0].trim()) throw new Error('The exported chat has no metadata header.');
    return { lines, newline, trailingNewline };
}

function parseObject(line, label) {
    let value;
    try {
        value = JSON.parse(line);
    } catch (error) {
        throw new Error(`The exported chat contains invalid ${label} JSON: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`The exported chat contains an invalid ${label}.`);
    }
    return value;
}

export function parseChatExport(raw) {
    const parsed = parseLines(raw);
    const header = parseObject(parsed.lines[0], 'metadata header');
    if (!Object.hasOwn(header, 'chat_metadata')) throw new Error('The exported file is not a SillyTavern JSONL chat.');
    const messages = parsed.lines.slice(1)
        .filter(line => line.trim())
        .map((line, index) => parseObject(line, `message ${index + 1}`));
    return { ...parsed, header, messages };
}

export function getPortableSnapshotFromChatExport(raw) {
    return parseChatExport(raw).header.chat_metadata?.continuityMemory || null;
}

export function embedPortableMemoryInChatExport(raw, world, embeddedAt = new Date().toISOString()) {
    if (!world?.id) throw new Error('Continuity memory is unavailable for this export.');
    const parsed = parseChatExport(raw);
    parsed.header.chat_metadata = parsed.header.chat_metadata && typeof parsed.header.chat_metadata === 'object'
        ? parsed.header.chat_metadata
        : {};
    parsed.header.chat_metadata.continuityMemory = createPortableSnapshot(world, embeddedAt);
    parsed.lines[0] = JSON.stringify(parsed.header);
    return `${parsed.lines.join(parsed.newline)}${parsed.trailingNewline ? parsed.newline : ''}`;
}

export function removePortableMemoryFromChatExport(raw) {
    const parsed = parseChatExport(raw);
    const metadata = parsed.header.chat_metadata;
    if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, 'continuityMemory')) return String(raw);
    delete metadata.continuityMemory;
    parsed.lines[0] = JSON.stringify(parsed.header);
    return `${parsed.lines.join(parsed.newline)}${parsed.trailingNewline ? parsed.newline : ''}`;
}
