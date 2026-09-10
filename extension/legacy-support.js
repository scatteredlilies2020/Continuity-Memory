// Tiny fail-closed adapter for stale browser modules or integrations that still
// call the retired standalone Story actions. It never starts work or edits data.
export async function unsupportedRollingStoryAction() {
    throw Object.assign(new Error(
        'Standalone Rolling Story actions are no longer supported. '
        + 'Update Continuity Memory and reload SillyTavern if the old controls still appear. '
        + 'Use Build for Digest and Recursive Chronicle, or Rebuild every Chronicle layer to regenerate chronology from existing Digest. '
        + 'If a full chat rescan is required, export memory first, then explicitly choose Erase everything & start over. '
        + 'No saved memory was changed.',
    ), { code: 'CONTINUITY_LEGACY_STORY_UNSUPPORTED' });
}

export const LEGACY_DIGEST_RESCAN_MESSAGE = 'This older memory has no stored Digest replay data and cannot safely undo one range. '
    + 'Export memory first, then use Erase everything & start over to rescan this chat. '
    + 'Rebuild every Chronicle layer alone cannot recreate missing Digest replay data. No saved memory was changed.';

export function unsupportedStorageVersion(version) {
    return Object.assign(new Error(
        `Unsupported memory storage version: ${version ?? 'unknown'}. `
        + 'Update Continuity Memory and its server plugin, if installed, then reload SillyTavern. '
        + 'Keep the original memory files; do not erase or rescan just to open a newer storage format.',
    ), { status: 422, code: 'CONTINUITY_UPDATE_REQUIRED' });
}
