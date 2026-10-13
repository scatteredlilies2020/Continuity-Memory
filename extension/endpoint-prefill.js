import { buildStructuredPrefillSchema } from './structured-prefill-schema.js';
import { requestPrefill } from './preset-prefill.js';

// The fork's on/auto policy, using its live model capability catalog. Upstream
// never enters this adapter: its backend owns native endpoint interpretation.
export function applyEndpointPrefill(body, settings, { capabilities = {}, forcedReasoning = false, preferNative = false } = {}) {
    const prefill = requestPrefill(body.messages);
    const metadata = { prefill };
    if (!prefill || body.json_schema || body.structured_prefill_schema) return { body, metadata };
    const source = body.chat_completion_source;
    const mode = settings.structured_prefill === true ? 'on' : String(settings.structured_prefill || 'off').toLowerCase();
    if (!['on', 'auto'].includes(mode) || preferNative || capabilities.supports_response_schema === false
        || ['ai21', 'siliconflow', 'cometapi', 'nanogpt'].includes(source)) return { body, metadata };
    if (mode === 'auto') {
        if (settings.structured_prefill_auto_providers && Object.hasOwn(settings.structured_prefill_auto_providers, source)
            && !settings.structured_prefill_auto_providers[source]) return { body, metadata };
        if (settings.structured_prefill_auto_disable_for_forced_reasoning && forcedReasoning) return { body, metadata };
        if (String(body.model).toLowerCase().includes('claude') && capabilities.supports_assistant_prefill === true) return { body, metadata };
    }
    const encoded = buildStructuredPrefillSchema(prefill, settings, source, body.model);
    if (!encoded) return { body, metadata };
    metadata.structured = {
        nlToken: encoded.nlToken,
        multiField: !!encoded.isMultiField,
        keys: encoded.isMultiField ? encoded.schema.value.propertyOrdering : undefined,
    };
    return {
        body: {
            ...body,
            messages: body.messages.slice(0, -1),
            ...(encoded.forClaude ? { structured_prefill_schema: encoded.schema } : { json_schema: encoded.schema }),
        },
        metadata,
    };
}
