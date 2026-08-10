import { randomUuid } from './uuid.js';
import { addressFactIdentity } from './reconciliation-policy.js';

const COLLECTIONS = Object.freeze({
    entities: ['name', 'type', 'aliases', 'description', 'importance'],
    facts: ['subject', 'predicate', 'value', 'category', 'importance', 'persistence'],
    states: ['subject', 'attribute', 'value', 'previous', 'importance', 'scope', 'operation'],
    relationships: ['from', 'to', 'kind', 'status', 'dynamic', 'importance'],
    events: ['title', 'summary', 'participants', 'location', 'storyTime', 'consequences', 'importance'],
    threads: ['title', 'detail', 'status', 'participants', 'importance'],
    backgrounds: ['topic', 'summary', 'status', 'certainty', 'participants', 'importance'],
    capsules: ['title', 'storyTime', 'location', 'participants', 'opening', 'beats', 'emotionalArc', 'closing', 'importance'],
});

export const CORRECTABLE_CATEGORIES = Object.freeze(Object.keys(COLLECTIONS));
const ID_PREFIXES = Object.freeze({ entities: 'entity', facts: 'fact', states: 'state', relationships: 'relationship', events: 'event', threads: 'thread', backgrounds: 'background', capsules: 'capsule' });

const LIST_FIELDS = new Set(['aliases', 'participants', 'beats']);
const STOP_WORDS = new Set('a an and are as at be been but by do for from had has have he her him his how i if in is it its me my not of on or our she that the their them then they this to was we were what when where which who why will with you your'.split(' '));

function text(value, max = 4000) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalized(value) {
    return text(value).toLocaleLowerCase();
}

function list(value, max = 40) {
    return [...new Set((Array.isArray(value) ? value : []).map(item => text(item, 800)).filter(Boolean))].slice(0, max);
}

function importance(value) {
    return Math.min(5, Math.max(1, Math.round(Number(value) || 3)));
}

function publicRecord(category, item) {
    const result = {};
    for (const field of COLLECTIONS[category] || []) {
        if (LIST_FIELDS.has(field)) result[field] = list(item?.[field], field === 'beats' ? 8 : 40);
        else if (field === 'importance') result[field] = importance(item?.[field]);
        else result[field] = text(item?.[field]);
    }
    if (category === 'facts' && !['temporary', 'recurring', 'persistent'].includes(result.persistence)) result.persistence = 'persistent';
    if (category === 'states') {
        if (!['scene', 'ongoing'].includes(result.scope)) result.scope = 'ongoing';
        result.operation = 'set';
    }
    if (category === 'threads' && !['open', 'resolved', 'abandoned'].includes(result.status)) result.status = 'open';
    if (category === 'backgrounds') {
        if (!['active', 'resolved', 'dormant'].includes(result.status)) result.status = 'active';
        if (!['confirmed', 'reported', 'rumored', 'uncertain'].includes(result.certainty)) result.certainty = 'uncertain';
    }
    return result;
}

function requiredIdentity(category, record) {
    if (category === 'entities') return record.name;
    if (category === 'facts') return record.subject && record.predicate;
    if (category === 'states') return record.subject && record.attribute;
    if (category === 'relationships') return record.from && record.to;
    if (category === 'events') return record.title || record.summary;
    if (category === 'threads') return record.title;
    if (category === 'backgrounds') return record.topic;
    if (category === 'capsules') return record.title || record.opening || record.closing || record.beats?.length;
    return false;
}

function terms(value) {
    return new Set((normalized(value).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [])
        .filter(term => [...term].length >= 2 && !STOP_WORDS.has(term))
        .slice(0, 200));
}

function searchable(item) {
    return normalized(Object.entries(item || {})
        .filter(([key]) => !['sources', 'createdAt', 'updatedAt'].includes(key))
        .map(([, value]) => Array.isArray(value) ? value.join(' ') : value)
        .join(' '));
}

export function selectCorrectionContext(world, instruction, { limit = 60, characterLimit = 30000 } = {}) {
    const query = terms(instruction);
    const ranked = [];
    for (const category of CORRECTABLE_CATEGORIES) {
        for (const item of world?.[category] || []) {
            const haystack = searchable(item);
            let matches = 0;
            for (const term of query) if (haystack.includes(term)) matches++;
            if (!matches) continue;
            ranked.push({
                category,
                id: String(item.id || ''),
                record: publicRecord(category, item),
                score: matches * 10 + importance(item.importance),
                updatedAt: String(item.updatedAt || item.createdAt || ''),
            });
        }
    }
    ranked.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    const selected = [];
    let used = 0;
    for (const candidate of ranked.slice(0, Math.max(1, limit))) {
        const value = JSON.stringify({ category: candidate.category, id: candidate.id, record: candidate.record });
        if (selected.length && used + value.length > characterLimit) break;
        selected.push({ category: candidate.category, id: candidate.id, record: candidate.record });
        used += value.length;
    }
    return selected;
}

function parseRecord(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value || '{}'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // Report a correction-specific validation error below.
    }
    throw new Error('The correction model returned an invalid record object.');
}

export function correctionSelector(category, item, meta = {}) {
    const record = publicRecord(category, item);
    if (category === 'entities') return normalized(record.name);
    if (category === 'facts') return addressFactIdentity(record) || `${normalized(record.subject)}|${normalized(record.predicate)}`;
    if (category === 'states') return `${normalized(record.subject)}|${normalized(record.attribute)}`;
    if (category === 'relationships') return `${normalized(record.from)}|${normalized(record.to)}|${normalized(record.kind)}`;
    if (category === 'threads') return normalized(record.title);
    if (category === 'backgrounds') return normalized(record.topic);
    if (category === 'events') return `${normalized(record.title)}|${normalized(record.summary).slice(0, 180)}`;
    if (category === 'capsules') return `${String(item?.chatKey || meta.chatKey || '')}|${Number(item?.from ?? meta.from)}|${Number(item?.to ?? meta.to)}`;
    return '';
}

export function isSuppressedByCorrection(world, category, item, meta = {}) {
    const selector = correctionSelector(category, item, meta);
    if (!selector) return false;
    return (world?.corrections || []).some(correction => (correction.operations || []).some(operation =>
        operation.category === category
        && ['delete', 'update'].includes(operation.action)
        && operation.beforeSelector === selector));
}

export function validateCorrectionProposal(world, proposal, instruction = '') {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('The correction model returned no JSON object.');
    const summary = text(proposal.summary, 1000);
    const rawOperations = Array.isArray(proposal.operations) ? proposal.operations : [];
    if (!summary) throw new Error('The correction model returned no summary.');
    if (!rawOperations.length) throw new Error('No matching stored memories were found to change. Be more specific about the people or event.');
    if (rawOperations.length > 24) throw new Error('The correction proposal is too broad. Split it into smaller corrections.');
    const operations = [];
    const seen = new Set();
    for (const raw of rawOperations) {
        const action = ['add', 'update', 'delete'].includes(raw?.action) ? raw.action : '';
        const category = CORRECTABLE_CATEGORIES.includes(raw?.category) ? raw.category : '';
        const targetId = text(raw?.targetId, 200);
        if (!action || !category) throw new Error('The correction model returned an unsupported action or category.');
        if (action === 'add' && category === 'capsules') throw new Error('Corrections may update or remove L1 records, but cannot invent a new L1 source range.');
        const target = action === 'add' ? null : (world?.[category] || []).find(item => String(item.id) === targetId);
        if (action !== 'add' && !target) throw new Error(`The correction model targeted a missing ${category} record.`);
        const dedupe = `${action}|${category}|${targetId}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        let replacement = null;
        if (action !== 'delete') {
            const candidate = parseRecord(raw.recordJson ?? raw.record);
            replacement = publicRecord(category, action === 'update' ? { ...target, ...candidate } : candidate);
            if (!requiredIdentity(category, replacement)) throw new Error(`The proposed ${category} record is missing its identifying fields.`);
        }
        operations.push({
            action,
            category,
            targetId,
            reason: text(raw.reason, 1000),
            before: target ? publicRecord(category, target) : null,
            replacement,
        });
    }
    if (!operations.length) throw new Error('The correction proposal contained no usable changes.');
    return { instruction: text(instruction, 4000), summary, operations };
}

function chronologyScore(capsule, event) {
    let score = 0;
    const capsuleParticipants = new Set(list(capsule?.participants).map(normalized));
    for (const participant of list(event?.participants).map(normalized)) if (capsuleParticipants.has(participant)) score += 12;
    const capsuleLocation = normalized(capsule?.location);
    const eventLocation = normalized(event?.location);
    if (capsuleLocation && eventLocation && (capsuleLocation.includes(eventLocation) || eventLocation.includes(capsuleLocation))) score += 10;
    const capsuleTime = terms(capsule?.storyTime);
    for (const term of terms(event?.storyTime)) if (capsuleTime.has(term)) score += 4;
    const capsuleText = searchable(capsule);
    for (const term of terms(`${event?.title || ''} ${event?.summary || ''}`)) if (capsuleText.includes(term)) score += 1;
    return score;
}

function eventCapsuleRecord(event) {
    const summary = text(event.summary || event.title, 800);
    const consequence = text(event.consequences, 800);
    return publicRecord('capsules', {
        title: event.title,
        storyTime: event.storyTime,
        location: event.location,
        participants: event.participants,
        opening: summary,
        beats: consequence ? [summary, consequence] : [summary],
        emotionalArc: '',
        closing: consequence,
        importance: event.importance,
    });
}

export function augmentCorrectionChronology(world, proposal) {
    const operations = [...proposal.operations];
    for (const operation of proposal.operations) {
        if (operation.action !== 'add' || operation.category !== 'events' || !operation.replacement) continue;
        const alreadyPlanned = operations.some(item => item.category === 'capsules'
            && searchable(item.replacement || item.before).includes(normalized(operation.replacement.title || operation.replacement.summary)));
        if (alreadyPlanned) continue;
        const ranked = (world?.capsules || [])
            .map(capsule => ({ capsule, score: chronologyScore(capsule, operation.replacement) }))
            .sort((a, b) => b.score - a.score);
        const closest = ranked[0]?.score >= 12 ? ranked[0].capsule : null;
        if (closest) {
            const replacement = publicRecord('capsules', closest);
            const eventLine = text(operation.replacement.summary || operation.replacement.title, 800);
            if (eventLine && !replacement.beats.some(beat => normalized(beat).includes(normalized(eventLine)))) {
                replacement.beats = [...replacement.beats, eventLine].slice(-8);
            }
            const consequence = text(operation.replacement.consequences, 800);
            if (consequence && !normalized(replacement.closing).includes(normalized(consequence))) {
                replacement.closing = text([replacement.closing, consequence].filter(Boolean).join(' '), 800);
            }
            operations.push({
                action: 'update', category: 'capsules', targetId: String(closest.id),
                reason: 'Propagate the authoritative event into its closest matching L1 chronology.',
                before: publicRecord('capsules', closest), replacement,
            });
        } else {
            operations.push({
                action: 'add', category: 'capsules', targetId: '',
                reason: 'Create an authoritative L1 chronology record because no matching source capsule exists.',
                before: null, replacement: eventCapsuleRecord(operation.replacement),
            });
        }
    }
    return { ...proposal, operations };
}

function ranges(item) {
    const values = [...(item?.sources || [])];
    if (item?.chatKey && Number.isFinite(Number(item.from)) && Number.isFinite(Number(item.to))) values.push(item);
    return values.filter(source => source?.chatKey && Number.isFinite(Number(source.from)) && Number.isFinite(Number(source.to)));
}

function overlaps(a, b) {
    return a.chatKey === b.chatKey && Number(a.from) <= Number(b.to) && Number(a.to) >= Number(b.from);
}

export function applyCorrectionProposal(world, proposal) {
    world.corrections ||= [];
    world.arcs ||= [];
    world.eras ||= [];
    const correctionId = `correction_${randomUuid()}`;
    const timestamp = new Date().toISOString();
    const affectedRanges = [];
    const affectedCapsuleIds = new Set();
    const addedCapsuleIds = new Set();
    const storedOperations = [];
    for (const operation of proposal.operations) {
        const collection = world[operation.category] ||= [];
        const index = operation.action === 'add' ? -1 : collection.findIndex(item => String(item.id) === operation.targetId);
        if (operation.action !== 'add' && index < 0) throw new Error(`The ${operation.category} record changed before the correction could be applied. Review it again.`);
        const before = index >= 0 ? structuredClone(collection[index]) : null;
        affectedRanges.push(...ranges(before));
        if (operation.category === 'capsules' && before?.id) affectedCapsuleIds.add(before.id);
        let after = null;
        if (operation.action === 'delete') {
            collection.splice(index, 1);
        } else {
            const correctionSource = { kind: 'correction', correctionId, capturedAt: timestamp };
            after = {
                ...(before || {}),
                ...operation.replacement,
                id: before?.id || `${ID_PREFIXES[operation.category]}_${randomUuid()}`,
                createdAt: before?.createdAt || timestamp,
                updatedAt: timestamp,
                correctedAt: timestamp,
                correctionId,
                sources: [...(before?.sources || []), correctionSource].slice(-20),
            };
            if (before?.chatKey) after.chatKey = before.chatKey;
            if (Number.isFinite(Number(before?.from))) after.from = Number(before.from);
            if (Number.isFinite(Number(before?.to))) after.to = Number(before.to);
            if (index >= 0) collection[index] = after;
            else collection.push(after);
            if (operation.category === 'capsules' && !before) {
                after.chatKey = `correction:${correctionId}`;
                addedCapsuleIds.add(after.id);
            }
            affectedRanges.push(...ranges(after));
            if (operation.category === 'capsules') affectedCapsuleIds.add(after.id);
        }
        storedOperations.push({
            action: operation.action,
            category: operation.category,
            targetId: operation.targetId,
            recordId: after?.id || before?.id || '',
            reason: operation.reason,
            beforeSelector: before ? correctionSelector(operation.category, before) : '',
            before: before ? publicRecord(operation.category, before) : null,
            after: after ? publicRecord(operation.category, after) : null,
        });
    }
    for (const capsule of world.capsules || []) {
        if (affectedRanges.some(range => ranges(capsule).some(source => overlaps(range, source)))) affectedCapsuleIds.add(capsule.id);
    }
    const invalidatedArcRecords = world.arcs
        .filter(arc => (arc.capsuleIds || []).some(id => affectedCapsuleIds.has(id)))
        .map(item => structuredClone(item));
    const removedArcIds = new Set(invalidatedArcRecords.map(arc => arc.id));
    const invalidatedEraRecords = world.eras
        .filter(era => (era.arcIds || []).some(id => removedArcIds.has(id))
            || (era.capsuleIds || []).some(id => affectedCapsuleIds.has(id)))
        .map(item => structuredClone(item));
    const oldArcCount = world.arcs.length;
    const oldEraCount = world.eras.length;
    world.arcs = world.arcs.filter(arc => !removedArcIds.has(arc.id));
    world.eras = world.eras.filter(era =>
        !(era.arcIds || []).some(id => removedArcIds.has(id))
        && !(era.capsuleIds || []).some(id => affectedCapsuleIds.has(id)));
    const correction = {
        id: correctionId,
        instruction: proposal.instruction,
        summary: proposal.summary,
        operations: storedOperations,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    world.corrections.push(correction);
    return {
        correction,
        changed: storedOperations.length,
        invalidatedArcs: oldArcCount - world.arcs.length,
        invalidatedEras: oldEraCount - world.eras.length,
        affectedCapsules: affectedCapsuleIds.size,
        invalidatedArcRecords,
        invalidatedEraRecords,
        addedCapsuleIds: [...addedCapsuleIds],
    };
}

export function formatCorrectionPreview(proposal) {
    const lines = [proposal.summary, ''];
    for (const operation of proposal.operations) {
        const label = operation.action === 'add' ? 'ADD' : operation.action === 'delete' ? 'REMOVE' : 'UPDATE';
        lines.push(`${label} ${operation.category}${operation.targetId ? ` (${operation.targetId})` : ''}`);
        if (operation.reason) lines.push(`  ${operation.reason}`);
        if (operation.before) lines.push(`  BEFORE: ${JSON.stringify(operation.before)}`);
        if (operation.replacement) lines.push(`  AFTER:  ${JSON.stringify(operation.replacement)}`);
    }
    return lines.join('\n').trim();
}
