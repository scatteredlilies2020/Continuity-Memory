import { PROMPT_MANAGER_ID } from './prompt-manager-injection.js';

export function generationMemoryCapacity(contextSize, manager, recentTokens = 0) {
    // The interceptor's contextSize already excludes response tokens. Do not
    // subtract them twice; cap it against the host's currently selected preset.
    const limits = [Number(contextSize)].filter(value => Number.isFinite(value) && value > 0);
    const presetContext = Number(manager?.serviceSettings?.openai_max_context);
    if (Number.isFinite(presetContext) && presetContext > 0) {
        limits.push(Math.max(0, presetContext - Math.max(0, Number(manager?.serviceSettings?.openai_max_tokens) || 0)));
    }
    const size = limits.length ? Math.min(...limits) : 50000;
    const counts = manager?.tokenHandler?.counts || {};
    const fixed = Object.entries(counts).reduce((total, [key, value]) =>
        ['chatHistory', 'conversation', PROMPT_MANAGER_ID].includes(key)
            ? total : total + Math.max(0, Number(value) || 0), 0);
    return Math.max(0, Math.floor(size - fixed - recentTokens - Math.max(512, Math.ceil(size * 0.05))));
}

export async function fitGenerationMemory({ snapshot, contextSize, manager, recentText, countTokens, rebuild }) {
    if (!snapshot?.injection) return snapshot;
    const recentTokens = Math.max(0, Number(await countTokens(recentText)) || 0) + 64;
    const capacity = generationMemoryCapacity(contextSize, manager, recentTokens);
    let candidate = snapshot;
    let target = Math.max(128, Number(snapshot.injectionBudget?.tokens) || capacity);
    // Prefer repacking recall. If the complete Chronicle still exceeds the
    // request's capacity, shorten only this request's injection, never storage.
    for (let attempt = 0; attempt < 4; attempt++) {
        const tokens = Number(await countTokens(candidate.injection));
        if (!Number.isFinite(tokens) || tokens < 0) return limitedSnapshot(candidate, '', 0, capacity);
        if (tokens <= capacity) return { ...candidate, injectionTokens: tokens };
        if (attempt === 3 || target === 128) break;
        target = attempt === 2 ? 128 : Math.max(128, Math.floor(target - (tokens - capacity) * 1.2));
        const result = await rebuild(target);
        candidate = { ...snapshot, injection: result.prompt, injectionTokens: result.estimatedTokens,
            retrieval: result.retrievalDiagnostics, injectionBudget: { ...snapshot.injectionBudget, tokens: target, contextLimited: true } };
    }
    // Keep the most recent end of the assembled memory (including the latest
    // Chronicle), with an explicit excerpt label rather than broken wrappers.
    const header = '[Continuity Memory: context-limited excerpt; saved memory unchanged]\n';
    const characters = Array.from(candidate.injection);
    let low = 1;
    let high = characters.length;
    let injection = '';
    let injectionTokens = 0;
    for (let attempt = 0; low <= high && attempt < 20; attempt++) {
        const length = Math.floor((low + high) / 2);
        const excerpt = header + characters.slice(-length).join('');
        const tokens = Number(await countTokens(excerpt));
        if (Number.isFinite(tokens) && tokens >= 0 && tokens <= capacity) {
            injection = excerpt;
            injectionTokens = tokens;
            low = length + 1;
        } else high = length - 1;
    }
    // Even a zero-capacity request can proceed without a CM mandatory prompt.
    return limitedSnapshot(candidate, injection, injectionTokens, capacity);
}

function limitedSnapshot(snapshot, injection, injectionTokens, capacity) {
    return { ...snapshot, injection, injectionTokens,
        injectionBudget: { ...snapshot.injectionBudget, tokens: capacity, contextLimited: true, injectionShortened: true } };
}
