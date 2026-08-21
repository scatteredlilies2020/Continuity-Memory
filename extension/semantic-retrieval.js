import { extractMessageFromData } from '/script.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { isThinkingControlError, thinkingControlFallbackPayload } from './thinking-policy.js?v=0.14.0-standalone.241';
import { generateWithThinkingPolicy, requestDirectText, resolveThinkingModeForProfile } from './engine.js?v=0.14.0-standalone.241';
import { parseExpandedTerms } from './semantic-terms.js';
import { recentRetrievalQuery } from './retrieval-query.js';
import { getSettings } from './settings.js?v=0.14.0-standalone.241';
import { buildThinkingRequest } from './thinking-policy.js?v=0.14.0-standalone.241';
import { buildRetrievalSystemPrompt, DEFAULT_RETRIEVAL_QUERY_TEMPLATE, DEFAULT_RETRIEVAL_SYSTEM_PROMPT, renderPromptTemplate } from './prompts.js?v=0.14.0-standalone.241';
import { connectionProfileModel, isolatedProfileOptions, isolatedProfilePayload } from './profile-request-policy.js?v=0.14.0-standalone.241';
import { outputTokenPayload } from './model-compatibility.js?v=0.14.0-standalone.241';

const cache = new Map();

export function clearRetrievalExpansionCache() {
    const removed = cache.size;
    cache.clear();
    return removed;
}

async function requestExpansion(prompt) {
    const settings = getSettings();
    const systemPrompt = buildRetrievalSystemPrompt(settings.retrievalSystemPrompt ?? DEFAULT_RETRIEVAL_SYSTEM_PROMPT);
    const profileId = settings.retrievalProfileId || settings.memoryProfileId;
    const thinkingMode = resolveThinkingModeForProfile(settings.retrievalThinkingMode, profileId);
    if (!profileId) {
        return await generateWithThinkingPolicy({ prompt, systemPrompt, responseLength: 300 }, thinkingMode);
    }
    if (profileId === '__direct__') return requestDirectText(prompt, systemPrompt, 300, 'retrieval', thinkingMode);
    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const apiMap = ConnectionManagerRequestService.validateProfile(profile);
    const model = connectionProfileModel(profile, 'AI retrieval');
    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }];
    const options = isolatedProfileOptions();
    const thinking = buildThinkingRequest({
        mode: thinkingMode,
        source: apiMap.source,
        model,
        url: profile['api-url'],
        profileName: profile.name,
    });
    let response;
    try {
        response = await ConnectionManagerRequestService.sendRequest(
            profileId, messages, 300, options, isolatedProfilePayload({ ...outputTokenPayload(model, 300), ...thinking.payload }),
        );
    } catch (error) {
        if (!isThinkingControlError(error)) throw error;
        const fallbackPayload = thinkingControlFallbackPayload(error, thinking.payload);
        if (!thinking.controlled && !Object.keys(fallbackPayload).length) throw error;
        response = await ConnectionManagerRequestService.sendRequest(
            profileId, messages, 300, options, isolatedProfilePayload({ ...outputTokenPayload(model, 300), ...fallbackPayload }),
        );
    }
    const result = extractMessageFromData(response, apiMap.selected);
    if (!result || typeof result !== 'string') throw new Error('AI retrieval profile returned no text.');
    return result;
}

export async function expandRetrievalTerms(recentMessages) {
    const settings = getSettings();
    const query = recentRetrievalQuery(recentMessages, settings.retrievalQueryMessages);
    const profileId = settings.retrievalProfileId || settings.memoryProfileId;
    const thinkingMode = resolveThinkingModeForProfile(settings.retrievalThinkingMode, profileId);
    const directConfig = profileId === '__direct__'
        ? `${settings.retrievalDirectProvider}|${settings.retrievalDirectUrl}|${settings.retrievalDirectModel}|${settings.retrievalOpenRouterUrl}|${settings.retrievalOpenRouterModel}`
        : '';
    const key = `${profileId}|${directConfig}|${thinkingMode}|${settings.retrievalSystemPrompt}|${query}`;
    if (cache.has(key)) return cache.get(key);
    const prompt = renderPromptTemplate(settings.retrievalQueryTemplate ?? DEFAULT_RETRIEVAL_QUERY_TEMPLATE, { conversation: query }, ['conversation']);
    const raw = await requestExpansion(prompt);
    const terms = parseExpandedTerms(raw);
    cache.set(key, terms);
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return terms;
}
