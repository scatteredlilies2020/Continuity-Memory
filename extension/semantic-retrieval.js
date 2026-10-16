import { extractMessageFromData } from '/script.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { resolveMemoryPrefill, sendMemoryProfileRequest } from './preset-prefill-host.js';
import { memoryRequestMessages, responseWithPrefill } from './preset-prefill.js';
import { isThinkingControlError, thinkingControlFallbackPayload } from './thinking-policy.js?v=0.15.0-testing.30';
import { generateWithThinkingPolicy, requestDirectText, resolveThinkingModeForProfile } from './engine.js?v=0.15.0-testing.30&belief-wording=4';
import { parseExpandedTerms } from './semantic-terms.js?v=0.15.0-testing.30';
import { recentRetrievalQuery } from './retrieval-query.js?v=0.15.0-testing.30';
import { getSettings } from './settings.js?v=0.15.0-testing.30&belief-wording=4';
import { buildThinkingRequest } from './thinking-policy.js?v=0.15.0-testing.30';
import { buildRetrievalSystemPrompt, DEFAULT_RETRIEVAL_QUERY_TEMPLATE, DEFAULT_RETRIEVAL_SYSTEM_PROMPT, renderPromptTemplate } from './prompts.js?v=0.15.0-testing.30&belief-wording=4';
import { connectionProfileModel, isolatedProfileOptions, isolatedProfilePayload } from './profile-request-policy.js?v=0.15.0-testing.30';
import { outputTokenPayload } from './model-compatibility.js?v=0.15.0-testing.30';
import { checkRetrievalDeadline } from './retrieval-assist.js?bounded-recall=1&catchup-gate=1';

const cache = new Map();
const pending = new Map();
let cacheEpoch = 0;

export function clearRetrievalExpansionCache() {
    const removed = cache.size;
    cacheEpoch++;
    cache.clear();
    pending.clear();
    return removed;
}

async function requestExpansion(prompt, signal, onDispatch) {
    const settings = getSettings();
    const systemPrompt = buildRetrievalSystemPrompt(settings.retrievalSystemPrompt ?? DEFAULT_RETRIEVAL_SYSTEM_PROMPT);
    const profileId = settings.retrievalProfileId || settings.memoryProfileId;
    const thinkingMode = resolveThinkingModeForProfile(settings.retrievalThinkingMode, profileId);
    if (!profileId) {
        return await generateWithThinkingPolicy({ prompt, systemPrompt, responseLength: 300, signal, onDispatch }, thinkingMode);
    }
    if (profileId === '__direct__') return requestDirectText(prompt, systemPrompt, 300, settings.retrievalProfileId ? 'retrieval' : 'extraction', thinkingMode, { signal, onDispatch });
    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const apiMap = ConnectionManagerRequestService.validateProfile(profile);
    const model = connectionProfileModel(profile, 'AI retrieval');
    const prefill = resolveMemoryPrefill(profileId);
    const messages = memoryRequestMessages(prompt, systemPrompt, prefill);
    const options = isolatedProfileOptions({ signal, onDispatch });
    const thinking = buildThinkingRequest({
        mode: thinkingMode,
        source: apiMap.source,
        model,
        url: profile['api-url'],
        profileName: profile.name,
    });
    let response;
    try {
        response = await sendMemoryProfileRequest(
            profileId, messages, 300, options, isolatedProfilePayload({ ...outputTokenPayload(model, 300), ...thinking.payload }),
        );
    } catch (error) {
        signal?.throwIfAborted();
        if (!isThinkingControlError(error)) throw error;
        const fallbackPayload = thinkingControlFallbackPayload(error, thinking.payload);
        if (!thinking.controlled && !Object.keys(fallbackPayload).length) throw error;
        response = await sendMemoryProfileRequest(
            profileId, messages, 300, options, isolatedProfilePayload({ ...outputTokenPayload(model, 300), ...fallbackPayload }),
        );
    }
    const result = extractMessageFromData(response, apiMap.selected);
    if (!result || typeof result !== 'string') throw new Error('AI retrieval profile returned no text.');
    return response?.continuity_prefill_complete ? result : responseWithPrefill(result, prefill);
}

export async function expandRetrievalTerms(recentMessages, { signal, deadline, onDispatch } = {}) {
    checkRetrievalDeadline(signal, deadline);
    const settings = getSettings();
    const query = recentRetrievalQuery(recentMessages, settings.retrievalQueryMessages);
    const profileId = settings.retrievalProfileId || settings.memoryProfileId;
    const thinkingMode = resolveThinkingModeForProfile(settings.retrievalThinkingMode, profileId);
    const kind = settings.retrievalProfileId ? 'retrieval' : 'extraction';
    const directConfig = profileId === '__direct__'
        ? `${settings[`${kind}DirectProvider`]}|${settings[`${kind}DirectUrl`]}|${settings[`${kind}DirectModel`]}|${settings[`${kind}OpenRouterUrl`]}|${settings[`${kind}OpenRouterModel`]}|${settings[`${kind}DirectSecretId`]}|${settings[`${kind}OpenRouterSecretId`]}`
        : '';
    const profileConfig = profileId && profileId !== '__direct__'
        ? JSON.stringify(ConnectionManagerRequestService.getProfile(profileId)) : '';
    const key = JSON.stringify([profileId, profileConfig, directConfig, thinkingMode, settings.retrievalSystemPrompt, settings.retrievalQueryTemplate, query, resolveMemoryPrefill(profileId)]);
    if (profileId && cache.has(key)) return [...cache.get(key)];
    // A preview owns its cancellation signal. A visible reply must not join
    // an aborted preview or inherit that preview's longer deadline.
    const existing = pending.get(key);
    if (existing && !existing.signal?.aborted && existing.signal === signal) {
        const terms = await existing.promise;
        checkRetrievalDeadline(signal, deadline);
        return [...terms];
    }
    const epoch = cacheEpoch;
    const operation = (async () => {
        const prompt = renderPromptTemplate(settings.retrievalQueryTemplate ?? DEFAULT_RETRIEVAL_QUERY_TEMPLATE, { conversation: query }, ['conversation']);
        const raw = await requestExpansion(prompt, signal, onDispatch);
        checkRetrievalDeadline(signal, deadline);
        const terms = parseExpandedTerms(raw);
        if (profileId && cacheEpoch === epoch) {
            cache.set(key, [...terms]);
            if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        return terms;
    })().finally(() => {
        if (pending.get(key)?.promise === operation) pending.delete(key);
    });
    pending.set(key, { promise: operation, signal });
    return [...await operation];
}
