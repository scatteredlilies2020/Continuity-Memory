import { formatEntityProfile } from './entity-profile.js';
import { activeChronicleNodes } from './chronicle.js';

export const MEMORY_VIEW_CATEGORIES = Object.freeze([
    { key: 'scene', label: 'Latest extracted checkpoint' },
    { key: 'story', label: 'Recursive Chronicle' },
    { key: 'entities', label: 'Entities' },
    { key: 'facts', label: 'Facts' },
    { key: 'states', label: 'States' },
    { key: 'relationships', label: 'Relationships' },
    { key: 'events', label: 'Events' },
    { key: 'threads', label: 'Open threads' },
    { key: 'backgrounds', label: 'Background developments' },
    { key: 'corrections', label: 'Corrections' },
    { key: 'digest', label: 'Digest' },
    { key: 'chronicle', label: 'Chronicle' },
]);

function text(value) {
    return String(value ?? '').trim();
}

function list(value) {
    return (Array.isArray(value) ? value : []).map(text).filter(Boolean);
}

function add(fields, label, value) {
    const normalized = Array.isArray(value) ? list(value).join('\n• ') : text(value);
    if (normalized) fields.push({ label, value: Array.isArray(value) ? `• ${normalized}` : normalized });
}

function rangeLabel(source) {
    const from = Number(source?.from);
    const to = Number(source?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return '';
    return from === to ? `Message ${from}` : `Messages ${from}–${to}`;
}

function sourceLabels(item) {
    const direct = rangeLabel(item);
    const fromSources = [...new Set(list((item?.sources || []).map(rangeLabel)).filter(value => value !== direct))];
    return direct ? [direct, ...fromSources.slice(-3)] : fromSources.slice(-4);
}

function addTemporal(fields, item) {
    const temporal = item?.temporal;
    add(fields, 'Temporal anchor', temporal?.anchorId || temporal?.referenceId || item?.temporalAnchorId);
    add(fields, 'Time frame', temporal?.frame || (item?.temporalFrames || []).join(', '));
    add(fields, 'Temporal relation', temporal?.relation);
    add(fields, 'Explicit interval', temporal?.elapsed);
    const anchors = item?.temporalAnchorIds || [];
    if (anchors.length > 1) add(fields, 'Anchor span', `${anchors[0]} … ${anchors.at(-1)}`);
}

function categoryItems(world, category, chatKey = '') {
    if (!world) return [];
    if (category === 'scene') return world.scene ? [world.scene] : [];
    if (category === 'story') {
        const keys = [...new Set([world.continuation?.inheritedChatKey, chatKey].filter(Boolean))];
        const chronicle = keys.flatMap(key => activeChronicleNodes(world, key));
        if (chronicle.length) return chronicle;
        const story = world.storySoFar?.[chatKey];
        return story && (story.text || story.rebuildIncomplete || story.rebuildRestartPending) ? [story] : [];
    }
    if (category === 'digest') return world.capsules || [];
    if (category === 'chronicle') return world.chronicle || [];
    return Array.isArray(world[category]) ? world[category] : [];
}

function entry(category, item, index) {
    const fields = [];
    let title = item.title || item.name || `${MEMORY_VIEW_CATEGORIES.find(value => value.key === category)?.label || 'Memory'} ${index + 1}`;
    if (category === 'scene') {
        const latestSource = Math.max(-1, ...(item.sources || []).map(source => Number(source?.to)).filter(Number.isFinite));
        title = `Latest extracted checkpoint${latestSource >= 0 ? ` (through message ${latestSource})` : ''}`;
        add(fields, 'Context / location', item.location);
        add(fields, 'Time', item.time);
        add(fields, 'Active participants / subjects', item.participants);
        add(fields, 'Activity / process', item.activity);
        add(fields, 'Tone / conditions', item.mood);
        addTemporal(fields, item);
    } else if (category === 'story') {
        if (Number.isFinite(Number(item.level))) {
            const level = Number(item.level) || 0;
            title = `C${level} · ${item.title || 'Chronicle entry'}`;
            add(fields, 'Layer', `C${level}`);
            add(fields, 'Covered chat range', rangeLabel(item));
            add(fields, 'Story time', item.storyTime);
            add(fields, 'Narrative', item.text || item.summary);
            add(fields, 'Turning points', item.turningPoints);
            add(fields, 'Overall progression', item.emotionalArc);
            add(fields, 'Closing state', item.closingState);
            add(fields, 'Still open', item.openThreads);
            add(fields, 'Direct source nodes', item.childIds);
            add(fields, 'Canonical Digest sources', item.capsuleIds);
        } else {
        const coveredRange = item.rebuildRestartPending ? '' : rangeLabel(item);
        const through = Number(item.to);
        const hasBoundary = Number.isFinite(through) && through >= 0 && !item.rebuildRestartPending;
        title = `Legacy story snapshot${item.rebuildRestartPending ? ' (rebuild pending)' : hasBoundary ? ` (through message ${through})` : ''}`;
        add(fields, 'Covered chat range', coveredRange);
        add(fields, 'Stored through', hasBoundary ? `Message ${through}` : '');
        add(fields, 'Build state', item.rebuildRestartPending
            ? 'Rebuild pending; Build / Continue restarts from the first eligible message'
            : item.rebuildIncomplete ? `Interrupted; Build / Continue resumes after message ${through}` : 'Complete at its stored boundary');
        if (item.rebuildIncomplete) add(fields, 'Rebuild target', `Message ${item.rebuildTargetTo}`);
        const checkpoints = Array.isArray(item.checkpoints) ? item.checkpoints : [];
        const newestCheckpoint = Number(checkpoints.at(-1)?.to);
        add(fields, 'Recovery checkpoints', checkpoints.length
            ? `${checkpoints.length}; newest through message ${newestCheckpoint}`
            : 'None yet; an affected legacy or early range rebuilds from the beginning');
        add(fields, 'Narrative', item.text);
        add(fields, 'Source', item.sourceMode === 'digest' ? 'Completed Digest summaries only' : 'Raw chat');
        add(fields, 'Last updated', item.updatedAt);
        }
    } else if (category === 'entities') {
        add(fields, 'Type', item.type);
        add(fields, 'Aliases', item.aliases);
        add(fields, 'Description', formatEntityProfile(item) || item.description);
    } else if (category === 'facts') {
        title = [item.subject, item.predicate].filter(Boolean).join(' — ') || title;
        add(fields, 'Value', item.value);
        add(fields, 'Category', item.category);
        add(fields, 'Persistence', item.persistence);
        addTemporal(fields, item);
    } else if (category === 'states') {
        title = [item.subject, item.attribute].filter(Boolean).join(' — ') || title;
        add(fields, 'Current value', item.value);
        add(fields, 'Previous value', item.previous);
        add(fields, 'Lifecycle', item.scope);
        addTemporal(fields, item);
    } else if (category === 'relationships') {
        title = [item.from, item.to].filter(Boolean).join(' ↔ ') || title;
        add(fields, 'Description', item.dynamic);
        add(fields, 'Type', item.kind);
        add(fields, 'Status', item.status);
        addTemporal(fields, item);
    } else if (category === 'events') {
        add(fields, 'Summary', item.summary);
        add(fields, 'Participants', item.participants);
        add(fields, 'Location', item.location);
        add(fields, 'Story time', item.storyTime);
        add(fields, 'Consequences', item.consequences);
        addTemporal(fields, item);
    } else if (category === 'threads') {
        add(fields, 'Status', item.status);
        add(fields, 'Details', item.detail);
        add(fields, 'Participants', item.participants);
        addTemporal(fields, item);
    } else if (category === 'backgrounds') {
        title = item.topic || title;
        add(fields, 'Summary', item.summary);
        add(fields, 'Status', item.status);
        add(fields, 'Certainty', item.certainty);
        add(fields, 'Participants / subjects', item.participants);
        addTemporal(fields, item);
    } else if (category === 'corrections') {
        title = item.summary || 'Memory correction';
        add(fields, 'Instruction', item.instruction);
        add(fields, 'Changes', (item.operations || []).map(operation => `${operation.action} ${operation.category}${operation.reason ? `: ${operation.reason}` : ''}`));
    } else if (category === 'digest') {
        add(fields, 'Story time', item.storyTime);
        add(fields, 'Location', item.location);
        add(fields, 'Participants', item.participants);
        add(fields, 'Opening', item.opening);
        add(fields, 'Key progression', item.beats);
        add(fields, 'Overall progression', item.emotionalArc);
        add(fields, 'Closing', item.closing);
        addTemporal(fields, item);
    } else {
        add(fields, 'Story time', item.storyTime);
        add(fields, 'Participants', item.participants);
        add(fields, 'Summary', item.summary);
        add(fields, 'Turning points', item.turningPoints);
        add(fields, 'Overall progression', item.emotionalArc);
        add(fields, 'Closing state', item.closingState);
        add(fields, 'Still open', item.openThreads);
        addTemporal(fields, item);
    }
    const sources = sourceLabels(item);
    const importance = Number(item.importance);
    return {
        id: item.id || `${category}-${index}`,
        title: text(title),
        fields,
        sources,
        importance: Number.isFinite(importance) ? importance : null,
        from: Number.isFinite(Number(item.from)) ? Number(item.from) : Number(item.sources?.[0]?.from),
        search: JSON.stringify(item).toLocaleLowerCase(),
    };
}

export function memoryViewerPage(world, category = 'digest', query = '', page = 0, pageSize = 30, chatKey = '') {
    const known = MEMORY_VIEW_CATEGORIES.some(item => item.key === category) ? category : 'digest';
    const chronological = ['story', 'digest', 'chronicle', 'events'].includes(known);
    let entries = categoryItems(world, known, chatKey).map((item, index) => entry(known, item, index));
    entries.sort((a, b) => chronological
        ? (Number.isFinite(a.from) ? a.from : Number.MAX_SAFE_INTEGER) - (Number.isFinite(b.from) ? b.from : Number.MAX_SAFE_INTEGER)
        : (b.importance || 0) - (a.importance || 0));
    const needle = text(query).toLocaleLowerCase();
    if (needle) entries = entries.filter(item => item.search.includes(needle));
    const size = Math.max(1, Math.min(100, Number(pageSize) || 30));
    const pages = Math.max(1, Math.ceil(entries.length / size));
    const currentPage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
    return {
        category: known,
        total: entries.length,
        page: currentPage,
        pages,
        items: entries.slice(currentPage * size, (currentPage + 1) * size),
    };
}
