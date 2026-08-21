export const STORY_THINKING_MODES = Object.freeze(['auto', 'off', 'minimum', 'low', 'medium', 'high', 'max']);

export function normalizeStoryThinkingMode(value) {
    const mode = String(value || '').toLowerCase();
    return STORY_THINKING_MODES.includes(mode) ? mode : 'auto';
}

export function resolveStoryThinkingMode(configuredMode, profileEffort = '', activeEffort = '') {
    const configured = normalizeStoryThinkingMode(configuredMode);
    if (configured !== 'auto') return configured;
    const inherited = String(profileEffort || activeEffort || 'auto').toLowerCase();
    if (inherited === 'min') return 'minimum';
    if (['off', 'none'].includes(inherited)) return 'off';
    if (['low', 'medium', 'high', 'max'].includes(inherited)) return inherited;
    return 'default';
}

export function profileReasoningEffort(profile, presetNames, presets) {
    if (profile?.reasoning_effort) return String(profile.reasoning_effort);
    const index = profile?.preset ? presetNames?.[profile.preset] : undefined;
    return index === undefined ? '' : String(presets?.[index]?.reasoning_effort || '');
}
