import { minimumReasoningEffort } from './model-compatibility.js?v=0.15.0-testing.1';

function normalizedMode(mode) {
    const value = String(mode || '').toLowerCase();
    if (value === 'min') return 'minimum';
    return ['off', 'minimum', 'low', 'medium', 'high', 'max', 'auto', 'default'].includes(value) ? value : 'off';
}

function identifyGemini({ source = '', model = '', url = '', profileName = '' } = {}) {
    const provider = String(source).toLowerCase();
    const address = String(url).toLowerCase();
    const identity = `${model} ${profileName}`.toLowerCase();
    const detected = /gemini/.test(identity)
        || /(?:^|[-_ ])(?:google|makersuite|vertexai|vertex-ai)(?:$|[-_ ])/.test(provider)
        || address.includes('generativelanguage.googleapis.com');
    if (!detected) return null;

    const version = identity.match(/gemini[^\d]*(\d+)(?:[._-](\d+))?/);
    const major = Number(version?.[1]);
    const minor = Number(version?.[2] || 0);
    return {
        knownThinkingModel: major > 2 || (major === 2 && minor >= 5),
        canDisableThinking: major === 2 && minor === 5 && /flash/.test(identity) && !/pro/.test(identity),
        supportsMinimalThinking: major >= 3 && /flash/.test(identity) && !/pro/.test(identity),
    };
}

function identifyCustomEndpoint({ model = '', url = '', profileName = '' } = {}) {
    const address = String(url).toLowerCase();
    const identity = `${profileName} ${model}`.toLowerCase();
    if (address.includes('openrouter.ai') || identity.includes('openrouter')) return 'openrouter';
    if (address.includes('ollama') || address.includes(':11434') || identity.includes('ollama')) return 'ollama';
    if (address.includes('dashscope') || address.includes('aliyuncs') || identity.includes('qwen')) return 'qwen';
    if (address.includes('vllm') || identity.includes('vllm')) return 'vllm';
    if (address.includes('deepseek.com') || identity.includes('deepseek')) return 'deepseek';
    return 'openai-compatible';
}

function customBody(adapter, mode, model, reasoningEffort = '') {
    if (mode === 'default') return {};
    const off = mode === 'off';
    switch (adapter) {
        case 'deepseek':
            return { thinking: { type: off ? 'disabled' : 'enabled' } };
        case 'openrouter':
            return { reasoning: { effort: reasoningEffort || (off ? 'none' : 'minimal'), exclude: true } };
        case 'ollama':
            return { think: off ? false : (String(model).toLowerCase().includes('gpt-oss') ? 'low' : true) };
        case 'qwen':
            return { enable_thinking: !off };
        case 'vllm':
            return off
                ? { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } }
                : { reasoning_effort: 'low' };
        default:
            return { reasoning_effort: reasoningEffort || (off ? 'none' : 'minimal') };
    }
}

/**
 * Translate Continuity's simple policy into the controls understood by the
 * selected SillyTavern source or Custom/OpenAI-compatible endpoint.
 */
export function buildThinkingRequest({ mode, source = '', model = '', url = '', profileName = '' } = {}) {
    mode = normalizedMode(mode);
    const gemini = identifyGemini({ source, model, url, profileName });
    const nativeOpenRouter = String(source).toLowerCase() === 'openrouter';
    if (mode === 'default' || mode === 'auto') {
        // SillyTavern's native OpenRouter route translates an omitted value to
        // reasoning.exclude=true. Auto must state the safe provider default
        // explicitly or reasoning-mandatory models such as Ox-alpha reject it.
        if (nativeOpenRouter) {
            return { adapter: 'openrouter-provider-default', payload: { include_reasoning: true }, controlled: false };
        }
        return { adapter: gemini ? 'gemini-provider-default' : (source || 'provider-default'), payload: {}, controlled: false };
    }
    if (gemini && !gemini.knownThinkingModel) {
        return { adapter: 'gemini-provider-default', payload: {}, controlled: false };
    }

    const nativeGoogleSource = /^(?:google|makersuite|vertexai|vertex-ai)$/i.test(String(source));
    const minimalGeminiEffort = nativeGoogleSource ? 'min' : 'minimal';
    const requestedEffort = mode === 'minimum' ? minimumReasoningEffort(model) : mode;
    const reasoningEffort = gemini
        ? (mode === 'off' && gemini.canDisableThinking
            ? 'none'
            : mode === 'off' ? (gemini.supportsMinimalThinking ? minimalGeminiEffort : 'low')
                : mode === 'minimum' ? (gemini.supportsMinimalThinking ? minimalGeminiEffort : 'low')
                    : requestedEffort)
        : (mode === 'off' ? 'none' : requestedEffort);

    const normalized = {
        include_reasoning: mode !== 'off',
        reasoning_effort: reasoningEffort,
    };
    if (source !== 'custom') {
        return { adapter: gemini ? 'gemini' : (source || 'sillytavern-active'), payload: normalized, controlled: true };
    }

    const adapter = identifyCustomEndpoint({ model, url, profileName });
    const includeBody = customBody(adapter, mode, model, gemini ? reasoningEffort : '');
    return {
        adapter: gemini ? `gemini-${adapter}` : adapter,
        payload: { ...normalized, custom_include_body: JSON.stringify(includeBody) },
        controlled: true,
    };
}

/**
 * Continuity's L1 extraction schema is intentionally broad and deeply nested.
 * Gemini may reject that one schema with a generic INVALID_ARGUMENT, so L1 uses
 * its exact-shape prompt and local validator there. Smaller L2, L3, and
 * correction schemas remain enabled.
 */
export function shouldSendStructuredSchema(adapter = '', jsonSchema = null) {
    if (!String(adapter).startsWith('gemini')) return true;
    const schemaName = typeof jsonSchema === 'string' ? jsonSchema : jsonSchema?.name;
    return Boolean(schemaName) && schemaName !== 'continuity_memory_extraction';
}

export function isThinkingControlError(error) {
    if (isMandatoryThinkingError(error)) return true;
    const message = String(error?.cause?.message || error?.message || error).toLowerCase();
    const rejection = '(?:unknown|unsupported|invalid|restricted|not permitted|not allowed|cannot|can not|must be|only support)';
    const control = '(?:thinking|reasoning|enable_thinking|reasoning_effort|chat_template_kwargs|\\bthink\\b)';
    return new RegExp(`${rejection}[^\\n]*${control}|${control}[^\\n]*${rejection}`).test(message);
}

export function isMandatoryThinkingError(error) {
    const message = String(error?.cause?.message || error?.message || error).toLowerCase();
    return /(?:thinking|reasoning)[^\n]*(?:mandatory|required|requires?|must be enabled|cannot be disabled|can not be disabled)|(?:mandatory|required|requires?)[^\n]*(?:thinking|reasoning)/i.test(message);
}

export function mandatoryThinkingPayload(payload = {}) {
    const fallback = { ...payload, include_reasoning: true };
    if (!fallback.reasoning_effort || ['none', 'off', 'disabled'].includes(String(fallback.reasoning_effort).toLowerCase())) {
        fallback.reasoning_effort = 'low';
    }
    if (fallback.custom_include_body) {
        try {
            const body = JSON.parse(fallback.custom_include_body);
            if (body.reasoning && typeof body.reasoning === 'object') {
                body.reasoning = { ...body.reasoning, effort: body.reasoning.effort === 'none' ? 'low' : (body.reasoning.effort || 'low'), exclude: false };
            }
            if (body.thinking && typeof body.thinking === 'object' && body.thinking.type === 'disabled') body.thinking.type = 'enabled';
            if ('enable_thinking' in body) body.enable_thinking = true;
            if ('think' in body && body.think === false) body.think = true;
            fallback.custom_include_body = JSON.stringify(body);
        } catch {
            delete fallback.custom_include_body;
        }
    }
    return fallback;
}

export function thinkingControlFallbackPayload(error, payload = {}) {
    if (!isMandatoryThinkingError(error)) return {};
    return mandatoryThinkingPayload(payload);
}
