const RELATIONS = new Set(['same-period', 'after', 'before', 'overlaps', 'detached', 'unknown']);
const CERTAINTIES = new Set(['explicit', 'implicit', 'unknown']);
const RELATIVE_QUANTITY = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)`;
const RELATIVE_UNIT = String.raw`(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|mornings?|afternoons?|evenings?|nights?)`;
const RELATIVE_TIME = new RegExp(String.raw`\b(?:right now|now|currently|today|tonight|yesterday|tomorrow|later|earlier|recently|soon|this\s+${RELATIVE_UNIT}|that\s+${RELATIVE_UNIT}|(?:last|next|previous|following|past)\s+(?:${RELATIVE_QUANTITY}\s+)?${RELATIVE_UNIT}|in\s+${RELATIVE_QUANTITY}\s+${RELATIVE_UNIT}|${RELATIVE_QUANTITY}\s+${RELATIVE_UNIT}\s+(?:ago|later|earlier)|(?:the\s+)?(?:day|night|week|month|year)\s+(?:before|after))\b`, 'iu');
const LEGACY_RELATIVE_REFERENCE = 'its recorded past source; exact anchor unavailable';

function text(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalized(value) {
    return text(value).toLocaleLowerCase();
}

function stableHash(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function digestAnchorId(meta) {
    return `Digest-${stableHash(meta?.chatKey)}-${Number(meta?.from)}-${Number(meta?.to)}`;
}

function previousInFrame(world, meta, frame) {
    return (world?.capsules || [])
        .filter(item => item?.chatKey === meta?.chatKey && Number(item?.to) < Number(meta?.from))
        .filter(item => normalized(item?.temporal?.frame) === normalized(frame))
        .sort((a, b) => Number(b.to) - Number(a.to) || Number(b.from) - Number(a.from))[0] || null;
}

export function buildDigestTemporalAnchor(world, raw, meta) {
    const frame = text(raw?.frame) || 'main narrative';
    const previous = previousInFrame(world, meta, frame);
    const requestedRelation = RELATIONS.has(raw?.relation) ? raw.relation : 'unknown';
    const certainty = CERTAINTIES.has(raw?.certainty) ? raw.certainty : 'unknown';
    return {
        anchorId: digestAnchorId(meta),
        frame,
        relation: previous ? requestedRelation : (requestedRelation === 'detached' ? 'detached' : 'unknown'),
        referenceId: previous?.temporal?.anchorId || '',
        elapsed: certainty === 'explicit' ? text(raw?.elapsed) : '',
        certainty,
    };
}

export function buildRelativeTemporalAnchor(raw, digestTemporal) {
    const certainty = CERTAINTIES.has(raw?.certainty) ? raw.certainty : 'unknown';
    return {
        frame: text(raw?.frame) || digestTemporal?.frame || 'main narrative',
        relation: RELATIONS.has(raw?.relation) ? raw.relation : 'unknown',
        referenceId: digestTemporal?.anchorId || '',
        elapsed: certainty === 'explicit' ? text(raw?.elapsed) : '',
        certainty,
    };
}

export function temporalAnchorSummary(item) {
    const temporal = item?.temporal;
    if (!temporal?.anchorId) return '';
    const parts = [`anchor ${temporal.anchorId}`, `frame ${temporal.frame || 'main narrative'}`];
    if (temporal.referenceId) parts.push(`${temporal.relation || 'unknown'} ${temporal.referenceId}`);
    if (temporal.elapsed) parts.push(`explicit interval ${temporal.elapsed}`);
    if (temporal.certainty) parts.push(`${temporal.certainty} timing`);
    return parts.join('; ');
}

export function anchoredStoryTime(item) {
    const label = text(item?.storyTime);
    const temporal = item?.temporal;
    const eventAnchor = text(item?.temporalAnchorId);
    const span = temporalSpan(item);
    const spanFrames = [...new Set((item?.temporalFrames || []).map(text).filter(Boolean))];
    const frameIsSpecial = temporal?.frame && normalized(temporal.frame) !== 'main narrative';
    const spanFramesAreSpecial = spanFrames.length > 1 || (spanFrames.length === 1 && normalized(spanFrames[0]) !== 'main narrative');
    const relationIsSpecial = temporal?.relation && !['same-period', 'after', 'unknown'].includes(temporal.relation);
    const needsAnchor = RELATIVE_TIME.test(label) || temporal?.elapsed || frameIsSpecial || spanFramesAreSpecial || relationIsSpecial;
    if (!needsAnchor) return label;
    const anchor = temporal?.anchorId || temporal?.referenceId || eventAnchor || span;
    const details = [];
    if (anchor) details.push(`relative to ${anchor}`);
    else if (RELATIVE_TIME.test(label)) details.push(`relative to ${LEGACY_RELATIVE_REFERENCE}`);
    if (frameIsSpecial) details.push(`frame ${temporal.frame}`);
    if (spanFramesAreSpecial) details.push(`frames ${spanFrames.join(', ')}`);
    if (temporal?.relation && temporal.relation !== 'unknown') details.push(temporal.relation);
    if (temporal?.elapsed) details.push(`interval ${temporal.elapsed}`);
    return [label, ...details].filter(Boolean).join('; ');
}

export function anchoredRelativeText(value, item) {
    const label = text(value);
    if (!label || !RELATIVE_TIME.test(label)) return label;
    const anchor = text(item?.temporalAnchorId || item?.temporal?.anchorId || item?.temporal?.referenceId || temporalSpan(item));
    const reference = anchor || LEGACY_RELATIVE_REFERENCE;
    return label.replace(RELATIVE_TIME, match => `${match} (relative to ${reference})`);
}

function temporalSpan(item) {
    const anchors = (item?.temporalAnchorIds || []).filter(Boolean);
    if (!anchors.length) return '';
    return anchors.length === 1 ? anchors[0] : `${anchors[0]}…${anchors.at(-1)}`;
}

export function temporalContext(world, chatKey = '', limit = 12) {
    const chronological = (world?.capsules || [])
        .filter(item => !chatKey || item?.chatKey === chatKey)
        .filter(item => item?.temporal?.anchorId)
        .slice()
        .sort((a, b) => Number(a.to) - Number(b.to) || Number(a.from) - Number(b.from));
    const latestByFrame = new Map();
    for (const item of chronological) latestByFrame.set(normalized(item.temporal.frame), item);
    const selected = [...new Set([...chronological.slice(-6), ...latestByFrame.values()])]
        .sort((a, b) => Number(a.to) - Number(b.to) || Number(a.from) - Number(b.from))
        .slice(-Math.max(1, Number(limit) || 12));
    return selected
        .map(item => ({
            anchorId: item.temporal.anchorId,
            frame: item.temporal.frame,
            relation: item.temporal.relation,
            referenceId: item.temporal.referenceId,
            elapsed: item.temporal.elapsed,
            storyTime: item.storyTime,
            title: item.title,
        }));
}
