let pending = null;
let sequence = 0;

export class ExtractionReviewCancelledError extends Error {
    constructor(message = 'Memory review discarded; its source records remain available.') {
        super(message);
        this.name = 'ExtractionReviewCancelledError';
        this.code = 'EXTRACTION_REVIEW_CANCELLED';
    }
}

function publicReview(result, meta, id) {
    return {
        id,
        layer: String(meta?.layer || 'L1').toUpperCase(),
        from: Number(meta?.from),
        to: Number(meta?.to),
        sourceCount: Math.max(0, Math.round(Number(meta?.sourceCount) || 0)),
        reason: String(meta?.reason || 'extraction'),
        json: JSON.stringify(result, null, 2),
    };
}

function currentReview(active) {
    const candidate = active.candidates[active.activeIndex];
    return {
        ...publicReview(candidate.result, active.meta, active.id),
        json: candidate.draft,
        originalJson: candidate.original,
        candidateIndex: active.activeIndex,
        candidateCount: active.candidates.length,
        phase: active.phase,
        revision: active.revision,
        dirty: candidate.draft !== candidate.original,
        canRegenerate: typeof active.regenerate === 'function',
    };
}

function publish(active) {
    active.revision++;
    active.review = currentReview(active);
    active.onPending(active.review);
    return active.review;
}

function requirePending(id) {
    if (!pending || id !== pending.id) throw new Error('This memory review is no longer active.');
    return pending;
}

function candidateFromResult(result) {
    const json = JSON.stringify(result, null, 2);
    return { result, original: json, draft: json };
}

export function getPendingExtractionReview() {
    return pending?.review || null;
}

export function requestExtractionReview({ result, meta = {}, validate = value => value, regenerate = null, onPending = () => {}, onSettled = () => {} }) {
    if (pending) throw new Error('Another memory result is already awaiting review.');
    const id = `review-${++sequence}`;
    return new Promise((resolve, reject) => {
        pending = {
            id,
            review: null,
            meta,
            validate,
            regenerate,
            resolve,
            reject,
            onPending,
            onSettled,
            candidates: [candidateFromResult(result)],
            activeIndex: 0,
            phase: 'review',
            revision: 0,
        };
        try {
            publish(pending);
        } catch (error) {
            pending = null;
            reject(error);
        }
    });
}

export function updateExtractionReviewDraft(text, id = pending?.id) {
    const active = requirePending(id);
    const candidate = active.candidates[active.activeIndex];
    candidate.draft = String(text ?? '');
    active.review = currentReview(active);
    return active.review;
}

export function selectExtractionReviewCandidate(index, text, id = pending?.id) {
    const active = requirePending(id);
    if (active.phase === 'regenerating') throw new Error('Wait for regeneration to finish.');
    updateExtractionReviewDraft(text, id);
    const target = Math.max(0, Math.min(active.candidates.length - 1, Math.round(Number(index) || 0)));
    active.activeIndex = target;
    return publish(active);
}

export function revertExtractionReviewDraft(id = pending?.id) {
    const active = requirePending(id);
    if (active.phase === 'regenerating') throw new Error('Wait for regeneration to finish.');
    const candidate = active.candidates[active.activeIndex];
    candidate.draft = candidate.original;
    return publish(active);
}

export async function regenerateExtractionReview(text, id = pending?.id) {
    const active = requirePending(id);
    if (active.phase === 'regenerating') throw new Error('This memory result is already being regenerated.');
    if (typeof active.regenerate !== 'function') throw new Error('This memory result cannot be regenerated.');
    updateExtractionReviewDraft(text, id);
    active.phase = 'regenerating';
    publish(active);
    try {
        const result = await active.regenerate();
        if (pending !== active) throw new Error('This memory review is no longer active.');
        active.candidates.push(candidateFromResult(result));
        active.activeIndex = active.candidates.length - 1;
        active.phase = 'review';
        return publish(active);
    } catch (error) {
        if (pending === active) {
            active.phase = 'review';
            publish(active);
        }
        throw error;
    }
}

export function approveExtractionReview(text, id = pending?.id) {
    const active = requirePending(id);
    if (active.phase === 'regenerating') throw new Error('Wait for regeneration to finish.');
    updateExtractionReviewDraft(text, id);
    let parsed;
    try {
        parsed = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (error) {
        throw new Error(`The edited memory is not valid JSON: ${error.message}`);
    }
    const value = active.validate(parsed);
    pending = null;
    active.onSettled({ approved: true, id: active.id });
    active.resolve(value);
    return value;
}

export function cancelExtractionReview(reason = undefined, id = pending?.id) {
    if (!pending || id !== pending.id) return false;
    const active = pending;
    pending = null;
    const error = reason instanceof Error ? reason : new ExtractionReviewCancelledError(reason);
    active.onSettled({ approved: false, id: active.id, error });
    active.reject(error);
    return true;
}
