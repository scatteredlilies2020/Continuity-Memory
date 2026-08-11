let pending = null;
let sequence = 0;

export class ExtractionReviewCancelledError extends Error {
    constructor(message = 'Extraction review discarded; source messages remain pending.') {
        super(message);
        this.name = 'ExtractionReviewCancelledError';
        this.code = 'EXTRACTION_REVIEW_CANCELLED';
    }
}

function publicReview(result, meta, id) {
    return {
        id,
        from: Number(meta?.from),
        to: Number(meta?.to),
        reason: String(meta?.reason || 'extraction'),
        json: JSON.stringify(result, null, 2),
    };
}

export function getPendingExtractionReview() {
    return pending?.review || null;
}

export function requestExtractionReview({ result, meta = {}, validate = value => value, onPending = () => {}, onSettled = () => {} }) {
    if (pending) throw new Error('Another extraction is already awaiting review.');
    const id = `review-${++sequence}`;
    const review = publicReview(result, meta, id);
    return new Promise((resolve, reject) => {
        pending = { id, review, validate, resolve, reject, onSettled };
        try {
            onPending(review);
        } catch (error) {
            pending = null;
            reject(error);
        }
    });
}

export function approveExtractionReview(text, id = pending?.id) {
    if (!pending || id !== pending.id) throw new Error('This extraction review is no longer active.');
    let parsed;
    try {
        parsed = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (error) {
        throw new Error(`The edited extraction is not valid JSON: ${error.message}`);
    }
    const value = pending.validate(parsed);
    const active = pending;
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
