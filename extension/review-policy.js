export const DEFAULT_REVIEW_BEFORE_COMMIT = false;
export const REVIEW_DEFAULT_VERSION = 1;

export function applyReviewBeforeCommitDefault(settings) {
    if (!settings || Number(settings.reviewBeforeCommitDefaultVersion || 0) >= REVIEW_DEFAULT_VERSION) return false;
    settings.reviewBeforeCommit = DEFAULT_REVIEW_BEFORE_COMMIT;
    settings.reviewBeforeCommitDefaultVersion = REVIEW_DEFAULT_VERSION;
    return true;
}
