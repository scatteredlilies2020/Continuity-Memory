import { EXTRACTION_VERSION } from './coverage.js';
import { isSuppressedByCorrection } from './memory-correction.js';
import { randomUuid } from './uuid.js';

function text(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clipped(value, max) {
    const result = text(value);
    return result.length <= max ? result : `${result.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function key(value) {
    return text(value).toLocaleLowerCase();
}

function id(prefix) {
    return `${prefix}_${randomUuid()}`;
}

function sourceRef(meta) {
    return {
        chatKey: meta.chatKey,
        from: meta.from,
        to: meta.to,
        capturedAt: new Date().toISOString(),
    };
}

function common(item, meta, prefix) {
    return {
        ...item,
        id: item.id || id(prefix),
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: [...(Array.isArray(item.sources) ? item.sources : []), sourceRef(meta)].slice(-20),
    };
}

function mergeArray(world, collection, target, incoming, identity, meta, prefix, combine, preserveExisting = false) {
    for (const raw of incoming || []) {
        if (!raw || typeof raw !== 'object') continue;
        const normalized = combine ? combine(raw) : raw;
        if (isSuppressedByCorrection(world, collection, normalized, meta)) continue;
        const identityKey = identity(normalized);
        if (!identityKey) continue;
        const index = target.findIndex(item => identity(item) === identityKey);
        if (index >= 0) {
            const merged = preserveExisting || target[index].correctionId
                ? { ...normalized, ...target[index] }
                : { ...target[index], ...normalized };
            target[index] = common({ ...merged, id: target[index].id, createdAt: target[index].createdAt }, meta, prefix);
        } else {
            target.push(common(normalized, meta, prefix));
        }
    }
}

function cleanList(value, max = 30) {
    return [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))].slice(0, max);
}

export function mergeExtraction(world, result, meta) {
    world.entities ||= [];
    world.facts ||= [];
    world.states ||= [];
    world.relationships ||= [];
    world.events ||= [];
    world.capsules ||= [];
    world.arcs ||= [];
    world.eras ||= [];
    world.extractions ||= [];
    world.threads ||= [];
    world.corrections ||= [];
    world.sources ||= {};

    if (meta.allowStateUpdates !== false && result.scene && typeof result.scene === 'object') {
        world.scene = common({
            ...(world.scene || {}),
            location: text(result.scene.location),
            time: text(result.scene.time),
            participants: cleanList(result.scene.participants),
            activity: text(result.scene.activity),
            mood: text(result.scene.mood),
        }, meta, 'scene');
    }

    const preserveCurrent = meta.allowStateUpdates === false;

    mergeArray(world, 'entities', world.entities, result.entities, item => key(item.name), meta, 'entity', item => ({
        name: text(item.name),
        type: text(item.type) || 'entity',
        aliases: cleanList(item.aliases),
        description: text(item.description),
        importance: clampImportance(item.importance),
    }), preserveCurrent);

    mergeArray(world, 'facts', world.facts, result.facts, item => `${key(item.subject)}|${key(item.predicate)}`, meta, 'fact', item => ({
        subject: text(item.subject),
        predicate: text(item.predicate),
        value: text(item.value),
        category: text(item.category),
        importance: clampImportance(item.importance),
        persistence: ['temporary', 'recurring', 'persistent'].includes(item.persistence) ? item.persistence : 'persistent',
    }), preserveCurrent);

    if (meta.allowStateUpdates !== false) {
        mergeArray(world, 'states', world.states, result.states, item => `${key(item.subject)}|${key(item.attribute)}`, meta, 'state', item => ({
            subject: text(item.subject),
            attribute: text(item.attribute),
            value: text(item.value),
            previous: text(item.previous),
            importance: clampImportance(item.importance),
        }));
    }

    mergeArray(world, 'relationships', world.relationships, result.relationships, item => `${key(item.from)}|${key(item.to)}|${key(item.kind)}`, meta, 'relationship', item => ({
        from: text(item.from),
        to: text(item.to),
        kind: text(item.kind) || 'relationship',
        status: text(item.status),
        dynamic: text(item.dynamic),
        importance: clampImportance(item.importance),
    }), preserveCurrent);

    // Events are immutable history. Deduplicate only the same event extracted from overlapping ranges.
    for (const raw of result.events || []) {
        const event = {
            title: text(raw.title),
            summary: text(raw.summary),
            participants: cleanList(raw.participants),
            location: text(raw.location),
            storyTime: text(raw.storyTime),
            consequences: text(raw.consequences),
            importance: clampImportance(raw.importance),
        };
        if (!event.title && !event.summary) continue;
        if (isSuppressedByCorrection(world, 'events', event, meta)) continue;
        const signature = `${key(event.title)}|${key(event.summary).slice(0, 160)}`;
        const duplicate = world.events.some(existing => {
            const sameContent = `${key(existing.title)}|${key(existing.summary).slice(0, 160)}` === signature;
            const overlappingSource = (existing.sources || []).some(source => source.chatKey === meta.chatKey
                && Number(source.from) <= Number(meta.to)
                && Number(source.to) >= Number(meta.from));
            return sameContent && overlappingSource;
        });
        if (!duplicate) world.events.push(common(event, meta, 'event'));
    }

    mergeArray(world, 'threads', world.threads, result.threads, item => key(item.title), meta, 'thread', item => ({
        title: text(item.title),
        detail: text(item.detail),
        status: ['open', 'resolved', 'abandoned'].includes(item.status) ? item.status : 'open',
        participants: cleanList(item.participants),
        importance: clampImportance(item.importance),
    }), preserveCurrent);

    if (result.sceneCapsule && typeof result.sceneCapsule === 'object') {
        const raw = result.sceneCapsule;
        const capsule = {
            title: clipped(raw.title, 100) || `Messages ${meta.from}–${meta.to}`,
            storyTime: clipped(raw.storyTime, 120),
            location: clipped(raw.location, 160),
            participants: cleanList(raw.participants),
            opening: clipped(raw.opening, 320),
            beats: cleanList(raw.beats, 10).map(item => clipped(item, 400)),
            emotionalArc: clipped(raw.emotionalArc, 320),
            closing: clipped(raw.closing, 320),
            importance: clampImportance(raw.importance),
            chatKey: meta.chatKey,
            from: meta.from,
            to: meta.to,
        };
        if ((capsule.opening || capsule.beats.length || capsule.closing) && !isSuppressedByCorrection(world, 'capsules', capsule, meta)) {
            const index = world.capsules.findIndex(item => item.chatKey === meta.chatKey && Number(item.from) === Number(meta.from) && Number(item.to) === Number(meta.to));
            if (index >= 0) {
                if (!world.capsules[index].correctionId) {
                    const replacedId = world.capsules[index].id;
                    const removedArcIds = new Set(world.arcs.filter(arc => (arc.capsuleIds || []).includes(replacedId)).map(arc => arc.id));
                    world.arcs = world.arcs.filter(arc => !removedArcIds.has(arc.id));
                    world.eras = world.eras.filter(era => !(era.arcIds || []).some(arcId => removedArcIds.has(arcId)));
                    world.capsules[index] = common({ ...world.capsules[index], ...capsule, id: world.capsules[index].id, createdAt: world.capsules[index].createdAt }, meta, 'capsule');
                }
            } else {
                world.capsules.push(common(capsule, meta, 'capsule'));
            }
        }
    }

    const extractionRecord = {
        id: world.extractions.find(item => item.chatKey === meta.chatKey && Number(item.from) === Number(meta.from) && Number(item.to) === Number(meta.to))?.id || id('extraction'),
        chatKey: meta.chatKey,
        from: meta.from,
        to: meta.to,
        allowStateUpdates: meta.allowStateUpdates !== false,
        result: structuredClone(result),
        messageFingerprints: structuredClone(meta.messageFingerprints || []),
        updatedAt: new Date().toISOString(),
    };
    const extractionIndex = world.extractions.findIndex(item => item.chatKey === meta.chatKey && Number(item.from) === Number(meta.from) && Number(item.to) === Number(meta.to));
    if (extractionIndex >= 0) {
        extractionRecord.createdAt = world.extractions[extractionIndex].createdAt || extractionRecord.updatedAt;
        world.extractions[extractionIndex] = extractionRecord;
    } else {
        extractionRecord.createdAt = extractionRecord.updatedAt;
        world.extractions.push(extractionRecord);
    }

    const existingSource = world.sources[meta.chatKey] || {};
    const processedByIndex = new Map((existingSource.processedMessages || []).map(item => [Number(item.index), item]));
    for (const item of meta.messageFingerprints || []) {
        processedByIndex.set(Number(item.index), { index: Number(item.index), fingerprint: String(item.fingerprint), version: EXTRACTION_VERSION });
    }
    world.sources[meta.chatKey] = {
        ...existingSource,
        lastProcessedIndex: Math.max(meta.to, world.sources[meta.chatKey]?.lastProcessedIndex ?? -1),
        lastProcessedAt: new Date().toISOString(),
        processedMessages: [...processedByIndex.values()].sort((a, b) => a.index - b.index).slice(-100000),
    };

    return world;
}

function sameRange(source, meta) {
    return source?.chatKey === meta.chatKey && Number(source.from) === Number(meta.from) && Number(source.to) === Number(meta.to);
}

export function replaceExtraction(world, result, meta) {
    world.extractions ||= [];
    world.arcs ||= [];
    world.eras ||= [];
    const removedCapsuleIds = new Set((world.capsules || []).filter(item => sameRange(item, meta)).map(item => item.id));
    const removedArcIds = new Set(world.arcs.filter(arc => (arc.capsuleIds || []).some(id => removedCapsuleIds.has(id))).map(arc => arc.id));
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'threads']) {
        world[category] = (world[category] || []).flatMap(item => {
            const sources = (item.sources || []).filter(source => !sameRange(source, meta));
            return sources.length ? [{ ...item, sources }] : [];
        });
    }
    world.capsules = (world.capsules || []).filter(item => !sameRange(item, meta));
    world.arcs = world.arcs.filter(arc => !(arc.capsuleIds || []).some(id => removedCapsuleIds.has(id)));
    world.eras = world.eras.filter(era => !(era.arcIds || []).some(id => removedArcIds.has(id)));
    world.extractions = world.extractions.filter(item => !sameRange(item, meta));
    if (world.scene?.sources?.some(source => sameRange(source, meta))) {
        const sources = world.scene.sources.filter(source => !sameRange(source, meta));
        world.scene = sources.length ? { ...world.scene, sources } : null;
    }
    return mergeExtraction(world, result, meta);
}

export function removeChatContributions(world, chatKey) {
    const removedCapsuleIds = new Set((world.capsules || []).filter(item => item.chatKey === chatKey).map(item => item.id));
    const removedArcIds = new Set((world.arcs || []).filter(arc => arc.chatKey === chatKey || (arc.capsuleIds || []).some(id => removedCapsuleIds.has(id))).map(arc => arc.id));
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'threads']) {
        world[category] = (world[category] || []).flatMap(item => {
            const sources = (item.sources || []).filter(source => source.chatKey !== chatKey);
            return sources.length ? [{ ...item, sources }] : [];
        });
    }
    world.capsules = (world.capsules || []).filter(item => item.chatKey !== chatKey);
    world.arcs = (world.arcs || []).filter(arc => arc.chatKey !== chatKey && !(arc.capsuleIds || []).some(id => removedCapsuleIds.has(id)));
    world.eras = (world.eras || []).filter(era => !(era.arcIds || []).some(id => removedArcIds.has(id)));
    world.extractions = (world.extractions || []).filter(item => item.chatKey !== chatKey);
    if (world.scene?.sources?.some(source => source.chatKey === chatKey)) {
        const sources = world.scene.sources.filter(source => source.chatKey !== chatKey);
        world.scene = sources.length ? { ...world.scene, sources } : null;
    }
    if (world.sources) delete world.sources[chatKey];
    return world;
}

function replayIdentity(collection, item, chatKey) {
    if (collection === 'entities') return key(item.name);
    if (collection === 'facts') return `${key(item.subject)}|${key(item.predicate)}`;
    if (collection === 'states') return `${key(item.subject)}|${key(item.attribute)}`;
    if (collection === 'relationships') return `${key(item.from)}|${key(item.to)}|${key(item.kind)}`;
    if (collection === 'threads') return key(item.title);
    if (collection === 'capsules' || collection === 'extractions') {
        return item.chatKey === chatKey ? `${item.chatKey}|${Number(item.from)}|${Number(item.to)}` : '';
    }
    if (collection === 'events') {
        const ranges = (item.sources || [])
            .filter(source => source.chatKey === chatKey)
            .map(source => `${Number(source.from)}:${Number(source.to)}`)
            .sort()
            .join(',');
        return ranges ? `${key(item.title)}|${key(item.summary)}|${ranges}` : '';
    }
    return '';
}

export function restoreRetainedReplayRecords(world, previousWorld, chatKey) {
    for (const collection of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'capsules', 'extractions']) {
        const previousByIdentity = new Map();
        for (const item of previousWorld?.[collection] || []) {
            const identity = replayIdentity(collection, item, chatKey);
            if (identity) previousByIdentity.set(identity, item);
        }
        for (const item of world?.[collection] || []) {
            const identity = replayIdentity(collection, item, chatKey);
            const previous = identity ? previousByIdentity.get(identity) : null;
            if (!previous?.id) continue;
            item.id = previous.id;
            if (previous.createdAt) item.createdAt = previous.createdAt;
        }
    }

    if (world.scene && previousWorld?.scene?.id) {
        world.scene.id = previousWorld.scene.id;
        if (previousWorld.scene.createdAt) world.scene.createdAt = previousWorld.scene.createdAt;
    }

    const capsuleIds = new Set((world.capsules || []).map(item => item.id));
    const retainedArcs = (previousWorld?.arcs || []).filter(arc => {
        const sourceIds = arc.capsuleIds || [];
        return sourceIds.length && sourceIds.every(id => capsuleIds.has(id));
    });
    const arcIds = new Set((world.arcs || []).map(item => item.id));
    for (const arc of retainedArcs) {
        if (arcIds.has(arc.id)) continue;
        world.arcs.push(structuredClone(arc));
        arcIds.add(arc.id);
    }

    const retainedEras = (previousWorld?.eras || []).filter(era => {
        const sourceIds = era.arcIds || [];
        return sourceIds.length && sourceIds.every(id => arcIds.has(id));
    });
    const eraIds = new Set((world.eras || []).map(item => item.id));
    for (const era of retainedEras) {
        if (eraIds.has(era.id)) continue;
        world.eras.push(structuredClone(era));
        eraIds.add(era.id);
    }
    return world;
}

export function resetWorldMemory(world) {
    world.scene = null;
    for (const category of ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'corrections']) {
        world[category] = [];
    }
    world.sources = {};
    return world;
}

export function resetWorldHierarchy(world) {
    world.arcs = [];
    world.eras = [];
    return world;
}

export function addDerivedArc(world, result, capsules) {
    world.arcs ||= [];
    const capsuleIds = (capsules || []).map(item => item.id).filter(Boolean);
    if (!capsuleIds.length) throw new Error('Cannot create L2 without source L1 records.');
    const signature = capsuleIds.join('|');
    const duplicate = world.arcs.find(item => (item.capsuleIds || []).join('|') === signature);
    if (duplicate) return duplicate;
    const sources = [];
    const seenSources = new Set();
    for (const capsule of capsules) {
        for (const source of capsule.sources || []) {
            const sourceKey = `${source.chatKey}|${source.from}|${source.to}`;
            if (seenSources.has(sourceKey)) continue;
            seenSources.add(sourceKey);
            sources.push(source);
        }
    }
    const rangeStarts = capsules.map(item => Number(item.from)).filter(Number.isFinite);
    const rangeEnds = capsules.map(item => Number(item.to)).filter(Number.isFinite);
    const arc = {
        id: id('arc'),
        title: clipped(result.title, 140) || `L2 covering ${capsules.length} L1 records`,
        storyTime: clipped(result.storyTime, 180),
        participants: cleanList(result.participants, 30),
        summary: clipped(result.summary, 1800),
        turningPoints: cleanList(result.turningPoints, 8).map(item => clipped(item, 320)),
        emotionalArc: clipped(result.emotionalArc, 400),
        closingState: clipped(result.closingState, 500),
        openThreads: cleanList(result.openThreads, 12).map(item => clipped(item, 260)),
        importance: clampImportance(result.importance),
        capsuleIds,
        chatKey: capsules[0]?.chatKey || '',
        ...(rangeStarts.length && rangeEnds.length ? { from: Math.min(...rangeStarts), to: Math.max(...rangeEnds) } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: sources.slice(-50),
    };
    world.arcs.push(arc);
    return arc;
}

export function addDerivedEra(world, result, arcs) {
    world.eras ||= [];
    const arcIds = (arcs || []).map(item => item.id).filter(Boolean);
    if (!arcIds.length) throw new Error('Cannot create L3 without source L2 records.');
    const signature = arcIds.join('|');
    const duplicate = world.eras.find(item => (item.arcIds || []).join('|') === signature);
    if (duplicate) return duplicate;
    const capsuleIds = [...new Set(arcs.flatMap(arc => arc.capsuleIds || []))];
    const sources = [];
    const seenSources = new Set();
    for (const arc of arcs) {
        for (const source of arc.sources || []) {
            const sourceKey = `${source.chatKey}|${source.from}|${source.to}`;
            if (seenSources.has(sourceKey)) continue;
            seenSources.add(sourceKey);
            sources.push(source);
        }
    }
    const rangeStarts = arcs.map(item => Number(item.from)).filter(Number.isFinite);
    const rangeEnds = arcs.map(item => Number(item.to)).filter(Number.isFinite);
    const era = {
        id: id('era'),
        title: clipped(result.title, 160) || `L3 covering ${arcs.length} L2 records`,
        storyTime: clipped(result.storyTime, 220),
        participants: cleanList(result.participants, 40),
        summary: clipped(result.summary, 2600),
        turningPoints: cleanList(result.turningPoints, 12).map(item => clipped(item, 400)),
        emotionalArc: clipped(result.emotionalArc, 600),
        closingState: clipped(result.closingState, 700),
        openThreads: cleanList(result.openThreads, 16).map(item => clipped(item, 320)),
        importance: clampImportance(result.importance),
        arcIds,
        capsuleIds,
        chatKey: arcs[0]?.chatKey || '',
        ...(rangeStarts.length && rangeEnds.length ? { from: Math.min(...rangeStarts), to: Math.max(...rangeEnds) } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: sources.slice(-100),
    };
    world.eras.push(era);
    return era;
}

function clampImportance(value) {
    return Math.min(5, Math.max(1, Math.round(Number(value) || 3)));
}

export function worldCounts(world) {
    if (!world) return {};
    const counts = Object.fromEntries(['entities', 'facts', 'states', 'relationships', 'events', 'threads']
        .map(name => [name, world[name]?.length || 0]));
    counts.L1 = world.capsules?.length || 0;
    counts.L2 = world.arcs?.length || 0;
    counts.L3 = world.eras?.length || 0;
    counts['L1 source ranges'] = world.extractions?.length || 0;
    counts.corrections = world.corrections?.length || 0;
    return counts;
}
