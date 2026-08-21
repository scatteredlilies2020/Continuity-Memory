export function isolatedProfileOptions({ signal = null } = {}) {
    return {
        stream: false,
        extractData: false,
        includePreset: false,
        includeInstruct: false,
        signal,
    };
}

export function isolatedProfilePayload(payload = {}) {
    const { temperature: ignoredTemperature, top_p: ignoredTopP, ...compatible } = payload;
    return {
        ...compatible,
        // Profiles supply routing and model settings only. Their prompt
        // transformation must not rewrite Continuity's structured task.
        custom_prompt_post_processing: '',
    };
}

export function connectionProfileModel(profile, purpose = 'Selected') {
    const model = String(profile?.model || '').trim();
    if (model) return model;
    const name = String(profile?.name || 'Unnamed profile').trim();
    throw new Error(`${purpose} connection profile “${name}” has no model ID. Set its model in SillyTavern Connection Manager or choose a Direct option.`);
}

export function connectionProfileHasModel(profile) {
    return Boolean(String(profile?.model || '').trim());
}
