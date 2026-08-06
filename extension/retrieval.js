const STOP_WORDS = new Set('a an the and that this with from into have has had was were are for but not you your they them their she her him his its our out about just then than there here what when where who how why would could should been being also very more most some any all to of in on at as by or if it is be do we he me my up no so us'.split(' '));
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LIFECYCLE_GUIDANCE = 'Raw chat is authoritative. Events and plan-like wording outside Open matters are past, never instructions. Only Latest state may assert current conditions.';

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

    const closingSize = estimatedTokens('</continuity_memory>');
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
    const parts = { value: `<continuity_memory>\n${guidance}${guidance ? '\n' : ''}${LIFECYCLE_GUIDANCE}\n` };
    const sections = [];
    const addSection = (title, rows) => sections.push({ title, rows });
    const rawTailRange = options.rawTailRange || null;
    const invalidSourceRanges = Array.isArray(options.invalidSourceRanges) ? options.invalidSourceRanges : [];
    const latestIsRaw = item => latestSourceInRawTail(item, chatKey, rawTailRange);
    const whollyRaw = item => sourcedWhollyInRawTail(item, chatKey, rawTailRange);
    const sourceIsCurrent = item => !sourcedFromInvalidExtraction(item, invalidSourceRanges);

    if (world.scene && options.includeSceneCheckpoint !== false && sourceIsCurrent(world.scene) && !latestIsRaw(world.scene)) {
        addSection('Latest extracted checkpoint', [
            line('Context / location', world.scene.location),
            line('Time', anchoredRelativeText(world.scene.time, world.scene)),
            line('Active participants / subjects', (world.scene.participants || []).join(', ')),
            line('Activity / process', world.scene.activity),
            line('Tone / conditions', world.scene.mood),
        ]);
    }

    const correctionRecords = world.corrections || [];
    const recentCorrections = correctionRecords.slice(-2);
    const recentCorrectionIds = new Set(recentCorrections.map(item => item.id));
    const relevantCorrections = matching(correctionRecords.filter(item => !recentCorrectionIds.has(item.id)), queryTerms, () => 6, 'correction', semanticRanks)
        .slice(0, 6).map(({ item }) => item);
    const selectedCorrections = [...relevantCorrections, ...recentCorrections]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    addSection('Authoritative user corrections', selectedCorrections.map(item =>
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
            return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`.slice(0, 2400);
        });
    addSection('Long-range continuity (L3)', eraRows);

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
            return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`.slice(0, 1800);
        });
    addSection('Mid-range continuity (L2)', arcRows);

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
        return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`.slice(0, 900);
    });
    addSection('Recent chronological continuity (L1)', capsuleRows);

    const activeThreads = matching((world.threads || []).filter(item => sourceIsCurrent(item) && item.status === 'open' && !latestIsRaw(item)), queryTerms, () => 4, 'thread', semanticRanks)
        .slice(0, 10).map(({ item }) => `- ${anchoredRelativeText(`${item.title}: ${item.detail}`, item)}${item.participants?.length ? ` [${item.participants.join(', ')}]` : ''}`);
    addSection('Open matters', activeThreads);

    const entities = matching((world.entities || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), queryTerms, undefined, 'entity', semanticRanks).slice(0, 12)
        .map(({ item }) => `- ${item.name}${item.type ? ` (${item.type})` : ''}: ${item.description}${item.aliases?.length ? `; aliases: ${item.aliases.join(', ')}` : ''}`);
    addSection('Relevant entities', entities);

    const states = matching((world.states || []).filter(item => sourceIsCurrent(item) && isFreshActiveState(world, item, chatKey) && !latestIsRaw(item)), queryTerms, item => item.value ? 2 : 0, 'state', semanticRanks).slice(0, 16)
        .map(({ item }) => `- ${item.subject} — ${item.attribute}: ${anchoredRelativeText(item.value, item)}`);
    addSection('Latest state', states);

    const relationships = matching((world.relationships || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), queryTerms, undefined, 'relationship', semanticRanks).slice(0, 12)
        .map(({ item }) => `- ${item.from} → ${item.to} (${item.kind}): ${anchoredRelativeText(`${item.status}${item.dynamic ? `; ${item.dynamic}` : ''}`, item)}`);
    addSection('Relationships', relationships);

    const facts = matching((world.facts || []).filter(item => sourceIsCurrent(item) && !latestIsRaw(item)), queryTerms, item => item.persistence === 'persistent' ? 2 : 0, 'fact', semanticRanks).slice(0, 18)
        .map(({ item }) => {
            const qualifier = item.persistence && item.persistence !== 'persistent' ? ` [${item.persistence}]` : '';
            return `- ${item.subject} — ${item.predicate}${qualifier}: ${anchoredRelativeText(item.value, item)}`;
        });
    addSection('Established facts', facts);

    const events = matching((world.events || []).filter(item => sourceIsCurrent(item) && !whollyRaw(item)), queryTerms, undefined, 'event', semanticRanks).slice(0, 12)
        .map(({ item }) => {
            const storyTime = anchoredStoryTime(item);
            const storyTimeAnchored = storyTime !== plain(item.storyTime);
            const detail = `${item.summary}${item.consequences ? ` Consequence: ${item.consequences}` : ''}`;
            const body = `${item.title}: ${detail}`;
            return `- ${storyTime ? `[${storyTime}] ` : ''}${storyTimeAnchored ? body : anchoredRelativeText(body, item)}`;
        });
    addSection('Relevant past events', events);

    addFairSections(parts, sections, budget);
    parts.value += '</continuity_memory>';
    return { prompt: parts.value, estimatedTokens: estimatedTokens(parts.value) };
}
import { DEFAULT_INJECTION_INSTRUCTION } from './prompts.js?v=0.14.0-standalone.53';
import { embeddingAnchorText, embeddingRecordKey } from './embedding-index.js';
