import { randomUuid } from './uuid.js';

export const CHRONICLE_VERSION = 1;
export const DEFAULT_CHRONICLE_CAPACITY = 24;
export const DEFAULT_CHRONICLE_FAN_IN = 10;

function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clipped(value, maximum) {
    const result = clean(value);
    if (result.length <= maximum) return result;
    const cut = result.slice(0, maximum + 1);
    const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return (boundary >= Math.floor(maximum * 0.6) ? cut.slice(0, boundary + 1) : cut.slice(0, maximum)).trim();
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

function clippedTokens(value, maximum) {
    const source = clean(value);
    const limit = Math.max(0, Math.floor(Number(maximum) || 0));
    if (!source || !limit) return '';
    if (estimatedTokens(source) <= limit) return source;
    let output = '';
    for (const character of source) {
        if (estimatedTokens(output + character) > limit) break;
        output += character;
    }
    const boundary = Math.max(output.lastIndexOf('. '), output.lastIndexOf('! '), output.lastIndexOf('? '), output.lastIndexOf('; '));
    return (boundary >= Math.floor(output.length * 0.6) ? output.slice(0, boundary + 1) : output).trim();
}

function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function ordered(records) {
    return records.slice().sort((a, b) => Number(a.from ?? 0) - Number(b.from ?? 0)
        || Number(a.to ?? 0) - Number(b.to ?? 0)
        || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        || String(a.id || '').localeCompare(String(b.id || '')));
}

export function chronicleTextFromCapsule(capsule) {
    if (!capsule) return '';
    const supplied = clean(capsule.chronicleText);
    if (supplied) return supplied;
    const body = unique([
        clean(capsule.opening),
        ...(capsule.beats || []).map(clean),
        clean(capsule.closing),
    ]).join(' ');
    const title = clean(capsule.title);
    const storyTime = clean(capsule.storyTime);
    const heading = [title, storyTime].filter(Boolean).join(' — ');
    return [heading, body].filter(Boolean).join(': ');
}

function nodeFromCapsule(capsule) {
    return {
        id: `chronicle_${capsule.id}`,
        version: CHRONICLE_VERSION,
        chatKey: capsule.chatKey || '',
        level: 0,
        title: clean(capsule.title) || 'Chronicle entry',
        storyTime: clean(capsule.storyTime),
        text: chronicleTextFromCapsule(capsule),
        from: Number(capsule.from),
        to: Number(capsule.to),
        capsuleIds: [capsule.id],
        childIds: [],
        provenanceBoundaries: structuredClone(capsule.provenanceBoundaries || []),
        temporalAnchorIds: unique([capsule.temporal?.anchorId]),
        createdAt: capsule.createdAt || new Date().toISOString(),
        updatedAt: capsule.updatedAt || new Date().toISOString(),
    };
}

function dependentNodeIds(nodes, sourceIds) {
    const affected = new Set(sourceIds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of nodes) {
            if (affected.has(node.id) || !(node.childIds || []).some(id => affected.has(id))) continue;
            affected.add(node.id);
            changed = true;
        }
    }
    return affected;
}

export function syncChronicleBase(world, chatKey = '') {
    world.chronicle ||= [];
    const capsules = (world.capsules || []).filter(item => !chatKey || item.chatKey === chatKey);
    const capsuleIds = new Set(capsules.map(item => item.id));
    const chats = new Set(capsules.map(item => item.chatKey || ''));
    if (chatKey) chats.add(chatKey);
    const changedIds = new Set();

    for (const node of world.chronicle) {
        if (node.level !== 0 || (!chatKey || node.chatKey === chatKey)) {
            const capsuleId = node.capsuleIds?.[0];
            if (node.level === 0 && capsuleId && !capsuleIds.has(capsuleId)) changedIds.add(node.id);
        }
    }

    for (const capsule of capsules) {
        const incoming = nodeFromCapsule(capsule);
        const index = world.chronicle.findIndex(item => item.id === incoming.id);
        if (index < 0) {
            world.chronicle.push(incoming);
            continue;
        }
        const prior = world.chronicle[index];
        if (prior.text !== incoming.text || Number(prior.from) !== incoming.from || Number(prior.to) !== incoming.to || prior.chatKey !== incoming.chatKey
            || JSON.stringify(prior.provenanceBoundaries || []) !== JSON.stringify(incoming.provenanceBoundaries || [])) {
            changedIds.add(prior.id);
            world.chronicle[index] = { ...incoming, createdAt: prior.createdAt || incoming.createdAt };
        }
    }

    if (changedIds.size) {
        const affected = dependentNodeIds(world.chronicle, changedIds);
        world.chronicle = world.chronicle.filter(node => {
            if (!affected.has(node.id)) return true;
            if (node.level > 0) return false;
            return capsuleIds.has(node.capsuleIds?.[0]);
        });
    }

    for (const key of chats) refreshChronicleStory(world, key);
    return world;
}

export function activeChronicleNodes(world, chatKey) {
    const nodes = (world?.chronicle || []).filter(item => item.chatKey === chatKey);
    const covered = new Set(nodes.flatMap(item => item.childIds || []));
    return ordered(nodes.filter(item => !covered.has(item.id)));
}

export function nextChroniclePromotion(world, settings = {}) {
    const capacity = Math.max(8, Math.min(100, Math.round(Number(settings.chronicleLayerCapacity) || DEFAULT_CHRONICLE_CAPACITY)));
    const fanIn = Math.max(3, Math.min(capacity, Math.round(Number(settings.chroniclePromotionSize) || DEFAULT_CHRONICLE_FAN_IN)));
    const chatKeys = unique((world?.chronicle || []).map(item => item.chatKey)).sort();
    for (const chatKey of chatKeys) {
        const frontier = activeChronicleNodes(world, chatKey);
        const levels = [...new Set(frontier.map(item => Number(item.level) || 0))].sort((a, b) => a - b);
        for (const level of levels) {
            const sameLevel = frontier.filter(item => Number(item.level) === level);
            if (sameLevel.length <= capacity) continue;
            return sameLevel.slice(0, fanIn);
        }
    }
    return null;
}

export function addChroniclePromotion(world, result, children) {
    world.chronicle ||= [];
    const childIds = (children || []).map(item => item.id).filter(Boolean);
    if (childIds.length < 2) throw new Error('Cannot promote Chronicle history without at least two source nodes.');
    const signature = childIds.join('|');
    const duplicate = world.chronicle.find(item => (item.childIds || []).join('|') === signature);
    if (duplicate) return duplicate;
    const levels = children.map(item => Number(item.level) || 0);
    if (new Set(levels).size !== 1) throw new Error('Chronicle promotion sources must come from one layer.');
    const starts = children.map(item => Number(item.from)).filter(Number.isFinite);
    const ends = children.map(item => Number(item.to)).filter(Number.isFinite);
    const summary = clean(result.summary || result.text);
    if (!summary) throw new Error('Chronicle promotion returned no summary.');
    const now = new Date().toISOString();
    const node = {
        id: `chronicle_${randomUuid()}`,
        version: CHRONICLE_VERSION,
        chatKey: children[0].chatKey || '',
        level: levels[0] + 1,
        title: clipped(result.title, 160) || `Chronicle C${levels[0] + 1}`,
        storyTime: clipped(result.storyTime, 160),
        text: clipped(summary, 3000),
        summary: clipped(summary, 3000),
        turningPoints: (result.turningPoints || []).map(item => clipped(item, 420)).filter(Boolean).slice(0, 10),
        emotionalArc: clipped(result.emotionalArc, 600),
        closingState: clipped(result.closingState, 800),
        openThreads: (result.openThreads || []).map(item => clipped(item, 420)).filter(Boolean).slice(0, 10),
        importance: Math.max(1, Math.min(5, Number(result.importance) || 3)),
        participants: unique((result.participants || []).map(clean)),
        childIds,
        capsuleIds: unique(children.flatMap(item => item.capsuleIds || [])),
        provenanceBoundaries: children.flatMap(item => structuredClone(item.provenanceBoundaries || [])),
        temporalAnchorIds: unique(children.flatMap(item => item.temporalAnchorIds || [])),
        ...(starts.length && ends.length ? { from: Math.min(...starts), to: Math.max(...ends) } : {}),
        createdAt: now,
        updatedAt: now,
    };
    world.chronicle.push(node);
    refreshChronicleStory(world, node.chatKey);
    return node;
}

export function renderChronicleFrontier(world, chatKey, include = () => true, maximumTokens = Infinity) {
    const nodes = activeChronicleNodes(world, chatKey).filter(include);
    if (!nodes.length) return '';
    const full = nodes.map(node => {
        const label = `C${Number(node.level) || 0}`;
        const heading = [clean(node.title), clean(node.storyTime)].filter(Boolean).join(' — ');
        const body = clean(node.text || node.summary);
        const details = [
            ...(node.turningPoints || []),
            clean(node.emotionalArc),
            clean(node.closingState),
            ...(node.openThreads || []).map(item => `Open: ${clean(item)}`),
        ].map(clean).filter(Boolean);
        return `[${label}] ${[heading, body, ...details].filter(Boolean).join('\n')}`;
    }).join('\n\n');
    const limit = Number(maximumTokens);
    if (!Number.isFinite(limit) || estimatedTokens(full) <= limit) return full;

    // The configured Story allowance is additive to structured recall. When a
    // large frontier exceeds it, retain a visible row for every chronological
    // span and distribute the remaining allowance across their narratives.
    const tokenLimit = Math.max(1, Math.floor(limit));
    const rows = nodes.map(node => {
        const from = Number(node.from);
        const to = Number(node.to);
        const range = Number.isFinite(from) && Number.isFinite(to) ? ` ${from}${from === to ? '' : `–${to}`}` : '';
        const prefix = `[C${Number(node.level) || 0}${range}]`;
        const payload = [
            [clean(node.title), clean(node.storyTime)].filter(Boolean).join(' — '),
            clean(node.text || node.summary),
            ...(node.openThreads || []).map(item => `Open: ${clean(item)}`),
        ].filter(Boolean).join(' ');
        return { prefix, payload };
    });
    const separators = Math.max(0, rows.length - 1) * estimatedTokens('\n');
    const fixed = rows.reduce((sum, row) => sum + estimatedTokens(row.prefix), separators);
    let remaining = Math.max(0, tokenLimit - fixed);
    return rows.map((row, index) => {
        const rowsLeft = rows.length - index;
        const share = Math.floor(remaining / rowsLeft);
        const payload = clippedTokens(row.payload, share);
        remaining -= estimatedTokens(payload);
        return payload ? `${row.prefix} ${payload}` : row.prefix;
    }).join('\n');
}

export function refreshChronicleStory(world, chatKey) {
    world.storySoFar ||= {};
    const text = renderChronicleFrontier(world, chatKey);
    if (!text) {
        delete world.storySoFar[chatKey];
        return null;
    }
    const nodes = activeChronicleNodes(world, chatKey);
    const starts = nodes.map(item => Number(item.from)).filter(Number.isFinite);
    const ends = nodes.map(item => Number(item.to)).filter(Number.isFinite);
    const snapshot = {
        text,
        from: starts.length ? Math.min(...starts) : 0,
        to: ends.length ? Math.max(...ends) : -1,
        updatedAt: new Date().toISOString(),
        sourceMode: 'chronicle',
        sourcePolicyVersion: CHRONICLE_VERSION,
        storyFormat: 'recursive-chronicle-frontier',
        rebuiltFromRawChat: false,
        nodeIds: nodes.map(item => item.id),
    };
    world.storySoFar[chatKey] = snapshot;
    return snapshot;
}

export function removeChronicleChat(world, chatKey) {
    world.chronicle = (world.chronicle || []).filter(item => item.chatKey !== chatKey);
    if (world.storySoFar) delete world.storySoFar[chatKey];
    return world;
}
