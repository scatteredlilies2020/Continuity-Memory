const ACTIVE_SCOPES = new Set(['scene', 'ongoing']);
const GENERIC_NAME_TOKENS = new Set(['group', 'team', 'unit', 'party', 'squad', 'character', 'person', 'people']);

function text(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalized(value) {
    return text(value).toLocaleLowerCase();
}

function nameTokens(value) {
    return (normalized(value).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [])
        .filter(token => token.length > 1 && !GENERIC_NAME_TOKENS.has(token));
}

function namesForEntity(entity) {
    return [entity?.name, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])].map(text).filter(Boolean);
}

export function canonicalMemorySubject(world, value) {
    const source = text(value);
    if (!source) return '';
    const entities = world?.entities || [];
    const exact = entities.filter(entity => namesForEntity(entity).some(name => normalized(name) === normalized(source)));
    if (exact.length === 1) return text(exact[0].name);

    // A possessive description names something related to its owner, not the
    // owner. Keep it unresolved until an exact alias or explicit identity
    // resolution exists; fuzzy token matching would turn "Toska's master"
    // into Toska and corrupt every downstream reference.
    if (/['’]s\b/iu.test(source)) return source;

    const sourceTokens = nameTokens(source);
    if (!sourceTokens.length) return source;
    const candidates = entities.filter(entity => namesForEntity(entity).some(name => {
        const candidateTokens = nameTokens(name);
        if (!candidateTokens.length) return false;
        if (sourceTokens.length === 1) return candidateTokens.includes(sourceTokens[0]);
        return sourceTokens.every(token => candidateTokens.includes(token))
            || candidateTokens.every(token => sourceTokens.includes(token));
    }));
    return candidates.length === 1 ? text(candidates[0].name) : source;
}

export function canonicalStateAttribute(value) {
    const source = text(value);
    const key = normalized(source);
    const aliases = new Map([
        ['current location', 'location'],
        ['physical location', 'location'],
        ['whereabouts', 'location'],
        ['current activity', 'activity'],
        ['current objective', 'objective'],
        ['current plan', 'plan'],
        ['immediate plan', 'plan'],
        ['afternoon plan', 'plan'],
    ]);
    return aliases.get(key) || source;
}

export function stateIdentity(world, item) {
    return `${normalized(canonicalMemorySubject(world, item?.subject))}|${normalized(canonicalStateAttribute(item?.attribute))}`;
}

export function stateScope(value, fallback = 'scene') {
    return ACTIVE_SCOPES.has(value) ? value : fallback;
}

export function isActiveState(item) {
    return Boolean(item && ACTIVE_SCOPES.has(item.scope) && item.operation !== 'clear' && text(item.value));
}

export function isFreshActiveState(world, item, chatKey = '') {
    if (!isActiveState(item)) return false;
    const source = latestSourceRange(item, chatKey);
    if (!source) return false;
    const sourceChat = chatKey || source.chatKey;
    const latestCapsule = (world?.capsules || [])
        .filter(capsule => !sourceChat || capsule?.chatKey === sourceChat)
        .filter(capsule => Number.isFinite(Number(capsule?.from)) && Number.isFinite(Number(capsule?.to)))
        .sort((a, b) => Number(b.to) - Number(a.to) || Number(b.from) - Number(a.from))[0];
    if (!latestCapsule) return true;
    return source.to >= Number(latestCapsule.from);
}

function sourceRanges(item, chatKey = '') {
    const direct = item?.chatKey && Number.isFinite(Number(item.from)) && Number.isFinite(Number(item.to))
        ? [{ chatKey: item.chatKey, from: Number(item.from), to: Number(item.to) }]
        : [];
    return [...direct, ...(item?.sources || [])]
        .filter(source => (!chatKey || source?.chatKey === chatKey)
            && Number.isFinite(Number(source?.from)) && Number.isFinite(Number(source?.to)))
        .map(source => ({ chatKey: source.chatKey, from: Number(source.from), to: Number(source.to) }));
}

export function latestSourceRange(item, chatKey = '') {
    return sourceRanges(item, chatKey).sort((a, b) => b.to - a.to || b.from - a.from)[0] || null;
}

export function sourcedWhollyInRawTail(item, chatKey, rawTailRange) {
    if (!rawTailRange || !Number.isFinite(rawTailRange.from) || !Number.isFinite(rawTailRange.to)) return false;
    const sources = sourceRanges(item, chatKey);
    return Boolean(sources.length && sources.every(source => source.from >= rawTailRange.from && source.to <= rawTailRange.to));
}

export function latestSourceInRawTail(item, chatKey, rawTailRange) {
    if (!rawTailRange || !Number.isFinite(rawTailRange.from) || !Number.isFinite(rawTailRange.to)) return false;
    const source = latestSourceRange(item, chatKey);
    return Boolean(source && source.from >= rawTailRange.from && source.to <= rawTailRange.to);
}
