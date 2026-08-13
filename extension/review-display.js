export const DEFAULT_REVIEW_FONT_SIZE = 14;
export const MIN_REVIEW_FONT_SIZE = 11;
export const MAX_REVIEW_FONT_SIZE = 26;
export const REVIEW_FONT_STEP = 1;

export function clampReviewFontSize(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_REVIEW_FONT_SIZE;
    return Math.max(MIN_REVIEW_FONT_SIZE, Math.min(MAX_REVIEW_FONT_SIZE, Math.round(parsed)));
}

export function touchDistance(touches) {
    if (!touches || touches.length < 2) return 0;
    const x = Number(touches[0].clientX) - Number(touches[1].clientX);
    const y = Number(touches[0].clientY) - Number(touches[1].clientY);
    return Math.hypot(x, y);
}

export function pinchedReviewFontSize(startSize, startDistance, currentDistance) {
    const initialDistance = Number(startDistance);
    const nextDistance = Number(currentDistance);
    if (!(initialDistance > 0) || !(nextDistance > 0)) return clampReviewFontSize(startSize);
    return clampReviewFontSize(Number(startSize) * (nextDistance / initialDistance));
}

export function reviewGenerationProgress(state) {
    const progress = state?.progress;
    if (progress && Number.isFinite(Number(progress.from)) && Number.isFinite(Number(progress.to))) {
        const chunk = Number(progress.total) > 1
            ? ` · chunk ${Number(progress.current) || 1}/${Number(progress.total)}`
            : '';
        return {
            title: `Generating L1 for messages ${progress.from}–${progress.to}`,
            detail: `${state?.retryStatus || 'Continuity is preparing memory before the reply.'}${chunk}`,
        };
    }
    const detail = String(state?.retryStatus || state?.roleplayGate?.message || 'Continuity is preparing memory before the reply.');
    if (String(state?.status || '').includes('embedding') || detail.toLocaleLowerCase().includes('vector index')) return { title: 'Updating memory search index', detail };
    if (String(state?.arcStatus || '').includes('L3') || detail.includes('L3')) return { title: 'Generating L3 memory', detail };
    if (String(state?.arcStatus || '').includes('L2') || detail.includes('L2')) return { title: 'Generating L2 memory', detail };
    return { title: state?.roleplayGate?.stopping ? 'Stopping Continuity generation…' : 'Preparing memory before the reply', detail };
}
