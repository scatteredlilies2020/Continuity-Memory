export const STORY_SOURCE_DIGEST = 'digest';
export const STORY_SOURCE_RAW = 'raw';
export const STORY_SOURCE_POLICY_VERSION = 3;
export const STORY_FORMAT_MERGED_DIGEST = 'merged-digest';
export const STORY_FORMAT_MANUAL = 'manual-rolling';
const LEGACY_STORY_SOURCE_PRE_DIGEST = 'l1';
const LEGACY_STORY_FORMAT_PRE_DIGEST = 'merged-l1';

export function resolveStorySourceMode(value) {
    // Story is now derived from completed Digest extraction. Keep this resolver
    // for legacy callers, but do not allow hidden settings to restore raw-chat mode.
    return STORY_SOURCE_DIGEST;
}

export function storedStorySourceMode(story) {
    return story?.sourceMode === STORY_SOURCE_DIGEST || story?.sourceMode === LEGACY_STORY_SOURCE_PRE_DIGEST
        ? STORY_SOURCE_DIGEST
        : STORY_SOURCE_RAW;
}

export function storySourceModeLabel(mode) {
    return resolveStorySourceMode(mode) === STORY_SOURCE_RAW ? 'raw chat' : 'completed Digest summaries only';
}

export function storySourcePolicyIsCurrent(story, mode) {
    return resolveStorySourceMode(mode) === STORY_SOURCE_RAW
        || Number(story?.sourcePolicyVersion || 0) >= STORY_SOURCE_POLICY_VERSION;
}

export function isCurrentStorySnapshot(story) {
    if (!story || typeof story !== 'object') return false;
    const format = story.storyFormat;
    if (format !== STORY_FORMAT_MERGED_DIGEST && format !== LEGACY_STORY_FORMAT_PRE_DIGEST && format !== STORY_FORMAT_MANUAL) return false;
    return Number(story.sourcePolicyVersion || 0) >= STORY_SOURCE_POLICY_VERSION;
}

export function isMergedDigestStorySnapshot(story) {
    return isCurrentStorySnapshot(story)
        && (story.storyFormat === STORY_FORMAT_MERGED_DIGEST || story.storyFormat === LEGACY_STORY_FORMAT_PRE_DIGEST)
        && (story.sourceMode === STORY_SOURCE_DIGEST || story.sourceMode === LEGACY_STORY_SOURCE_PRE_DIGEST);
}

// Obsolete independently-built Story snapshots must not survive the merged Digest migration.
export function discardLegacyStorySnapshots(world) {
    if (!world || typeof world !== 'object') return 0;
    world.storySoFar ||= {};
    let removed = 0;
    for (const [chatKey, story] of Object.entries(world.storySoFar)) {
        if (!isCurrentStorySnapshot(story)) {
            delete world.storySoFar[chatKey];
            removed++;
            continue;
        }
        if (story.sourceMode === LEGACY_STORY_SOURCE_PRE_DIGEST) story.sourceMode = STORY_SOURCE_DIGEST;
        if (story.storyFormat === LEGACY_STORY_FORMAT_PRE_DIGEST) story.storyFormat = STORY_FORMAT_MERGED_DIGEST;
    }
    if (removed) Object.defineProperty(world, '__legacyStorySnapshotsRemoved', {
        value: removed,
        enumerable: false,
        configurable: true,
        writable: true,
    });
    return removed;
}

export function formatDigestStorySource(capsule) {
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

export function buildStorySourceUnits(rawMessages, capsules, chatKey, mode, requiredDigestThrough = -1) {
    const raw = Array.isArray(rawMessages) ? rawMessages : [];
    if (resolveStorySourceMode(mode) === STORY_SOURCE_RAW) {
        return { units: raw, rawCount: raw.length, digestCount: 0, blockedFrom: null };
    }
    const byFrom = new Map((capsules || []).filter(item => item?.chatKey === chatKey)
        .slice().sort((left, right) => Number(left?.from ?? 0) - Number(right?.from ?? 0))
        .map(item => [Number(item.from), item]));
    const units = [];
    let digestCount = 0;
    let rawCount = 0;
    let blockedFrom = null;
    for (let cursor = 0; cursor < raw.length;) {
        const message = raw[cursor];
        const index = Number(message?.index);
        if (index <= Number(requiredDigestThrough)) {
            const capsule = byFrom.get(index);
            if (!capsule || Number(capsule.to) > Number(requiredDigestThrough)) {
                blockedFrom = index;
                break;
            }
            const covered = raw.slice(cursor).filter(item => Number(item.index) <= Number(capsule.to));
            if (!covered.length || Number(covered.at(-1)?.index) !== Number(capsule.to)) {
                blockedFrom = index;
                break;
            }
            units.push({
                index: Number(capsule.to), sourceFrom: Number(capsule.from), name: 'Digest summary',
                text: formatDigestStorySource(capsule), storySourceKind: STORY_SOURCE_DIGEST,
            });
            cursor += covered.length;
            digestCount++;
            continue;
        }
        break;
    }
    return { units, rawCount, digestCount, blockedFrom };
}
