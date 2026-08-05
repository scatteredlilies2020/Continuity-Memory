function normalizedMode(mode) {
    return ['off', 'minimum', 'default'].includes(mode) ? mode : 'off';
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

function customBody(adapter, mode, model) {
    if (mode === 'default') return {};
    const off = mode === 'off';
    switch (adapter) {
        case 'deepseek':
            return { thinking: { type: off ? 'disabled' : 'enabled' } };
        case 'openrouter':
            return { reasoning: { effort: off ? 'none' : 'minimal', exclude: true } };
        case 'ollama':
            return { think: off ? false : (String(model).toLowerCase().includes('gpt-oss') ? 'low' : true) };
        case 'qwen':
            return { enable_thinking: !off };
        case 'vllm':
            return off
                ? { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } }
                : { reasoning_effort: 'low' };
        default:
            return { reasoning_effort: off ? 'none' : 'minimal' };
    }
}

/**
 * Translate Continuity's simple policy into the controls understood by the
 * selected SillyTavern source or Custom/OpenAI-compatible endpoint.
 */
export function buildThinkingRequest({ mode, source = '', model = '', url = '', profileName = '' } = {}) {
    mode = normalizedMode(mode);
    if (mode === 'default') return { adapter: source || 'provider-default', payload: {}, controlled: false };

    const normalized = mode === 'off'
        ? { include_reasoning: false, reasoning_effort: 'none' }
        : { include_reasoning: true, reasoning_effort: 'min' };
    if (source !== 'custom') {
        return { adapter: source || 'sillytavern-active', payload: normalized, controlled: true };
    }

    const adapter = identifyCustomEndpoint({ model, url, profileName });
    const includeBody = customBody(adapter, mode, model);
    return {
        adapter,
        payload: { ...normalized, custom_include_body: JSON.stringify(includeBody) },
        controlled: true,
    };
}

export function isThinkingControlError(error) {
    const message = String(error?.cause?.message || error?.message || error).toLowerCase();
    const rejection = '(?:unknown|unsupported|invalid|restricted|not permitted|not allowed|cannot|can not|must be|only support)';
    const control = '(?:thinking|reasoning|enable_thinking|reasoning_effort|chat_template_kwargs|\\bthink\\b)';
    return new RegExp(`${rejection}[^\\n]*${control}|${control}[^\\n]*${rejection}`).test(message);
}
