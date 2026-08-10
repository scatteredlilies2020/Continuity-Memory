const STOP_WORDS = new Set('a an the and that this with from into have has had was were are for but not you your they them their she her him his its our out about just then than there here what when where who how why would could should been being also very more most some any all to of in on at as by or if it is be do we he me my up no so us'.split(' '));
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LIFECYCLE_GUIDANCE = 'Raw chat controls. Events and plans outside Open matters are past; current conditions appear only under Current state.';

import { isFreshActiveState, latestSourceInRawTail, sourcedWhollyInRawTail } from './state-lifecycle.js';
import { anchoredRelativeText, anchoredStoryTime } from './temporal-anchors.js';

function plain(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function terms(value) {
    const source = plain(value);
    const found = new Set();
    for (const run of source.match(CJK_RUN) || []) {
        const characters = [...run.toLocaleLowerCase()];
        if (characters.length <= 4) found.add(characters.join(''));
        if (characters.length > 1) {
            for (let index = 0; index < characters.length - 1; index++) found.add(characters.slice(index, index + 2).join(''));
        }
        if (characters.length > 2) {
            for (let index = 0; index < characters.length - 2; index++) found.add(characters.slice(index, index + 3).join(''));
        }
    }
    const nonCjk = source.replace(CJK_RUN, ' ');
    for (const token of nonCjk.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []) {
        const normalized = token.toLocaleLowerCase();
        const length = [...normalized].length;
        const upperCaseIdentifier = token === token.toLocaleUpperCase() && token !== token.toLocaleLowerCase();
        if (length >= 3 && !STOP_WORDS.has(normalized)) found.add(normalized);
        else if (length === 2 && (!STOP_WORDS.has(normalized) || upperCaseIdentifier)) found.add(normalized);
        // Single Latin letters and digits produce excessive substring matches
        // (for example, the article "A" matching nearly every memory row).
    }
    return new Set([...found].slice(-512));
}

function estimatedTokens(value) {
    let ascii = 0;
    let wide = 0;
    for (const character of String(value ?? '')) {
        if (character.codePointAt(0) > 0x7f) wide++;
        else ascii++;
    }
    return Math.ceil(wide + ascii / 4);
}

function clipToTokens(value, limit) {
    const characters = [...String(value ?? '')];
    if (estimatedTokens(value) <= limit) return characters.join('');
    if (limit <= estimatedTokens('…')) return '…';
    let low = 0;
    let high = characters.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimatedTokens(`${characters.slice(0, middle).join('')}…`) <= limit) low = middle;
        else high = middle - 1;
    }
    const clipped = characters.slice(0, low).join('').trimEnd();
    return `${clipped}…`;
}

function searchable(item) {
    return plain(Object.entries(item || {})
        .filter(([key]) => !['id', 'sources', 'createdAt', 'updatedAt'].includes(key))
        .map(([, value]) => Array.isArray(value) ? value.join(' ') : value)
        .join(' '));
}

function searchableTerms(item) {
    return terms(searchable(item));
}

function recency(item) {
    const time = Date.parse(item.updatedAt || item.createdAt || 0);
    if (!Number.isFinite(time)) return 0;
    const days = Math.max(0, (Date.now() - time) / 86400000);
    return Math.max(0, 2 - Math.log10(days + 1));
}

function semanticRank(semanticRanks, category, item) {
    if (!(semanticRanks instanceof Map) || !item?.id) return 0;
    return Number(semanticRanks.get(embeddingRecordKey(category, item.id))) || 0;
}

function rank(items, queryTerms, extra = () => 0, category = '', semanticRanks = new Map()) {
    const prepared = (items || []).map((item, index) => {
        const haystack = searchableTerms(item);
        let matches = 0;
        for (const term of queryTerms) if (haystack.has(term)) matches++;
        const localScore = matches * 5 + (Number(item.importance) || 3) + recency(item) + extra(item) - index * 0.00001;
        return { item, matches, localScore, semanticRank: semanticRank(semanticRanks, category, item) };
    });
    if (!(semanticRanks instanceof Map) || !semanticRanks.size) {
        return prepared.map(result => ({ ...result, score: result.localScore })).sort((a, b) => b.score - a.score);
    }
    const localOrder = prepared.filter(result => result.matches > 0).sort((a, b) => b.localScore - a.localScore);
    const localRanks = new Map(localOrder.map((result, index) => [result.item, index + 1]));
    for (const result of prepared) {
        const lexicalRrf = result.matches > 0 ? 1 / (20 + localRanks.get(result.item)) : 0;
        const semanticRrf = result.semanticRank > 0 ? 1 / (20 + result.semanticRank) : 0;
        result.score = (lexicalRrf + semanticRrf) * 1000 + result.localScore * 0.01;
    }
    return prepared.sort((a, b) => b.score - a.score);
}

function matching(items, queryTerms, extra = () => 0, category = '', semanticRanks = new Map()) {
    return rank(items, queryTerms, extra, category, semanticRanks)
        .filter(result => result.matches > 0 || result.semanticRank > 0);
}

function line(label, value) {
    const body = plain(value);
    return body ? `- ${label}: ${body}` : '';
}

function recordSourceRanges(item) {
    const direct = item?.chatKey && Number.isFinite(Number(item.from)) && Number.isFinite(Number(item.to))
        ? [{ chatKey: item.chatKey, from: Number(item.from), to: Number(item.to) }]
        : [];
    return [...direct, ...(item?.sources || [])]
        .filter(source => source?.chatKey
            && Number.isFinite(Number(source.from))
            && Number.isFinite(Number(source.to)))
        .map(source => ({ chatKey: source.chatKey, from: Number(source.from), to: Number(source.to) }));
}

const STORY_MONTHS = new Map([
    ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
    ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
]);
const STORY_MONTH_PATTERN = [...STORY_MONTHS.keys()].join('|');

function storyTimeMinutes(value) {
    const match = String(value || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
    if (match) {
        let hour = Number(match[1]) % 12;
        if (match[3].toLocaleLowerCase() === 'pm') hour += 12;
        return hour * 60 + Number(match[2] || 0);
    }
    const periods = [['dawn', 360], ['morning', 540], ['noon', 720], ['afternoon', 900], ['evening', 1080], ['night', 1200]];
    return periods.find(([period]) => new RegExp(`\\b${period}\\b`, 'i').test(value))?.[1] || 0;
}

function storyDateKey(item) {
    // Parse only date forms Continuity already stores; ambiguous prose stays on
    // the source-order fallback instead of pretending to know its story time.
    const source = plain(item?.storyTime).toLocaleLowerCase().replace(/[—–]/g, '-');
    if (!source) return null;
    const frame = plain(item?.temporal?.frame || 'main narrative').toLocaleLowerCase();
    const minutes = storyTimeMinutes(source);
    const key = (year, month = 1, day = 1) => year * 372 * 1440 + month * 31 * 1440 + day * 1440 + minutes;
    let match = source.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[1]), Number(match[2]), Number(match[3])) };
    match = source.match(/\b(\d{1,2})([./])(\d{1,2})\2(\d{4}|xxxx)\b/i);
    if (match) {
        const dotted = match[2] === '.';
        const month = Number(match[dotted ? 3 : 1]);
        const day = Number(match[dotted ? 1 : 3]);
        if (match[4].toLocaleLowerCase() === 'xxxx') return { family: `${frame}|yearless-calendar`, value: key(0, month, day) };
        return { family: `${frame}|calendar`, value: key(Number(match[4]), month, day) };
    }
    match = source.match(new RegExp(`\\b(\\d{1,2})\\s+(${STORY_MONTH_PATTERN})\\s*-\\s*(?:early|mid|late)?\\s*(${STORY_MONTH_PATTERN})\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[4]), STORY_MONTHS.get(match[2]), Number(match[1])) };
    match = source.match(new RegExp(`\\b(\\d{1,2})(?:\\s*-\\s*\\d{1,2})?\\s+(${STORY_MONTH_PATTERN})\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[3]), STORY_MONTHS.get(match[2]), Number(match[1])) };
    match = source.match(new RegExp(`\\b(?:early|mid|late)?\\s*(${STORY_MONTH_PATTERN})\\s*-\\s*(?:early|mid|late)?\\s*(${STORY_MONTH_PATTERN})\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[3]), STORY_MONTHS.get(match[1])) };
    match = source.match(new RegExp(`\\b(${STORY_MONTH_PATTERN})(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,)?\\s+(\\d{4})\\b`, 'i'));
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[3]), STORY_MONTHS.get(match[1]), Number(match[2] || 1)) };
    match = source.match(/\b(?:rp\s*)?day\s+(\d+)\b/i);
    if (match) return { family: `${frame}|numbered-day`, value: Number(match[1]) * 1440 + minutes };
    match = source.match(/\b(spring|summer|autumn|fall|winter)\s+(\d{4})\b/i);
    if (match) {
        const seasonMonth = { spring: 3, summer: 6, autumn: 9, fall: 9, winter: 12 }[match[1]];
        return { family: `${frame}|calendar`, value: key(Number(match[2]), seasonMonth) };
    }
    match = source.match(new RegExp(`\\b(\\d{1,2})\\s+(${STORY_MONTH_PATTERN})\\b`, 'i'));
    if (match) return { family: `${frame}|yearless-calendar`, value: key(0, STORY_MONTHS.get(match[2]), Number(match[1])) };
    match = source.match(/\b(\d{4})\b/);
    if (match) return { family: `${frame}|calendar`, value: key(Number(match[1])) };
    return null;
}

function eventSourcePosition(item, chatKey) {
    const ranges = recordSourceRanges(item);
    const preferred = chatKey ? ranges.filter(source => source.chatKey === chatKey) : ranges;
    const candidates = preferred.length ? preferred : ranges;
    const first = candidates.sort((a, b) => a.from - b.from || a.to - b.to || a.chatKey.localeCompare(b.chatKey))[0];
    return first ? [first.chatKey === chatKey ? 0 : 1, first.from, first.to, first.chatKey] : [2, 0, 0, ''];
}

function addTemporalRelation(graph, subject, reference, relation) {
    if (!subject || !reference || subject === reference) return;
    const edge = (from, to) => {
        if (!graph.has(from)) graph.set(from, new Set());
        if (!graph.has(to)) graph.set(to, new Set());
        graph.get(from).add(to);
    };
    if (relation === 'after') edge(reference, subject);
    else if (relation === 'before') edge(subject, reference);
    else if (relation === 'same-period' || relation === 'overlaps') {
        edge(reference, subject);
        edge(subject, reference);
    }
}

function orderUndatedEventsByRelations(entries, capsules) {
    if (entries.length < 2) return entries;
    const graph = new Map();
    for (const capsule of capsules || []) {
        addTemporalRelation(
            graph,
            plain(capsule?.temporal?.anchorId),
            plain(capsule?.temporal?.referenceId),
            capsule?.temporal?.relation,
        );
    }
    const eventNodes = entries.map((entry, index) => `selected-event:${index}`);
    entries.forEach((entry, index) => addTemporalRelation(
        graph,
        eventNodes[index],
        plain(entry.item?.temporal?.referenceId),
        entry.item?.temporal?.relation,
    ));
    const reachable = eventNodes.map(start => {
        const found = new Set();
        const pending = [start];
        while (pending.length) {
            const current = pending.pop();
            for (const next of graph.get(current) || []) {
                if (found.has(next)) continue;
                found.add(next);
                pending.push(next);
            }
        }
        return found;
    });
    const edges = entries.map(() => new Set());
    const indegree = entries.map(() => 0);
    for (let left = 0; left < entries.length; left++) {
        for (let right = left + 1; right < entries.length; right++) {
            const leftBefore = reachable[left].has(eventNodes[right]);
            const rightBefore = reachable[right].has(eventNodes[left]);
            if (leftBefore === rightBefore) continue;
            const [from, to] = leftBefore ? [left, right] : [right, left];
            edges[from].add(to);
            indegree[to]++;
        }
    }
    const remaining = new Set(entries.map((_, index) => index));
    const result = [];
    while (remaining.size) {
        const next = [...remaining]
            .filter(index => indegree[index] === 0)
            .sort((a, b) => entries[a].sourceIndex - entries[b].sourceIndex)[0];
        if (next === undefined) return entries;
        remaining.delete(next);
        result.push(entries[next]);
        for (const target of edges[next]) indegree[target]--;
    }
    return result;
}

export function orderEventsChronologically(items, chatKey = '', capsules = []) {
    const ordered = (items || []).map((item, selectionIndex) => ({ item, selectionIndex, date: storyDateKey(item) }))
        .sort((left, right) => {
            const a = eventSourcePosition(left.item, chatKey);
            const b = eventSourcePosition(right.item, chatKey);
            return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3])
                || String(left.item.createdAt || '').localeCompare(String(right.item.createdAt || ''))
                || String(left.item.id || '').localeCompare(String(right.item.id || ''))
                || left.selectionIndex - right.selectionIndex;
        });
    ordered.forEach((entry, sourceIndex) => { entry.sourceIndex = sourceIndex; });
    // The extractor already records each event relative to its containing L1,
    // and each L1 relative to the previous anchor. Use that partial order for
    // undated events; unknown, detached, and contradictory relations retain
    // their source-message order.
    const undatedSlots = ordered.map((entry, index) => entry.date ? null : index).filter(index => index !== null);
    const temporallyOrdered = orderUndatedEventsByRelations(undatedSlots.map(index => ordered[index]), capsules);
    undatedSlots.forEach((slot, index) => { ordered[slot] = temporallyOrdered[index]; });
    // Dated records reorder only the slots occupied by comparable dated records.
    // This keeps undated events anchored to their reliable source-message order.
    const families = new Map();
    for (let index = 0; index < ordered.length; index++) {
        const date = ordered[index].date;
        if (!date) continue;
        const entries = families.get(date.family) || [];
        entries.push({ index, record: ordered[index] });
        families.set(date.family, entries);
    }
    for (const entries of families.values()) {
        const records = entries.map(entry => entry.record)
            .sort((a, b) => a.date.value - b.date.value || a.sourceIndex - b.sourceIndex);
        entries.forEach((entry, index) => { ordered[entry.index] = records[index]; });
    }
    return ordered.map(entry => entry.item);
}

function sourcedFromInvalidExtraction(item, invalidRanges) {
    // Reviewed corrections remain authoritative even when their historical
    // source range is awaiting repair.
    if (item?.correctionId || !invalidRanges.length) return false;
    return recordSourceRanges(item).some(source => invalidRanges.some(invalid =>
        source.chatKey === invalid.chatKey
        && source.from <= invalid.to
        && source.to >= invalid.from));
}

function addFairSections(parts, sections, budget) {
    const populated = sections
        .map(section => ({ ...section, rows: section.rows.filter(Boolean) }))
        .filter(section => section.rows.length > 0);
    if (!populated.length) return;

    const closingSize = estimatedTokens('</continuity>');
    const headersSize = populated.reduce((total, section) => total + estimatedTokens(`\n${section.title}:\n`), 0);
    let remaining = Math.max(0, budget - estimatedTokens(parts.value) - closingSize - headersSize);
    const selected = populated.map(() => []);

    const firstRowsSize = populated.reduce((total, section) => total + estimatedTokens(`${section.rows[0]}\n`), 0);
    if (firstRowsSize <= remaining) {
        for (let index = 0; index < populated.length; index++) {
            selected[index].push(populated[index].rows[0]);
            remaining -= estimatedTokens(`${populated[index].rows[0]}\n`);
        }
    } else {
        for (let index = 0; index < populated.length; index++) {
            const sectionsLeft = populated.length - index;
            const allowance = Math.max(1, Math.floor(remaining / sectionsLeft));
            const row = populated[index].rows[0];
            const clipped = clipToTokens(row, allowance);
            selected[index].push(clipped);
            remaining = Math.max(0, remaining - estimatedTokens(`${clipped}\n`));
        }
    }

    let rowIndex = 1;
    let added = true;
    while (remaining > 0 && added) {
        added = false;
        for (let index = 0; index < populated.length; index++) {
            const row = populated[index].rows[rowIndex];
            if (!row) continue;
            const rowSize = estimatedTokens(`${row}\n`);
            if (rowSize <= remaining) {
                selected[index].push(row);
                remaining -= rowSize;
                added = true;
            }
        }
        rowIndex++;
        if (rowIndex > Math.max(...populated.map(section => section.rows.length))) break;
    }

    for (let index = 0; index < populated.length; index++) {
        parts.value += `\n${populated[index].title}:\n${selected[index].map(row => `${row}\n`).join('')}`;
    }
}

export function buildMemoryPrompt(world, recentMessages, budgetTokens = 2500, chatKey = '', expandedTerms = [], injectionInstruction = DEFAULT_INJECTION_INSTRUCTION, semanticRanks = new Map(), options = {}) {
    if (!world) return { prompt: '', estimatedTokens: 0 };
    const semanticAnchors = embeddingAnchorText(world, semanticRanks);
    const query = `${recentMessages.map(message => `${message.name || ''} ${message.mes || ''}`).join(' ')} ${(expandedTerms || []).join(' ')} ${semanticAnchors}`;
    const queryTerms = terms(query);
    const budget = Math.max(1000, Number(budgetTokens));
    const guidance = String(injectionInstruction ?? DEFAULT_INJECTION_INSTRUCTION).trim();
    const parts = { value: `<continuity>\n${guidance}${guidance ? '\n' : ''}${LIFECYCLE_GUIDANCE}\n` };
    const sections = [];
    const seenRows = new Set();
    const addSection = (title, rows) => sections.push({
        title,
        rows: rows.filter(row => {
            const key = plain(row).toLocaleLowerCase();
            if (!key || seenRows.has(key)) return false;
            seenRows.add(key);
            return true;
        }),
    });
    const rawTailRange = options.rawTailRange || null;
    const invalidSourceRanges = Array.isArray(options.invalidSourceRanges) ? options.invalidSourceRanges : [];
    const latestIsRaw = item => latestSourceInRawTail(item, chatKey, rawTailRange);
    const whollyRaw = item => sourcedWhollyInRawTail(item, chatKey, rawTailRange);
    const sourceIsCurrent = item => !sourcedFromInvalidExtraction(item, invalidSourceRanges);

    if (world.scene && options.includeSceneCheckpoint !== false && sourceIsCurrent(world.scene) && !latestIsRaw(world.scene)) {
        addSection('Checkpoint', [
            line('Location', world.scene.location),
            line('Time', anchoredRelativeText(world.scene.time, world.scene)),
            line('Participants', (world.scene.participants || []).join(', ')),
            line('Activity', world.scene.activity),
            line('Tone', world.scene.mood),
        ]);
    }

    const correctionRecords = world.corrections || [];
    const recentCorrections = correctionRecords.slice(-2);
    const recentCorrectionIds = new Set(recentCorrections.map(item => item.id));
    const relevantCorrections = matching(correctionRecords.filter(item => !recentCorrectionIds.has(item.id)), queryTerms, () => 6, 'correction', semanticRanks)
        .slice(0, 6).map(({ item }) => item);
    const selectedCorrections = [...relevantCorrections, ...recentCorrections]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    addSection('User corrections', selectedCorrections.map(item =>
        `- ${plain(item.instruction || item.summary)}`.slice(0, 900)));

    const selectedEras = matching((world.eras || []).filter(item => sourceIsCurrent(item) && !whollyRaw(item)), queryTerms, undefined, 'era', semanticRanks).slice(0, 2);
    const eraRows = selectedEras
        .map(({ item }) => {
            const storyTime = anchoredStoryTime(item);
            const storyTimeAnchored = storyTime !== plain(item.storyTime);
            const turns = (item.turningPoints || []).map(plain).filter(Boolean).join(' → ');
            const threads = (item.openThreads || []).map(plain).filter(Boolean).join('; ');
            const continuity = `${plain(item.summary)}${turns ? ` Major turning points: ${turns}.` : ''}${plain(item.closingState) ? ` Closing state: ${plain(item.closingState)}.` : ''}${threads ? ` Still open: ${threads}.` : ''}`;
            const body = `${plain(item.title)}: ${continuity}`;
            return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`;
        });
    addSection('L3 continuity', eraRows);

    const coveredArcIds = new Set(selectedEras.flatMap(({ item }) => item.arcIds || []));
    const selectedArcs = matching((world.arcs || []).filter(item => sourceIsCurrent(item) && !coveredArcIds.has(item.id) && !whollyRaw(item)), queryTerms, undefined, 'arc', semanticRanks).slice(0, 2);
    const arcRows = selectedArcs
        .map(({ item }) => {
            const storyTime = anchoredStoryTime(item);
            const storyTimeAnchored = storyTime !== plain(item.storyTime);
            const turns = (item.turningPoints || []).map(plain).filter(Boolean).join(' → ');
            const threads = (item.openThreads || []).map(plain).filter(Boolean).join('; ');
            const continuity = `${plain(item.summary)}${turns ? ` Turning points: ${turns}.` : ''}${plain(item.closingState) ? ` Closing state: ${plain(item.closingState)}.` : ''}${threads ? ` Still open: ${threads}.` : ''}`;
            const body = `${plain(item.title)}: ${continuity}`;
            return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`;
        });
    addSection('L2 continuity', arcRows);

    const capsules = world.capsules || [];
    const chronological = capsules.filter(item => sourceIsCurrent(item) && !whollyRaw(item)).slice().sort((a, b) => {
        if (a.chatKey === b.chatKey) return Number(a.from ?? 0) - Number(b.from ?? 0);
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
    const currentChronology = chatKey ? chronological.filter(item => item.chatKey === chatKey) : chronological;
    const latest = currentChronology.slice(-3);
    const latestIds = new Set(latest.map(item => item.id));
    const coveredCapsuleIds = new Set([
        ...selectedEras.flatMap(({ item }) => item.capsuleIds || []),
        ...selectedArcs.flatMap(({ item }) => item.capsuleIds || []),
    ]);
    const relevant = matching(chronological.filter(item => !latestIds.has(item.id) && !coveredCapsuleIds.has(item.id)), queryTerms, undefined, 'capsule', semanticRanks)
        .slice(0, 2).map(({ item }) => item);
    const selectedCapsules = [...relevant, ...latest]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || Number(a.from ?? 0) - Number(b.from ?? 0));
    const capsuleRows = selectedCapsules.map(item => {
        const storyTime = anchoredStoryTime(item);
        const storyTimeAnchored = storyTime !== plain(item.storyTime);
        const sequence = [item.opening, ...(item.beats || []), item.closing].map(plain).filter(Boolean).join(' → ');
        const emotion = plain(item.emotionalArc);
        const body = `${plain(item.title)}: ${sequence}${emotion ? ` Overall movement: ${emotion}` : ''}`;
        return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`;
    });
    addSection('Recent continuity', capsuleRows);

    const activeThreads = matching((world.threads || []).filter(item => sourceIsCurrent(item) && item.status === 'open' && !latestIsRaw(item)), queryTerms, () => 4, 'thread', semanticRanks)
        .slice(0, 10).map(({ item }) => `- ${anchoredRelativeText(`${item.title}: ${item.detail}`, item)}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`);
    addSection('Open matters', activeThreads);

    const backgrounds = matching((world.backgrounds || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), queryTerms, item => item.status === 'active' ? 1 : 0, 'background', semanticRanks)
        .slice(0, 12).map(({ item }) => {
            const qualifiers = [item.status, item.certainty].map(plain).filter(Boolean).join(', ');
            return `- ${anchoredRelativeText(`${item.topic}${qualifiers ? ` [${qualifiers}]` : ''}: ${item.summary}`, item)}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`;
        });
    addSection('Background', backgrounds);

    const entities = matching((world.entities || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), queryTerms, undefined, 'entity', semanticRanks).slice(0, 12)
        .map(({ item }) => `- ${item.name}${item.type ? ` (${item.type})` : ''}: ${item.description}${item.aliases?.length ? `; aliases: ${item.aliases.join(', ')}` : ''}`);
    addSection('Entities', entities);

    const states = matching((world.states || []).filter(item => sourceIsCurrent(item) && isFreshActiveState(world, item, chatKey) && !latestIsRaw(item)), queryTerms, item => item.value ? 2 : 0, 'state', semanticRanks).slice(0, 16)
        .map(({ item }) => `- ${item.subject} — ${item.attribute}: ${anchoredRelativeText(item.value, item)}`);
    addSection('Current state', states);

    const relationships = matching((world.relationships || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), queryTerms, undefined, 'relationship', semanticRanks).slice(0, 12)
        .map(({ item }) => `- ${item.from} → ${item.to} (${item.kind}): ${anchoredRelativeText(`${item.status}${item.dynamic ? `; ${item.dynamic}` : ''}`, item)}`);
    addSection('Relationships', relationships);

    const facts = matching((world.facts || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), queryTerms, item => item.persistence === 'persistent' ? 2 : 0, 'fact', semanticRanks).slice(0, 18)
        .map(({ item }) => {
            const qualifier = item.persistence && item.persistence !== 'persistent' ? ` [${item.persistence}]` : '';
            return `- ${item.subject} — ${item.predicate}${qualifier}: ${anchoredRelativeText(item.value, item)}`;
        });
    addSection('Facts', facts);

    const selectedEvents = matching((world.events || []).filter(item => sourceIsCurrent(item) && !whollyRaw(item)), queryTerms, undefined, 'event', semanticRanks)
        .slice(0, 12).map(({ item }) => item);
    const events = orderEventsChronologically(selectedEvents, chatKey, world.capsules || [])
        .map(item => {
            const storyTime = anchoredStoryTime(item);
            const storyTimeAnchored = storyTime !== plain(item.storyTime);
            const detail = `${item.summary}${item.consequences ? ` Consequence: ${item.consequences}` : ''}`;
            const body = `${item.title}: ${detail}`;
            return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`;
        });
    addSection('Past events', events);

    addFairSections(parts, sections, budget);
    parts.value += '</continuity>';
    return { prompt: parts.value, estimatedTokens: estimatedTokens(parts.value) };
}
import { DEFAULT_INJECTION_INSTRUCTION } from './prompts.js?v=0.14.0-standalone.70';
import { embeddingAnchorText, embeddingRecordKey } from './embedding-index.js';
