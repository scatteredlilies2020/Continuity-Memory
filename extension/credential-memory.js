// Password drafts live only in memory. Persist opaque references, never values,
// in CM settings; the host's secrets service owns durable credential storage.
export function directCredentialContext(settings, kind, keys) {
    const openRouter = settings[`${kind}DirectProvider`] === 'openrouter';
    return {
        setting: `${kind}${openRouter ? 'OpenRouter' : 'Direct'}SecretId`,
        slot: openRouter ? keys.OPENROUTER : keys.CUSTOM,
        label: `Continuity ${kind} ${openRouter ? 'OpenRouter key' : 'API password'}`,
    };
}

export function embeddingCredentialContext(settings, keys) {
    const openRouter = settings.embeddingProvider === 'openrouter';
    return {
        setting: openRouter ? 'embeddingOpenRouterSecretId' : 'embeddingProxySecretId',
        slot: openRouter ? keys.OPENROUTER : keys.VLLM,
        label: `Continuity embedding ${openRouter ? 'OpenRouter' : 'proxy'}`,
    };
}

export function createCredentialMemory({ write, remember }) {
    const drafts = new Map();
    const pending = new Map();
    function get(context) { return drafts.get(context.setting) || ''; }
    function set(context, value) {
        const text = String(value || '').trim();
        if (text) drafts.set(context.setting, text);
        else drafts.delete(context.setting);
    }
    async function save(context) {
        const key = context.setting;
        // A second blur/save must not duplicate a write or let an older write
        // overwrite the reference to a newer password typed during that write.
        if (pending.has(key)) {
            await pending.get(key);
            return get(context) ? save(context) : true;
        }
        const value = get(context);
        if (!value) return false; // Blank means keep the saved password.
        const task = (async () => {
            const id = await write(context.slot, value, context.label);
            if (!id) throw new Error('SillyTavern could not save the API password/key. Your entry is retained; try saving again.');
            await remember(context.setting, id);
            if (get(context) === value) drafts.delete(key);
            return true;
        })();
        pending.set(key, task);
        try { return await task; }
        finally { if (pending.get(key) === task) pending.delete(key); }
    }
    return { get, set, save };
}
