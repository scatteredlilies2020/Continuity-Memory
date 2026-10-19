import { substituteParams, getRequestHeaders } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { oai_settings, openai_setting_names, openai_settings, promptManager } from '/scripts/openai.js';
import * as hostOpenAI from '/scripts/openai.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { presetPrefill, summaryPrefill, requestPrefill, decodeMemoryResponse, memoryWireRequest, memoryRequestMessages } from './preset-prefill.js';
import { applyEndpointPrefill } from './endpoint-prefill.js';
import { getSettings } from './settings.js?v=0.15.0-testing.30&belief-wording=4&pending-recovery=1';

export function resolveMemoryPrefill(profileId = '', { expandMacros = true, summary = false } = {}) {
    if (summary) {
        const custom = summaryPrefill(getSettings(), expandMacros ? substituteParams : undefined);
        if (custom) return custom;
    }
    const profile = profileId && profileId !== '__direct__'
        ? ConnectionManagerRequestService.getProfile(profileId) : null;
    const active = !profile?.preset || profile.preset === oai_settings?.preset_settings_openai;
    const preset = active ? oai_settings : openai_settings?.[openai_setting_names?.[profile.preset]];
    const order = active && promptManager?.activeCharacter
        ? promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) : undefined;
    return presetPrefill(preset, { order, characterId: getContext().characterId, ...(expandMacros ? { substitute: substituteParams } : {}) });
}

function memoryPresetSettings(profileId) {
    const profile = profileId && profileId !== '__direct__' ? ConnectionManagerRequestService.getProfile(profileId) : null;
    if (!profile?.preset || profile.preset === oai_settings.preset_settings_openai) return oai_settings;
    const saved = openai_settings?.[openai_setting_names?.[profile.preset]];
    // Do not inherit the active RP preset's prefill switches into a different preset.
    return saved?.oai_settings ?? saved ?? {};
}

let forkModules;
async function endpointModules() {
    // No fork-only static imports: stock staging/release must load normally.
    if (typeof hostOpenAI.consumeStructuredPrefillInfo !== 'function') return null;
    forkModules ??= Promise.all([
        import('/scripts/model-catalog.js'), import('/scripts/reasoning-capabilities.js'),
        import('/scripts/kimi.js'), import('/scripts/sdk-options.js'),
    ]);
    return forkModules;
}

export async function prepareMemoryRequest(request, profileId = '', { sdk = true } = {}) {
    let body = structuredClone(request);
    let metadata = { prefill: requestPrefill(body.messages) };
    const modules = await endpointModules();
    if (modules) {
        const [catalog, reasoning, kimi, transport] = modules;
        const settings = memoryPresetSettings(profileId);
        const source = body.chat_completion_source;
        const model = body.model;
        const modelInfo = hostOpenAI.model_list?.find(item => item.id === model);
        const capabilities = catalog.getModelCapabilities(source, model, modelInfo);
        const policy = reasoning.resolveReasoningCapabilities({ source, model, modelInfo });
        const mode = settings.structured_prefill === true ? 'on' : String(settings.structured_prefill || 'off').toLowerCase();
        const preferNative = kimi.supportsKimiNativePrefill(source, model)
            && kimi.shouldPreferKimiNativePrefill(body.messages, mode, policy.forcedReasoning || (body.include_reasoning ?? settings.show_thoughts));
        ({ body, metadata } = applyEndpointPrefill(body, settings, { capabilities, forcedReasoning: policy.forcedReasoning, preferNative }));
        if (sdk) {
            // Active generation is already SDK-shaped. Newly applied Continuity
            // thinking controls must win over its preset's provider options.
            const previousOptions = body.providerOptions;
            delete body.providerOptions;
            body = transport.toSdkRequest(body);
            for (const namespace of Object.keys(previousOptions || {})) {
                const updates = Object.fromEntries(Object.entries(body.providerOptions?.[namespace] || {}).filter(([, value]) => value !== undefined));
                body.providerOptions ??= {};
                body.providerOptions[namespace] = { ...previousOptions[namespace], ...updates };
            }
        }
    }
    return { ...body, continuity_prefill: metadata };
}

export async function sendMemoryProfileRequest(profileId, messages, maxTokens, options, overrides) {
    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const api = ConnectionManagerRequestService.validateProfile(profile);
    if (api.selected !== 'openai' || !requestPrefill(messages)) {
        return ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, options, overrides);
    }
    const prepared = await prepareMemoryRequest({
        ...overrides, messages, model: profile.model, chat_completion_source: api.source,
    }, profileId, { sdk: false });
    const { messages: wireMessages, ...payload } = memoryWireRequest(prepared);
    // Connection Manager still owns routing, proxy URLs/passwords and secret IDs.
    const response = await ConnectionManagerRequestService.sendRequest(profileId, wireMessages, maxTokens, options, payload);
    if (!prepared.continuity_prefill.structured) return response;
    const copy = structuredClone(response);
    const content = copy?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map(part => part.text || '').join('') : content;
    copy.choices[0].message.content = decodeMemoryResponse(text, prepared.continuity_prefill);
    copy.continuity_prefill_complete = true;
    return copy;
}

export async function prepareDetachedPrefills(value, profileId) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value.messages) && value.chat_completion_source) return prepareMemoryRequest(value, profileId);
    // Request variants, split tasks, and Chronicle plans all carry independent metadata.
    if (Array.isArray(value)) return Promise.all(value.map(item => prepareDetachedPrefills(item, profileId)));
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await prepareDetachedPrefills(item, profileId);
    return result;
}

export async function generateEndpointMemory(options, applyPolicy) {
    if (!options.prefill || (options.api ?? getContext().mainApi) !== 'openai' || !await endpointModules()) return null;
    // Build routing with the host, but keep schema-prefill state request-local.
    // Never consume or overwrite the fork's global RP response decoder.
    const settings = { ...structuredClone(oai_settings), structured_prefill: 'off',
        function_calling: false, n: 1, stream_openai: false,
        ...(options.responseLength != null ? { openai_max_tokens: options.responseLength } : {}),
    };
    const { generate_data: body } = await hostOpenAI.createGenerationParameters(
        settings, hostOpenAI.getChatCompletionModel(settings), 'quiet',
        memoryRequestMessages(options.prompt, options.systemPrompt, options.prefill),
    );
    applyPolicy(body);
    const prepared = await prepareMemoryRequest(body);
    const requestOptions = {
        method: 'POST', headers: getRequestHeaders(), signal: options.signal,
        body: JSON.stringify(memoryWireRequest(prepared)),
    };
    options.signal?.throwIfAborted();
    options.onDispatch?.();
    const response = await fetch('/api/backends/chat-completions/generate', requestOptions);
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error?.message || payload.message || `Memory API failed (${response.status}).`);
    const finish = payload.finishReason ?? payload.choices?.[0]?.finish_reason;
    if (['length', 'max_tokens'].includes(finish)) throw new Error('Memory API reached its output limit.');
    const text = payload.text ?? payload.completions?.[0]?.text ?? payload.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Memory API returned no text.');
    return decodeMemoryResponse(text, prepared.continuity_prefill);
}
