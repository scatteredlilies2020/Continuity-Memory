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
