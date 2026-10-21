import { applyCorrectionProposal } from './memory-correction.js';
import { chronicleTextFromCapsule, refreshChronicleStory } from './chronicle.js';
import { entityProfile, formatEntityProfile, PROFILE_FIELDS } from './entity-profile.js';
import { supportingHistory, supportingIdentity, supportingRecords } from './supporting-memories.js?v=0.15.0-testing.30';
import { randomUuid } from './uuid.js';

const field = (key, label, type = 'text', options) => ({ key, label, type, ...(options ? { options } : {}) });
const importance = field('importance', 'Importance', 'number');
const participants = field('participants', 'Participants', 'list');
const storyTime = field('storyTime', 'Story time');
const profileLabels = ['Role / background', 'Age / demographics', 'Appearance', 'Personality / quirks'];
const FIELDS = {
    scene: [field('location', 'Location'), field('time', 'Time'), participants, field('activity', 'Activity'), field('mood', 'Conditions / mood')],
    entities: [field('description', 'Description'), ...PROFILE_FIELDS.map((key, index) => field(`profile.${key}`, profileLabels[index], 'list')), importance],
    facts: [field('value', 'Value'), field('category', 'Category'), field('persistence', 'Persistence', 'select', ['temporary', 'recurring', 'persistent']), importance],
    states: [field('value', 'Value'), field('previous', 'Previous value'), field('scope', 'Scope', 'select', ['scene', 'ongoing']), importance],
    relationships: [field('dynamic', 'Description'), field('kind', 'Relationship'), field('status', 'Status'), importance],
    events: [field('title', 'Title'), field('summary', 'Summary'), participants, field('location', 'Location'), storyTime, field('consequences', 'Consequences'), importance],
    threads: [field('title', 'Title'), field('detail', 'Observation'), participants, importance],
    backgrounds: [field('topic', 'Topic'), field('summary', 'Observation'), field('certainty', 'Certainty', 'select', ['confirmed', 'reported', 'rumored', 'uncertain']), participants, importance],
    capsules: [field('title', 'Title'), storyTime, field('location', 'Location'), participants, field('opening', 'Opening'), field('beats', 'Key progression', 'list'), field('emotionalArc', 'Overall progression'), field('closing', 'Closing'), field('chronicleText', 'Chronicle narrative'), importance],
    chronicle: [field('title', 'Title'), storyTime, field('text', 'Narrative'), field('turningPoints', 'Turning points', 'list'), field('emotionalArc', 'Overall progression'), field('closingState', 'Closing state'), field('openThreads', 'Historical context', 'list'), participants, importance],
};
const TEMPORAL_FIELDS = [field('temporal.frame', 'Time frame'), field('temporal.relation', 'Temporal relation', 'select', ['same-period', 'after', 'before', 'overlaps', 'detached', 'unknown']), field('temporal.elapsed', 'Explicit interval'), field('temporal.certainty', 'Time certainty', 'select', ['explicit', 'implicit', 'unknown'])];

export function memoryEditTarget(category, item) {
    if (category === 'corrections') return null;
    if (category === 'scene') return { category: 'scene' };
    if (category === 'supporting') return item.recordId && FIELDS[item.collection]
        ? { category: item.collection, id: item.recordId, evidence: supportingIdentity(item) } : null;
    if (category === 'story' || category === 'chronicle') {
        if (Number(item.level) === 0) return item.capsuleIds?.length === 1
            ? { category: 'capsules', id: item.capsuleIds[0], view: 'chronicle' } : null;
        return item.id && Number(item.level) > 0 ? { category: 'chronicle', id: item.id } : null;
    }
    const collection = category === 'digest' ? 'capsules' : category;
    return item.id && FIELDS[collection] ? { category: collection, id: item.id } : null;
}

function locate(world, target) {
    if (!target || !Object.hasOwn(FIELDS, target.category)) throw new Error('This record cannot be edited.');
    if (target.view && (target.view !== 'chronicle' || target.category !== 'capsules')) throw new Error('Invalid memory view.');
    const records = target.category === 'scene' ? (world.scene ? [world.scene] : []) : (world[target.category] || []).filter(item => item.id === target.id);
    if (records.length !== 1) throw new Error('This record changed or is no longer available. Reopen it from the memory browser.');
    const record = records[0];
    let observation;
    let history;
    if (target.evidence) {
        if (!['threads', 'backgrounds'].includes(target.category)) throw new Error('Invalid observation target.');
        history = supportingHistory(...supportingRecords(world, target.category).filter(item => item.recordId === record.id), record);
        observation = history.find(item => supportingIdentity(item) === target.evidence);
        if (!observation) throw new Error('This observation changed. Reopen it from the memory browser.');
    }
    return { record, observation, history };
}

function valueAt(record, key) {
    return key.split('.').reduce((value, part) => value?.[part], record);
}

function assign(record, key, value) {
    const parts = key.split('.');
    if (parts.length === 2) {
        record[parts[0]] = { ...record[parts[0]], [parts[1]]: value };
    } else record[key] = value;
}

export function describeMemoryEdit(world, target) {
    const { record, observation } = locate(world, target);
    const source = observation ? { ...record, ...observation,
        ...(target.category === 'backgrounds' ? { topic: observation.title, summary: observation.detail } : {}) } : record;
    let fields = FIELDS[target.category];
    if (target.category === 'entities') {
        const hasProfile = Object.keys(entityProfile(record)).length > 0;
        fields = fields.filter(item => hasProfile ? item.key !== 'description' : !item.key.startsWith('profile.'));
    }
    if (target.view === 'chronicle') fields = [field('title', 'Title'), storyTime, field('chronicleText', 'Narrative')];
    if (source.temporal && !observation && target.view !== 'chronicle') fields = [...fields, ...TEMPORAL_FIELDS];
    const data = target.category === 'entities' ? { ...source, profile: entityProfile(source) } : source;
    return { target: structuredClone(target), fields: fields.map(spec => ({ ...spec,
        value: spec.key === 'chronicleText' && target.view === 'chronicle' ? chronicleTextFromCapsule(record)
            : valueAt(data, spec.key) ?? (spec.type === 'list' ? [] : spec.type === 'number' ? 3 : ''),
    })) };
}

function normalizedValue(spec, value) {
    if (spec.type === 'number') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new Error(`${spec.label} must be a whole number from 1 to 5.`);
    } else if (spec.type === 'list') {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${spec.label} must contain text items only.`);
        return value.map(item => item.trim()).filter(Boolean);
    } else {
        if (typeof value !== 'string') throw new Error(`${spec.label} must be text.`);
        if (spec.options && !spec.options.includes(value)) throw new Error(`Choose a supported ${spec.label.toLowerCase()}.`);
        return value.trim();
    }
    return value;
}

function invalidateParents(world, changedIds, capsuleIds = []) {
    const affected = new Set(changedIds);
    const capsules = new Set(capsuleIds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of world.chronicle || []) {
            if (Number(node.level) <= 0 || affected.has(node.id)) continue;
            if ((node.childIds || []).some(id => affected.has(id)) || (node.capsuleIds || []).some(id => capsules.has(id))) {
                affected.add(node.id);
                changed = true;
            }
        }
    }
    const keep = new Set(changedIds);
    world.chronicle = (world.chronicle || []).filter(node => !affected.has(node.id) || keep.has(node.id));
    for (const key of new Set((world.chronicle || []).map(node => node.chatKey))) refreshChronicleStory(world, key);
}

// Work on a copy: invalid drafts and failed saves cannot mutate the live world.
export function applyManualMemoryEdit(world, target, patch, reviewedSource = {}) {
    const description = describeMemoryEdit(world, target);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid memory edit.');
    const changes = {};
    for (const [key, value] of Object.entries(patch)) {
        const spec = description.fields.find(item => item.key === key);
        if (!spec) throw new Error('Record identity, sources, and internal fields cannot be edited.');
        const next = normalizedValue(spec, value);
        if (JSON.stringify(next) !== JSON.stringify(spec.value)) changes[key] = next;
    }
    if (!Object.keys(changes).length) return { world, changed: false };
    const nextWorld = structuredClone(world);
    const { record, observation, history } = locate(nextWorld, target);
    let replacement = structuredClone(record);
    if (target.category === 'entities' && Object.keys(changes).some(key => key.startsWith('profile.'))) {
        replacement.profile = { ...entityProfile(record), ...replacement.profile };
    }
    if (observation) {
        const updated = structuredClone(observation);
        for (const [key, value] of Object.entries(changes)) {
            assign(updated, target.category === 'backgrounds' ? ({ topic: 'title', summary: 'detail' }[key] || key) : key, value);
        }
        replacement.history = history.map(item => supportingIdentity(item) === target.evidence ? updated : item);
        if (supportingIdentity(record) === target.evidence) {
            for (const [key, value] of Object.entries(changes)) assign(replacement, key, value);
        }
    } else {
        for (const [key, value] of Object.entries(changes)) assign(replacement, key, value);
    }
    if (target.category === 'states' && !replacement.value?.trim() && replacement.operation !== 'clear') throw new Error('A state needs a value.');
    if (target.category === 'facts' && !replacement.value?.trim()) throw new Error('A fact needs a value.');
    if (target.category === 'chronicle' && !replacement.text?.trim()) throw new Error('A Chronicle entry needs a narrative.');
    if (target.category === 'events' && !replacement.title?.trim() && !replacement.summary?.trim()) throw new Error('An event needs a title or summary.');
    if (target.category === 'capsules' && !chronicleTextFromCapsule(replacement)) throw new Error('A Digest entry needs some content.');
    if (['threads', 'backgrounds'].includes(target.category)) {
        const heading = observation ? (changes.title ?? changes.topic ?? observation.title) : (replacement.title || replacement.topic);
        const detail = observation ? (changes.detail ?? changes.summary ?? observation.detail) : (replacement.detail || replacement.summary);
        if (!heading?.trim() || !detail?.trim()) throw new Error('A supporting memory needs a heading and observation.');
    }
    if (target.category === 'entities' && Object.keys(changes).some(key => key.startsWith('profile.'))) replacement.description = formatEntityProfile(replacement.profile);
    const timestamp = new Date().toISOString();
    const label = record.title || record.topic || record.name || [record.subject, record.predicate || record.attribute].filter(Boolean).join(' — ') || 'checkpoint';
    const summary = `Manual edit: ${label}. ${Object.entries(changes).map(([key, value]) => `${description.fields.find(item => item.key === key).label}: ${(Array.isArray(value) ? value.join('; ') : String(value)) || 'cleared'}`).join(' · ')}`;
    const previousParents = (nextWorld.chronicle || []).filter(item => Number(item.level) > 0).map(item => item.id);
    if (target.category === 'scene' || target.category === 'chronicle') {
        if (target.category === 'scene') nextWorld.scene = { ...replacement, updatedAt: timestamp };
        else {
            Object.assign(record, replacement, { summary: replacement.text, updatedAt: timestamp });
            invalidateParents(nextWorld, [record.id]);
        }
        (nextWorld.corrections ||= []).push({ id: `correction_${randomUuid()}`, instruction: 'Manually edited stored memory.', summary,
            operations: [], manualEdit: { category: target.category, recordId: record.id || '', before: structuredClone(target.category === 'scene' ? world.scene : world.chronicle.find(item => item.id === record.id)), after: structuredClone(target.category === 'scene' ? nextWorld.scene : record) }, createdAt: timestamp, updatedAt: timestamp });
    } else {
        const result = applyCorrectionProposal(nextWorld, { instruction: 'Manually edited stored memory.', summary, operations: [{
            action: 'update', category: target.category, targetId: record.id, replacement,
            reason: 'Manual edit in the memory browser.', preserveSupportingHistory: Boolean(observation),
            preserveChronicleText: Object.hasOwn(changes, 'chronicleText') || !['opening', 'beats', 'closing'].some(key => Object.hasOwn(changes, key)),
        }] }, reviewedSource);
        result.correction.manualEdit = { category: target.category, fields: Object.keys(changes), ...(target.evidence ? { evidence: target.evidence } : {}) };
        const ranges = [record, ...(record.sources || [])].filter(source => source.chatKey && Number.isInteger(source.from) && Number.isInteger(source.to));
        const capsules = (nextWorld.capsules || []).filter(capsule => ranges.some(source => source.chatKey === capsule.chatKey && source.from <= capsule.to && source.to >= capsule.from));
        invalidateParents(nextWorld, [], capsules.map(item => item.id));
    }
    return { world: nextWorld, changed: true, invalidatedChronicle: previousParents.filter(id => !(nextWorld.chronicle || []).some(item => item.id === id)).length };
}
