export const STORY_SOURCE_L1 = 'l1';
export const STORY_SOURCE_RAW = 'raw';
export const STORY_SOURCE_POLICY_VERSION = 2;

export function resolveStorySourceMode(value) {
    return value === STORY_SOURCE_RAW ? STORY_SOURCE_RAW : STORY_SOURCE_L1;
}

export function storedStorySourceMode(story) {
    return story?.sourceMode === STORY_SOURCE_L1 ? STORY_SOURCE_L1 : STORY_SOURCE_RAW;
}

export function storySourceModeLabel(mode) {
    return resolveStorySourceMode(mode) === STORY_SOURCE_RAW ? 'raw chat' : 'completed L1 summaries only';
}

export function storySourcePolicyIsCurrent(story, mode) {
    return resolveStorySourceMode(mode) === STORY_SOURCE_RAW
        || Number(story?.sourcePolicyVersion || 0) >= STORY_SOURCE_POLICY_VERSION;
}

export function formatL1StorySource(capsule) {
    return [
        capsule?.title ? `Title: ${capsule.title}` : '',
        capsule?.storyTime ? `Story time: ${capsule.storyTime}` : '',
        capsule?.location ? `Location: ${capsule.location}` : '',
        Array.isArray(capsule?.participants) && capsule.participants.length ? `Participants: ${capsule.participants.join(', ')}` : '',
        capsule?.opening ? `Opening: ${capsule.opening}` : '',
        ...(capsule?.beats || []).map(item => `Development: ${item}`),
        capsule?.emotionalArc ? `Emotional movement: ${capsule.emotionalArc}` : '',
        capsule?.closing ? `Closing: ${capsule.closing}` : '',
    ].filter(Boolean).join('\n');
}

export function buildStorySourceUnits(rawMessages, capsules, chatKey, mode, requiredL1Through = -1) {
    const raw = Array.isArray(rawMessages) ? rawMessages : [];
    if (resolveStorySourceMode(mode) === STORY_SOURCE_RAW) {
        return { units: raw, rawCount: raw.length, l1Count: 0, blockedFrom: null };
    }
    const byFrom = new Map((capsules || []).filter(item => item?.chatKey === chatKey)
        .slice().sort((left, right) => Number(left?.from ?? 0) - Number(right?.from ?? 0))
        .map(item => [Number(item.from), item]));
    const units = [];
    let l1Count = 0;
    let rawCount = 0;
    let blockedFrom = null;
    for (let cursor = 0; cursor < raw.length;) {
        const message = raw[cursor];
        const index = Number(message?.index);
        if (index <= Number(requiredL1Through)) {
            const capsule = byFrom.get(index);
            if (!capsule || Number(capsule.to) > Number(requiredL1Through)) {
                blockedFrom = index;
                break;
            }
            const covered = raw.slice(cursor).filter(item => Number(item.index) <= Number(capsule.to));
            if (!covered.length || Number(covered.at(-1)?.index) !== Number(capsule.to)) {
                blockedFrom = index;
                break;
            }
            units.push({
                index: Number(capsule.to), sourceFrom: Number(capsule.from), name: 'L1 summary',
                text: formatL1StorySource(capsule), storySourceKind: STORY_SOURCE_L1,
            });
            cursor += covered.length;
            l1Count++;
            continue;
        }
        break;
    }
    return { units, rawCount, l1Count, blockedFrom };
}
