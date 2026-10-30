export function dynamicExtractionChunk(contextSize) {
    const size = Math.max(0, Number(contextSize) || 50000);
    return Math.min(8000, Math.max(1000, Math.round(size * 0.20)));
}

export function resolveExtractionChunk(configuredTokens, contextSize) {
    const configured = Math.max(0, Number(configuredTokens) || 0);
    return configured > 0
        ? Math.max(1, configured)
        : dynamicExtractionChunk(contextSize);
}

export function planExtractionOutput(messages, configuredTarget = 0) {
    // This estimate controls concise output planning, not source selection.
    // The source tokenizer still determines message-boundary input chunks.
    const sourceTokens = Math.ceil((messages || []).reduce((sum, message) => sum + String(message.text || '').length, 0) / 4);
    const supplied = Number(configuredTarget);
    const requested = Number.isFinite(supplied) ? Math.max(0, Math.floor(supplied)) : 0;
    const targetTokens = requested || Math.min(4096, Math.max(768, Math.ceil((sourceTokens * 0.5 + 256) / 256) * 256));
    // Summary size and wire allowance serve different jobs. Leave room for
    // JSON structure and providers that count reasoning in the output budget.
    const responseTokens = Math.min(65536, Math.max(32768, Math.ceil(targetTokens * 2 / 8192) * 8192));
    const guidance = `Aim for roughly ${targetTokens} output tokens for the entire JSON response, including the Digest and chronicleEntry. This is a soft target, not a minimum. Summarize rather than reproduce the source prose. Use concise changed records, combine repetition, and omit unchanged records and incidental description. Do not retell the same episode in every field; retain distinct information in its appropriate record. Keep the Digest and chronicleEntry compact while preserving consequential setup, changes, conditions, attribution, knowledge boundaries, and foundational canon. Use complete sentences and finish all required JSON fields; never truncate or pad to meet the target.`;
    return { targetTokens, responseTokens, guidance };
}
