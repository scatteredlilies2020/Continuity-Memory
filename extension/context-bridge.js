function bridgeSourceRange(record, chatKey) {
    const sources = Array.isArray(record?.sources) ? record.sources : [];
    const source = sources.filter(item => !chatKey || !item?.chatKey || item.chatKey === chatKey)
        .sort((a, b) => Number(b?.to ?? -1) - Number(a?.to ?? -1))[0];
    if (!source) return null;
    return { chatKey: String(source.chatKey || chatKey || ''), from: Number(source.from), to: Number(source.to) };
}

function bridgeRecordText(record, category) {
    const values = category === 'threads'
        ? [record?.title, record?.detail]
        : category === 'relationships'
            ? [record?.from, record?.to, record?.kind, record?.dynamic, record?.description]
            : category === 'events'
                ? [record?.title, record?.summary, record?.description, record?.outcome]
                : category === 'backgrounds'
                    ? [record?.topic, record?.summary]
                    : [record?.name, record?.subject, record?.predicate, record?.attribute, record?.value, record?.description, record?.state, record?.location];
    return values.filter(value => value != null && String(value).trim()).map(value => String(value).trim()).join(' — ').replace(/\s+/gu, ' ').slice(0, 700);
}

export function buildPlanningEvidence(world, chatKey, coverage) {
    // Internal coverage uses latestIndex; throughMessageIndex is only the
    // published bridge-v2 field. Do not treat ordinary covered facts as future.
    const latestIndex = Number(coverage?.latestIndex ?? -1);
    const throughMessageIndex = Number.isFinite(latestIndex) ? latestIndex : -1;
    const categories = ['threads', 'facts', 'states', 'relationships', 'events', 'entities', 'backgrounds'];
    const evidence = [];
    for (const category of categories) {
        for (const record of Array.isArray(world?.[category]) ? world[category] : []) {
            const sourceRange = bridgeSourceRange(record, chatKey);
            if (sourceRange?.to != null && Number(sourceRange.to) > throughMessageIndex) continue;
            const text = bridgeRecordText(record, category);
            if (!record?.id || !text) continue;
            const canonicalStatus = String(record.status || record.truthStatus || (category === 'threads' ? 'open' : 'current')).toLowerCase();
            evidence.push({
                id: String(record.id), category, canonicalStatus,
                cmRevision: Math.max(0, Number(world?.revision) || 0),
                importance: Math.max(0, Math.min(5, Number(record.importance) || 0)), text,
                participants: Array.isArray(record.participants) ? record.participants : [record.from, record.to].filter(Boolean),
                sourceRange,
                temporalAnchor: record.temporalAnchorId || record.temporalAnchor || null,
                retrievalReason: record.correctionId
                    ? 'reviewed Continuity correction'
                    : category === 'threads' && ['open', 'pending'].includes(canonicalStatus)
                        ? 'important open canonical thread'
                        : 'current canonical record',
            });
        }
    }
    return evidence.sort((a, b) => b.importance - a.importance || Number(b.sourceRange?.to ?? -1) - Number(a.sourceRange?.to ?? -1)).slice(0, 64);
}

function fastHash(value) {
    const source = String(value ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function contextIdentity(context = {}) {
    const chatId = String(context.getCurrentChatId?.() ?? context.chatId ?? '');
    const owner = context.groupId
        ? `group:${context.groupId}`
        : `character:${context.characterId ?? 'unknown'}`;
    const messages = (Array.isArray(context.chat) ? context.chat : [])
        .map((message, index) => ({
            index,
            name: String(message?.name || ''),
            text: String(message?.mes || ''),
            user: Boolean(message?.is_user),
            system: Boolean(message?.is_system),
        }))
        .filter(message => !message.system && message.text.trim());
    return {
        chatId,
        key: chatId ? `${owner}:chat:${chatId}` : '',
        signature: fastHash(JSON.stringify([messages.length, messages.slice(-12)])),
    };
}

export function createContinuityContextBridge(readContext) {
    let revision = 0;
    const subscribers = new Set();
    let snapshot = {
        chatId: '',
        key: '',
        signature: '',
        prompt: '',
        revision: 0,
        updatedAt: 0,
        status: 'unavailable',
        coverage: { throughMessageIndex: -1, signature: '' },
        planningEvidence: [],
    };

    function cloneEvidence(items) {
        return (Array.isArray(items) ? items : []).slice(0, 64).map(item => Object.freeze({
            id: String(item?.id || '').slice(0, 160),
            cmRevision: Math.max(0, Number(item?.cmRevision ?? item?.revision) || 0),
            category: String(item?.category || 'background').slice(0, 60),
            canonicalStatus: String(item?.canonicalStatus || 'current').slice(0, 40),
            importance: Math.max(0, Math.min(5, Number(item?.importance) || 0)),
            text: String(item?.text || '').replace(/\s+/gu, ' ').trim().slice(0, 700),
            participants: Object.freeze((Array.isArray(item?.participants) ? item.participants : []).map(value => String(value).slice(0, 100)).filter(Boolean).slice(0, 12)),
            sourceRange: item?.sourceRange && typeof item.sourceRange === 'object' ? Object.freeze({
                chatKey: String(item.sourceRange.chatKey || '').slice(0, 180),
                from: Number.isFinite(Number(item.sourceRange.from)) ? Number(item.sourceRange.from) : null,
                to: Number.isFinite(Number(item.sourceRange.to)) ? Number(item.sourceRange.to) : null,
            }) : null,
            temporalAnchor: item?.temporalAnchor == null ? null : String(item.temporalAnchor).slice(0, 180),
            retrievalReason: String(item?.retrievalReason || 'current canonical record').slice(0, 180),
        })).filter(item => item.id && item.text);
    }

    function snapshotForRead(statusOverride = null) {
        const prompt = snapshot.prompt;
        const result = {
            chatId: snapshot.chatId,
            revision: snapshot.revision,
            updatedAt: snapshot.updatedAt,
            status: statusOverride || snapshot.status,
        };
        // Keep the legacy mutation probe harmless while freezing every
        // published field. Consumers can read the prompt, but cannot alter
        // the bridge's immutable snapshot or its nested evidence.
        Object.defineProperty(result, 'prompt', {
            enumerable: true,
            configurable: false,
            get: () => prompt,
            set: () => {},
        });
        const evidence = Object.freeze(snapshot.planningEvidence.map(item => Object.freeze({
                ...item,
                participants: Object.freeze([...(item.participants || [])]),
                sourceRange: item.sourceRange ? Object.freeze({ ...item.sourceRange }) : null,
            })));
        Object.defineProperties(result, {
            version: { value: 2, enumerable: true },
            coverage: { value: Object.freeze({ ...snapshot.coverage }), enumerable: true },
            planningEvidence: { value: evidence, enumerable: true },
        });
        return Object.freeze(result);
    }

    function publish(prompt = '', metadata = {}) {
        const identity = contextIdentity(readContext?.() || {});
        const planningEvidence = cloneEvidence(metadata?.planningEvidence);
        const coverage = {
            throughMessageIndex: Number.isFinite(Number(metadata?.coverage?.throughMessageIndex))
                ? Number(metadata.coverage.throughMessageIndex) : -1,
            signature: String(metadata?.coverage?.signature || identity.signature),
        };
        snapshot = {
            ...identity,
            prompt: typeof prompt === 'string' ? prompt : '',
            revision: ++revision,
            updatedAt: Date.now(),
            status: prompt || planningEvidence.length ? 'current' : 'unavailable',
            coverage,
            planningEvidence,
        };
        const published = snapshotForRead();
        for (const subscriber of [...subscribers]) {
            try { subscriber(published); } catch (error) { console.warn('[Continuity] bridge subscriber failed', error); }
        }
    }

    const bridge = Object.freeze({
        version: 2,
        getContextSnapshot() {
            const current = contextIdentity(readContext?.() || {});
            const aligned = Boolean(
                snapshot.key
                && snapshot.key === current.key
                && snapshot.signature === current.signature,
            );
            const available = Boolean(snapshot.prompt || snapshot.planningEvidence.length);
            const status = available ? (aligned ? 'current' : 'stale') : 'unavailable';
            return snapshotForRead(status);
        },
        subscribe(callback) {
            if (typeof callback !== 'function') return () => {};
            subscribers.add(callback);
            return () => subscribers.delete(callback);
        },
    });

    return { bridge, publish };
}
