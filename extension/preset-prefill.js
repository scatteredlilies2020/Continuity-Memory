// Only import the preset's response prefix, never its roleplay system prompts,
// examples, chat history, or Continuity's own injected memory.
export function presetPrefill(preset, { order, characterId, substitute = text => text } = {}) {
    preset = preset?.oai_settings ?? preset;
    if (!preset) return '';
    const orders = preset.prompt_order || [];
    order ??= orders.find(item => characterId != null && String(item.character_id) === String(characterId))?.order
        ?? orders.find(item => String(item.character_id) === '100001')?.order
        ?? [];
    const prompts = new Map((preset.prompts || []).map(prompt => [prompt.identifier, prompt]));
    const enabled = order.filter(entry => entry.enabled).map(entry => prompts.get(entry.identifier)).filter(prompt =>
        prompt && prompt.identifier !== 'continuity_memory_dynamic'
        && (!prompt.injection_trigger?.length || prompt.injection_trigger.includes('normal')));
    // A migrated entry (even disabled) supersedes the old field.
    if (typeof preset.assistant_prefill === 'string' && !prompts.has('assistantPrefill')) {
        const legacy = substitute(preset.assistant_prefill);
        if (legacy.trim()) return legacy;
    }
    const absolute = enabled.filter(prompt => !prompt.marker && Number(prompt.injection_position) === 1
        && Number(prompt.injection_depth) === 0 && typeof prompt.content === 'string' && prompt.content.trim());
    const roles = { system: 0, user: 1, assistant: 2 };
    absolute.sort((a, b) => (Number(b.injection_order ?? 100) - Number(a.injection_order ?? 100))
        || ((roles[a.role] ?? 0) - (roles[b.role] ?? 0)));
    const sequence = [];
    for (const prompt of enabled) {
        if (Number(prompt.injection_position) === 1) continue;
        if (prompt.marker || prompt.identifier === 'chatHistory') {
            // Markers are boundaries, not assistant prefixes.
            sequence.push({ role: 'boundary' });
            if (prompt.identifier === 'chatHistory') sequence.push(...absolute);
        } else {
            if (typeof prompt.content === 'string' && prompt.content.trim()) sequence.push(prompt);
        }
    }
    if (!enabled.some(prompt => prompt.identifier === 'chatHistory')) sequence.push(...absolute);
    const tail = [];
    for (let i = sequence.length - 1; i >= 0; i--) {
        if (sequence[i].role === 'system') continue;
        if (sequence[i].role !== 'assistant') break;
        tail.unshift(sequence[i].content);
    }
    // Expand only the selected prefix. Unrelated RP prompts can contain macros
    // with side effects and must not be evaluated by memory requests.
    return tail.map(text => substitute(text)).filter(text => text.trim()).join('\n');
}

export function memoryRequestMessages(prompt, systemPrompt, prefill = '') {
    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
        ...(prefill ? [{ role: 'assistant', content: prefill }] : []),
    ];
}

export function summaryPrefill(settings, substitute = text => text) {
    if (!settings.summaryPrefillEnabled || typeof settings.summaryPrefill !== 'string' || !settings.summaryPrefill.trim()) return '';
    const expanded = substitute(settings.summaryPrefill);
    return expanded.trim() ? expanded : '';
}

export function responseWithPrefill(response, prefill = '') {
    if (!prefill || typeof response !== 'string' || response.startsWith(prefill)) return response;
    // Some providers return the complete JSON rather than just a continuation.
    // Do not break an already complete structured response by duplicating '{'.
    try {
        const fenced = response.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        const parsed = JSON.parse(fenced ? fenced[1] : response);
        if (parsed && typeof parsed === 'object') return response;
    } catch { /* Native prefill responses may be only the JSON suffix. */ }
    return prefill + response;
}

export function requestPrefill(messages) {
    return messages?.at(-1)?.role === 'assistant' ? messages.at(-1).content : '';
}

export function appendMemoryFeedback(messages, feedback) {
    const copy = [...messages];
    const index = requestPrefill(copy) ? copy.length - 1 : copy.length;
    copy.splice(index, 0, { role: 'user', content: feedback });
    return copy;
}

// Metadata is local to each request and is never sent to a provider.
export function decodeMemoryResponse(text, { prefill = '', structured = null } = {}) {
    if (!structured) return responseWithPrefill(text, prefill);
    const value = JSON.parse(text);
    let result;
    if (structured.multiField) {
        const keys = structured.keys;
        if (!keys.every(key => typeof value?.[key] === 'string')) throw new Error('Incomplete structured prefill response.');
        result = keys.map(key => value[key]).join('');
    } else {
        if (typeof value?.value !== 'string') throw new Error('Invalid structured prefill response.');
        result = value.value;
    }
    // Gemini uses real newlines. Only decode a token when one was encoded.
    return structured.nlToken ? result.split(structured.nlToken).join('\n') : result;
}

export function memoryWireRequest(body) {
    const { continuity_prefill: ignored, ...wire } = body;
    return wire;
}
