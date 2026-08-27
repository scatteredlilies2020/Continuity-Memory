export function normalizeNativeChatExportFilename(value) {
    const filename = String(value || '').trim();
    if (!filename) return '';
    return /\.jsonl$/iu.test(filename) ? filename : `${filename}.jsonl`;
}

export function buildNativeChatExportRequest({ isGroup = false, avatarUrl = '', filename = '' } = {}) {
    const sourceFile = normalizeNativeChatExportFilename(filename);
    return {
        is_group: Boolean(isGroup),
        avatar_url: String(avatarUrl || ''),
        file: sourceFile,
        exportfilename: sourceFile,
        format: 'jsonl',
    };
}

export async function readNativeChatExportResponse(response) {
    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        if (!response.ok) throw new Error(text.trim() || `Chat export failed (${response.status}).`);
        throw new Error('Chat export returned an invalid response.');
    }
    if (!response.ok) throw new Error(payload?.message || text.trim() || `Chat export failed (${response.status}).`);
    if (!payload || typeof payload.result !== 'string') throw new Error('Chat export response did not contain the exported chat.');
    return payload;
}
