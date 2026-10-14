function invalidJson(reason) {
    // Never include model output (which may contain private chat) in diagnostics.
    const error = new Error(`Extractor returned text without a valid JSON object. ${reason}`);
    error.code = 'CM_INVALID_JSON';
    return error;
}

export function parseJsonResponse(value) {
    const text = String(value ?? '').trim();
    // Parse before handling wrappers: reasoning tags inside JSON strings are data.
    try { return JSON.parse(text); }
    catch { /* Locate the complete answer among prose, fences, and reasoning. */ }

    let start = -1;
    const stack = [];
    let quoted = false;
    let escaped = false;
    let candidate;
    let candidateValid = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (start < 0) {
            if (char === '<') {
                const opening = text.slice(index).match(/^<(think|thinking|thought|reasoning)(?:\s[^>]*)?>/i);
                if (opening) {
                    const closing = new RegExp(`</${opening[1]}>`, 'ig');
                    closing.lastIndex = index + opening[0].length;
                    const end = closing.exec(text);
                    if (!end) throw invalidJson('The reasoning block did not close.');
                    index = closing.lastIndex - 1;
                    continue;
                }
            }
            // Quotes in surrounding prose must not change JSON string state.
            if (char !== '{' && char !== '[') continue;
            start = index;
            candidateValid = false;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') { quoted = true; continue; }
        if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') {
            if (stack.pop() !== (char === '}' ? '{' : '[')) {
                throw invalidJson('The response has mismatched JSON brackets.');
            }
            if (!stack.length) {
                try {
                    candidate = JSON.parse(text.slice(start, index + 1));
                    candidateValid = true;
                } catch { /* A later complete answer may replace a malformed draft. */ }
                start = -1;
            }
        }
    }
    // Never return a nested record or an earlier draft when the final answer is
    // cut off. Coverage must only be committed after a complete result validates.
    if (start >= 0) throw invalidJson('The JSON response is incomplete; a string or bracket did not close.');
    if (candidateValid) return candidate;
    throw invalidJson('No complete, syntactically valid JSON value was found.');
}
