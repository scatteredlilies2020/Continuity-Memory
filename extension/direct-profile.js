export const DIRECT_PROFILE_ID = '__direct__';
export const DIRECT_CUSTOM_CHOICE = '__direct_custom__';
export const DIRECT_OPENROUTER_CHOICE = '__direct_openrouter__';

export function directProfileChoice(profileId, provider = 'custom') {
    if (String(profileId || '').trim() !== DIRECT_PROFILE_ID) return String(profileId || '').trim();
    return provider === 'openrouter' ? DIRECT_OPENROUTER_CHOICE : DIRECT_CUSTOM_CHOICE;
}

export function parseProfileChoice(value) {
    const selected = String(value || '').trim();
    if (selected === DIRECT_CUSTOM_CHOICE) return { profileId: DIRECT_PROFILE_ID, provider: 'custom' };
    if (selected === DIRECT_OPENROUTER_CHOICE) return { profileId: DIRECT_PROFILE_ID, provider: 'openrouter' };
    return { profileId: selected, provider: null };
}

export function isDirectProfile(profileId) {
    return String(profileId || '').trim() === DIRECT_PROFILE_ID;
}
