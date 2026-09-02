export const DEFAULT_MAX_ADAPTIVE_SPLITS = 16;

function errorChainText(error) {
    const parts = [];
    const seen = new Set();
    let current = error;
    while (current && !seen.has(current) && parts.length < 8) {
        seen.add(current);
        parts.push(String(current?.message || current));
        current = current?.cause;
    }
    return parts.join(' | ').toLocaleLowerCase();
}

export function isExplicitExtractionOutputLimitError(error) {
    const message = errorChainText(error);
    return /finish[_ -]?reason[^\n]*(?:length|max_tokens)|output (?:token )?limit|maximum output length/.test(message);
}

export function isRecoverableExtractionOutputError(error) {
    const message = errorChainText(error);
    return isExplicitExtractionOutputLimitError(error)
        || /maximum context length|context length|token limit|returned no text|without a valid json object|returned no json object|no valid chronological scene capsule|extractor field [^\n]+ is not an array/.test(message);
}

// Only errors that indicate incomplete text should cause recursive splitting.
// A schema-shaped response with the wrong field type is usually a provider
// compatibility problem; splitting it repeatedly only multiplies API cost.
export function isAdaptiveExtractionSplitError(error) {
    const message = errorChainText(error);
    return isExplicitExtractionOutputLimitError(error)
        || /maximum context length|context length|token limit|returned no text|without a valid json object|returned no json object|unexpected end|invalid json/.test(message);
}

function rangeLabel(messages) {
    const first = Number(messages?.[0]?.index);
    const last = Number(messages?.at(-1)?.index);
    if (!Number.isFinite(first)) return 'the current section';
    return first === last ? `message ${first}` : `messages ${first}-${last}`;
}

function recoveryFailure(error, messages, reason) {
    const failure = new Error(`Extraction output remained incomplete for ${rangeLabel(messages)} after adaptive retries. ${reason}`);
    failure.cause = error;
    return failure;
}

export async function splitMessagesByTokenBalance(messages, measureMessages) {
    const source = Array.isArray(messages) ? messages : [];
    if (source.length < 2) return null;
    const weights = [];
    for (const message of source) {
        weights.push(Math.max(1, Number(await measureMessages([message])) || 1));
    }
    const total = weights.reduce((sum, value) => sum + value, 0);
    let running = 0;
    let boundary = 1;
    let bestDifference = Number.POSITIVE_INFINITY;
    for (let index = 1; index < source.length; index++) {
        running += weights[index - 1];
        const difference = Math.abs(total - running * 2);
        if (difference < bestDifference) {
            bestDifference = difference;
            boundary = index;
        }
    }
    const parts = [source.slice(0, boundary), source.slice(boundary)];
    return Promise.all(parts.map(async part => ({
        messages: part,
        tokens: Math.max(1, Number(await measureMessages(part)) || 1),
    })));
}

export async function processAdaptiveExtractionChunks(initialChunks, {
    extract,
    save,
    measureMessages,
    onAttempt = () => {},
    onSplit = () => {},
    afterSave = () => {},
    maxSplits = DEFAULT_MAX_ADAPTIVE_SPLITS,
} = {}) {
    if (typeof extract !== 'function' || typeof save !== 'function' || typeof measureMessages !== 'function') {
        throw new Error('Adaptive extraction requires extract, save, and measureMessages callbacks.');
    }
    const queue = (Array.isArray(initialChunks) ? initialChunks : [])
        .filter(chunk => Array.isArray(chunk?.messages) && chunk.messages.length)
        .map(chunk => ({ messages: [...chunk.messages], tokens: Math.max(1, Number(chunk.tokens) || 1) }));
    let planned = queue.length;
    let completed = 0;
    let splits = 0;

    while (queue.length) {
        const chunk = queue.shift();
        await onAttempt({ ...chunk, current: completed + 1, total: planned, completed, splits });
        let result;
        try {
            result = await extract(chunk.messages);
        } catch (error) {
            if (!isAdaptiveExtractionSplitError(error)) throw error;
            if (chunk.messages.length < 2) {
                throw recoveryFailure(error, chunk.messages, 'This section contains one message and cannot be split safely at a message boundary.');
            }
            if (splits >= Math.max(0, Number(maxSplits) || 0)) {
                throw recoveryFailure(error, chunk.messages, 'The adaptive split limit was reached.');
            }
            const parts = await splitMessagesByTokenBalance(chunk.messages, measureMessages);
            if (!parts?.[0]?.messages?.length || !parts?.[1]?.messages?.length) {
                throw recoveryFailure(error, chunk.messages, 'Continuity could not create two safe message-boundary sections.');
            }
            splits++;
            planned++;
            await onSplit({ original: chunk, parts, error, current: completed + 1, total: planned, completed, splits });
            queue.unshift(parts[1]);
            queue.unshift(parts[0]);
            continue;
        }

        await save(result, chunk.messages);
        completed++;
        await afterSave({ result, messages: chunk.messages, tokens: chunk.tokens, completed, total: planned, splits });
    }

    return { completed, total: planned, splits };
}
