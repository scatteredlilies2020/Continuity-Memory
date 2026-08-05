const METADATA_KEY = 'continuityMemory';

function stripRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return 0;
    const metadata = record.chat_metadata;
    if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, METADATA_KEY)) return 0;
    delete metadata[METADATA_KEY];
    return 1;
}

function sanitizeJson(text) {
    const value = JSON.parse(text);
    let removed = stripRecord(value);
    if (Array.isArray(value)) {
        for (const record of value) removed += stripRecord(record);
    }
    return { text: `${JSON.stringify(value, null, 2)}\n`, removed, format: 'json' };
}

function sanitizeJsonl(text) {
    const trailingNewline = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/);
    let removed = 0;
    const output = lines.map((line, index) => {
        if (!line.trim()) return line;
        let record;
        try {
            record = JSON.parse(line);
        } catch (error) {
            throw new Error(`Invalid JSON on chat-export line ${index + 1}: ${error.message}`);
        }
        removed += stripRecord(record);
        return JSON.stringify(record);
    });
    while (output.length > 1 && output.at(-1) === '') output.pop();
    return { text: `${output.join('\n')}${trailingNewline ? '\n' : ''}`, removed, format: 'jsonl' };
}

export function sanitizeChatExport(text, filename = '') {
    if (typeof text !== 'string' || !text.trim()) throw new Error('The selected chat export is empty.');
    const jsonl = String(filename).toLowerCase().endsWith('.jsonl');
    const result = jsonl ? sanitizeJsonl(text) : sanitizeJson(text);
    if (!result.removed) throw new Error('No embedded Continuity memory was found in this chat export.');
    return result;
}
