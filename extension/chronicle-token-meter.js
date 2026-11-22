// Count the rendered text as one block: token boundaries and message overhead
// make separately tokenized layers unsuitable for summing into a total.
export function createChronicleTokenMeter(countTokens, onChange, { now = Date.now, retryMs = 30000 } = {}) {
    let current;
    return ({ chatKey, tokenizer, text }) => {
        if (!text || !tokenizer) {
            current = null;
            return { status: text ? 'unavailable' : 'empty' };
        }
        if (current?.chatKey === chatKey && current.tokenizer === tokenizer && current.text === text
            && !(current.status === 'unavailable' && now() >= current.retryAt)) return current;
        const entry = { chatKey, tokenizer, text, status: 'measuring' };
        current = entry;
        void Promise.resolve().then(() => countTokens(text)).then(tokens => {
            if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error('Tokenizer returned no count');
            entry.tokens = tokens;
            entry.status = 'counted';
        }).catch(() => {
            entry.status = 'unavailable';
            entry.retryAt = now() + retryMs;
        }).then(() => {
            if (current === entry) onChange();
        });
        return entry;
    };
}

export function formatChronicleTokenStatus(measurement, target) {
    if (measurement.status === 'empty') return 'Stored Story so far: no active Chronicle entries.';
    if (measurement.status === 'measuring') return 'Stored Story so far: counting tokens…';
    if (measurement.status !== 'counted') return 'Stored Story so far: tokenizer count unavailable.';
    return `Stored Story so far: ${measurement.tokens.toLocaleString()} tokens (SillyTavern tokenizer: ${measurement.tokenizer}; not prompt usage). ${target.toLocaleString()} is a compression target, not a cap.`;
}
