export function resolveStoryRequestProfile(settings, directProfileId = '__direct__') {
    const selected = String(settings?.storyProfileId || '').trim();
    return {
        profileId: selected || String(settings?.memoryProfileId || '').trim(),
        directKind: selected === directProfileId ? 'story' : 'extraction',
    };
}
