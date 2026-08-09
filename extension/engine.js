import { extractMessageFromData, generateRaw, getRequestHeaders } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { getTokenCountAsync } from '/scripts/tokenizers.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { api } from './api.js';
import { analyzeBranchDivergence, analyzeCoverage, analyzeTailRollback, EXTRACTION_VERSION } from './coverage.js';
import { isRateLimitError } from './errors.js';
import { collectFingerprintMessages, collectMemoryEligibleMessages, findChangedExtractions, fingerprintMessage } from './fingerprint.js?v=0.14.0-standalone.59';
import { resolveExtractionChunk } from './extraction-budget.js';
import { nextArcCapsules } from './hierarchy-policy.js';
import { completeL1Messages, resolveL1GroupSize, selectAutomaticL1Messages } from './l1-policy.js';
import { applyCorrectionProposal, augmentCorrectionChronology, selectCorrectionContext, validateCorrectionProposal } from './memory-correction.js';
import { resolveCorrectionResponseTokens } from './correction-policy.js';
import { addDerivedArc, addDerivedEra, mergeExtraction, removeChatContributions, replaceExtraction, resetWorldHierarchy, resetWorldMemory, restoreRetainedReplayRecords } from './memory-model.js';
import { memoryResponseTokens } from './memory-response-policy.js';
import { outputTokenPayload } from './model-compatibility.js?v=0.14.0-standalone.59';
import { embedWorldInChat } from './portable.js';
import { isolatedProfileOptions, isolatedProfilePayload } from './profile-request-policy.js?v=0.14.0-standalone.59';
import { buildExtractionSystemPrompt, buildHierarchySystemPrompt, DEFAULT_ARC_SYSTEM_PROMPT, DEFAULT_ARC_TASK_TEMPLATE, DEFAULT_ERA_SYSTEM_PROMPT, DEFAULT_ERA_TASK_TEMPLATE, DEFAULT_EXTRACTION_SYSTEM_PROMPT, DEFAULT_EXTRACTION_TASK_TEMPLATE, renderPromptTemplate } from './prompts.js?v=0.14.0-standalone.59';
import { sanitizeReconciliationMetadata } from './reconciliation-policy.js';
import { getBoundWorldId, getChatKey, getSettings } from './settings.js?v=0.14.0-standalone.59';
import { buildThinkingRequest, isThinkingControlError, shouldSendStructuredSchema } from './thinking-policy.js?v=0.14.0-standalone.59';
import { runtime, updateRuntime } from './runtime.js?v=0.14.0-standalone.59';
import { isActiveState, latestSourceRange } from './state-lifecycle.js';
import { temporalContext } from './temporal-anchors.js';

const temporalRelationSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['frame', 'relation', 'elapsed', 'certainty'],
    properties: {
        frame: { type: 'string' },
        relation: { type: 'string', enum: ['same-period', 'after', 'before', 'overlaps', 'detached', 'unknown'] },
        elapsed: { type: 'string' },
        certainty: { type: 'string', enum: ['explicit', 'implicit', 'unknown'] },
    },
};

const extractionSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['scene', 'sceneCapsule', 'entities', 'identityResolutions', 'recordMerges', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds'],
    properties: {
        scene: {
            type: 'object', additionalProperties: false,
            required: ['location', 'time', 'participants', 'activity', 'mood'],
            properties: {
                location: { type: 'string' }, time: { type: 'string' }, participants: { type: 'array', items: { type: 'string' } },
                activity: { type: 'string' }, mood: { type: 'string' },
            },
        },
        sceneCapsule: {
            type: 'object', additionalProperties: false,
            required: ['title', 'storyTime', 'location', 'participants', 'opening', 'beats', 'emotionalArc', 'closing', 'importance', 'temporal'],
            properties: {
                title: { type: 'string' }, storyTime: { type: 'string' }, location: { type: 'string' },
                participants: { type: 'array', items: { type: 'string' } }, opening: { type: 'string' },
                beats: { type: 'array', items: { type: 'string' }, maxItems: 10 },
                emotionalArc: { type: 'string' }, closing: { type: 'string' },
                importance: { type: 'integer', minimum: 1, maximum: 5 },
                temporal: temporalRelationSchema,
            },
        },
        entities: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'name', 'type', 'aliases', 'description', 'importance'],
                properties: {
                    targetId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } },
                    description: { type: 'string' }, importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
        identityResolutions: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['reference', 'canonical', 'evidence'],
                properties: {
                    reference: { type: 'string' }, canonical: { type: 'string' }, evidence: { type: 'string' },
                },
            },
        },
        recordMerges: {
            type: 'array', maxItems: 20, items: {
                type: 'object', additionalProperties: false,
                required: ['category', 'canonicalId', 'duplicateIds', 'evidence'],
                properties: {
                    category: { type: 'string', enum: ['facts', 'states', 'relationships', 'threads', 'backgrounds'] },
                    canonicalId: { type: 'string' },
                    duplicateIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
                    evidence: { type: 'string' },
                },
            },
        },
        facts: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'subject', 'predicate', 'value', 'category', 'importance', 'persistence'],
                properties: {
                    targetId: { type: 'string' }, subject: { type: 'string' }, predicate: { type: 'string' }, value: { type: 'string' }, category: { type: 'string' },
                    importance: { type: 'integer', minimum: 1, maximum: 5 }, persistence: { type: 'string', enum: ['temporary', 'recurring', 'persistent'] },
                },
            },
        },
        states: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'subject', 'attribute', 'value', 'previous', 'importance', 'scope', 'operation'],
                properties: {
                    targetId: { type: 'string' }, subject: { type: 'string' }, attribute: { type: 'string' }, value: { type: 'string' }, previous: { type: 'string' },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
                    scope: { type: 'string', enum: ['scene', 'ongoing'] },
                    operation: { type: 'string', enum: ['set', 'clear'] },
                },
            },
        },
        relationships: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'from', 'to', 'kind', 'status', 'dynamic', 'importance'],
                properties: {
                    targetId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' },
                    dynamic: { type: 'string' }, importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
        events: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['title', 'summary', 'participants', 'location', 'storyTime', 'consequences', 'importance', 'temporal'],
                properties: {
                    title: { type: 'string' }, summary: { type: 'string' }, participants: { type: 'array', items: { type: 'string' } },
                    location: { type: 'string' }, storyTime: { type: 'string' }, consequences: { type: 'string' },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
                    temporal: temporalRelationSchema,
                },
            },
        },
        threads: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'title', 'detail', 'status', 'participants', 'importance'],
                properties: {
                    targetId: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, status: { type: 'string', enum: ['open', 'resolved', 'abandoned'] },
                    participants: { type: 'array', items: { type: 'string' } }, importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
        backgrounds: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'topic', 'summary', 'status', 'certainty', 'participants', 'importance'],
                properties: {
                    targetId: { type: 'string' }, topic: { type: 'string' }, summary: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'resolved', 'dormant'] },
                    certainty: { type: 'string', enum: ['confirmed', 'reported', 'rumored', 'uncertain'] },
                    participants: { type: 'array', items: { type: 'string' } },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
    },
};

const extractionJsonSchema = Object.freeze({
    name: 'continuity_memory_extraction',
    description: 'Structured continuity memory extracted from a roleplay or simulation excerpt of any genre.',
    strict: true,
    returnInvalid: true,
    value: extractionSchema,
});

const arcSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'storyTime', 'participants', 'summary', 'turningPoints', 'emotionalArc', 'closingState', 'openThreads', 'importance'],
    properties: {
        title: { type: 'string' },
        storyTime: { type: 'string' },
        participants: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        turningPoints: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        emotionalArc: { type: 'string' },
        closingState: { type: 'string' },
        openThreads: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
    },
};

const arcJsonSchema = Object.freeze({
    name: 'continuity_l2_arc',
    description: 'A non-destructive L2 record derived from chronological L1 records.',
    strict: true,
    returnInvalid: true,
    value: arcSchema,
});

const eraJsonSchema = Object.freeze({
    name: 'continuity_l3_era',
    description: 'A non-destructive L3 record derived from chronological L2 records.',
    strict: true,
    returnInvalid: true,
    value: arcSchema,
});

const correctionSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'operations'],
    properties: {
        summary: { type: 'string' },
        operations: {
            type: 'array',
            maxItems: 24,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['action', 'category', 'targetId', 'reason', 'recordJson'],
                properties: {
                    action: { type: 'string', enum: ['add', 'update', 'delete'] },
                    category: { type: 'string', enum: ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds', 'capsules'] },
                    targetId: { type: 'string' },
                    reason: { type: 'string' },
                    recordJson: { type: 'string' },
                },
            },
        },
    },
};

const correctionJsonSchema = Object.freeze({
    name: 'continuity_memory_correction',
    description: 'A reviewed patch plan for correcting existing structured continuity memory.',
    strict: true,
    returnInvalid: true,
    value: correctionSchema,
});

const CORRECTION_SYSTEM_PROMPT = `You repair structured roleplay continuity memory from an explicit user correction.
The correction is authoritative. Change only records that conflict with it or are necessary to preserve it.
Use exact category names and target IDs from the supplied candidate records. For update, return the complete corrected public record as JSON encoded inside recordJson. For delete, use "{}". For add, leave targetId empty and return the complete new record.
Check every relevant representation of the mistake. In particular, update or remove an L1 capsule when it repeats the incorrect event; otherwise derived summaries can relearn the error.
Do not alter unrelated details, invent unsupported events, create new L1 capsules, or edit chat messages. Return JSON only.`;

const ARC_JSON_SHAPE_EXAMPLE = JSON.stringify({
    title: '', storyTime: '', participants: [], summary: '', turningPoints: [],
    emotionalArc: '', closingState: '', openThreads: [], importance: 3,
});

const JSON_SHAPE_EXAMPLE = JSON.stringify({
    scene: { location: '', time: '', participants: [], activity: '', mood: '' },
    sceneCapsule: { title: '', storyTime: '', location: '', participants: [], opening: '', beats: [], emotionalArc: '', closing: '', importance: 3, temporal: { frame: 'main narrative', relation: 'unknown', elapsed: '', certainty: 'unknown' } },
    entities: [{ targetId: '', name: '', type: '', aliases: [], description: '', importance: 3 }],
    identityResolutions: [{ reference: '', canonical: '', evidence: '' }],
    recordMerges: [{ category: 'facts', canonicalId: '', duplicateIds: [], evidence: '' }],
    facts: [{ targetId: '', subject: '', predicate: '', value: '', category: '', importance: 3, persistence: 'persistent' }],
    states: [{ targetId: '', subject: '', attribute: '', value: '', previous: '', importance: 3, scope: 'scene', operation: 'set' }],
    relationships: [{ targetId: '', from: '', to: '', kind: '', status: '', dynamic: '', importance: 3 }],
    events: [{ title: '', summary: '', participants: [], location: '', storyTime: '', consequences: '', importance: 3, temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'implicit' } }],
    threads: [{ targetId: '', title: '', detail: '', status: 'open', participants: [], importance: 3 }],
    backgrounds: [{ targetId: '', topic: '', summary: '', status: 'active', certainty: 'reported', participants: [], importance: 2 }],
});

let activeExtractionThinkingMode = null;
const DIRECT_PROFILE_ID = '__direct__';

export function applyExtractionRequestSettings(data) {
    if (!activeExtractionThinkingMode || !data || typeof data !== 'object') return;
    const control = buildThinkingRequest({
        mode: activeExtractionThinkingMode,
        source: data.chat_completion_source,
        model: data.model,
        url: data.custom_url || data.reverse_proxy,
    });
    Object.assign(data, control.payload);
    if (!shouldSendStructuredSchema(control.adapter, data.json_schema)) delete data.json_schema;
    updateRuntime({ thinkingControl: { mode: activeExtractionThinkingMode, adapter: control.adapter, fallback: false } });
}

export async function generateWithThinkingPolicy(options) {
    activeExtractionThinkingMode = getSettings().thinkingMode;
    try {
        try {
            return await generateRaw(options);
        } catch (error) {
            if (!isThinkingControlError(error) || activeExtractionThinkingMode === 'default') throw error;
            console.warn('[Continuity] Endpoint rejected its detected thinking control; retrying without a control.', error);
            updateRuntime({ thinkingControl: { mode: activeExtractionThinkingMode, adapter: 'provider-default', fallback: true } });
            activeExtractionThinkingMode = 'default';
            return await generateRaw(options);
        }
    } finally {
        activeExtractionThinkingMode = null;
    }
}

function formatMessages(messages) {
    return messages.map(message => `[message ${message.index}] [${message.name}]: ${message.text}`).join('\n\n');
}

function collectMessages(from, to) {
    const chat = getContext().chat || [];
    const messages = [];
    const start = Math.max(0, Number(from) || 0);
    const end = Math.min(chat.length - 1, Number(to));
    for (let index = start; index <= end; index++) {
        const message = chat[index];
        const body = String(message?.mes || '').trim();
        if (!message || message.is_system || !body) continue;
        messages.push({ index, name: message.name || (message.is_user ? 'User' : 'Character'), text: body });
    }
    return messages;
}

async function chunkMessages(messages, tokenLimit, maxMessages = Infinity) {
    const chunks = [];
    let chunk = [];
    let tokens = 0;
    for (const message of messages) {
        const discontinuous = chunk.length && message.index > chunk.at(-1).index + 1;
        const candidate = discontinuous ? [message] : [...chunk, message];
        const candidateTokens = await getTokenCountAsync(formatMessages(candidate));
        if (chunk.length && (candidateTokens > tokenLimit || candidate.length > maxMessages || discontinuous)) {
            chunks.push({ messages: chunk, tokens });
            chunk = [];
            tokens = 0;
        }
        chunk.push(message);
        tokens = await getTokenCountAsync(formatMessages(chunk));
    }
    if (chunk.length) chunks.push({ messages: chunk, tokens });
    return chunks;
}

function validateResult(result, world) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Extractor returned no JSON object.');
    if (!result.sceneCapsule || typeof result.sceneCapsule !== 'object' || !Array.isArray(result.sceneCapsule.beats)) {
        throw new Error('Extractor returned no valid chronological scene capsule.');
    }
    for (const key of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']) {
        if (!Array.isArray(result[key])) throw new Error(`Extractor field "${key}" is not an array.`);
    }
    sanitizeReconciliationMetadata(result, world);
    return result;
}

const CONTEXT_STOP_WORDS = new Set('a an the and are as at be by for from has have in is it of on or that the their this to was were will with'.split(' '));

function contextTerms(value) {
    return new Set((String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [])
        .filter(term => term.length > 1 && !CONTEXT_STOP_WORDS.has(term)));
}

function extractionStateContext(world, messages) {
    const conversation = formatMessages(messages).toLocaleLowerCase();
    const conversationTerms = contextTerms(conversation);
    const rankedActive = (world?.states || []).filter(isActiveState).map(item => {
        const source = latestSourceRange(item);
        const subject = String(item.subject || '');
        const mentioned = subject && conversation.includes(subject.toLocaleLowerCase());
        return { item, mentioned, sourceTo: Number(source?.to ?? -1) };
    }).sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || b.sourceTo - a.sourceTo);
    const active = [...rankedActive.filter(entry => entry.mentioned), ...rankedActive.slice(0, 12)]
        .filter((entry, index, all) => all.findIndex(other => other.item === entry.item) === index)
        .slice(0, 24);
    const activeSubjects = new Set(active.map(({ item }) => String(item.subject || '').toLocaleLowerCase()));
    const entities = (world?.entities || []).filter(entity => {
        const names = [entity.name, ...(entity.aliases || [])].map(value => String(value || '').toLocaleLowerCase()).filter(Boolean);
        return names.some(name => conversation.includes(name)) || activeSubjects.has(String(entity.name || '').toLocaleLowerCase());
    }).slice(0, 30).map(entity => ({ targetId: entity.id, name: entity.name, aliases: entity.aliases || [] }));
    const rankCanonical = (items, searchable, subjects, limit) => (items || []).map(item => {
        const source = latestSourceRange(item);
        const content = searchable(item);
        const score = [...contextTerms(content)].reduce((total, term) => total + Number(conversationTerms.has(term)), 0)
            + subjects(item).reduce((total, subject) => total + (subject && conversation.includes(String(subject).toLocaleLowerCase()) ? 6 : 0), 0);
        return { item, score, sourceTo: Number(source?.to ?? -1) };
    }).filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score || b.sourceTo - a.sourceTo)
        .slice(0, limit)
        .map(({ item }) => item);
    const facts = rankCanonical(world?.facts,
        item => `${item.subject || ''} ${item.predicate || ''} ${item.value || ''}`,
        item => [item.subject], 18).map(item => ({
        targetId: item.id,
        subject: item.subject,
        predicate: item.predicate,
        value: String(item.value || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    }));
    const relationships = rankCanonical(world?.relationships,
        item => `${item.from || ''} ${item.to || ''} ${item.kind || ''} ${item.status || ''} ${item.dynamic || ''}`,
        item => [item.from, item.to], 12).map(item => ({
        targetId: item.id,
        from: item.from,
        to: item.to,
        kind: item.kind,
        status: item.status,
        dynamic: String(item.dynamic || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    }));
    const threadCandidates = (world?.threads || []).map(item => {
        const source = latestSourceRange(item);
        const searchable = `${item.title || ''} ${item.detail || ''} ${(item.participants || []).join(' ')}`;
        const score = [...contextTerms(searchable)].reduce((total, term) => total + Number(conversationTerms.has(term)), 0);
        return { item, score, sourceTo: Number(source?.to ?? -1) };
    }).sort((a, b) => b.score - a.score || b.sourceTo - a.sourceTo);
    const activeThreads = [...threadCandidates.filter(entry => entry.score > 0).slice(0, 8), ...threadCandidates.filter(entry => entry.item.status === 'open').slice(0, 2)]
        .filter((entry, index, all) => all.findIndex(other => other.item === entry.item) === index)
        .slice(0, 12)
        .map(({ item }) => ({
            targetId: item.id,
            title: item.title,
            detail: String(item.detail || '').replace(/\s+/g, ' ').trim().slice(0, 240),
            status: item.status,
        }));
    const backgrounds = rankCanonical(world?.backgrounds,
        item => `${item.topic || ''} ${item.summary || ''} ${(item.participants || []).join(' ')}`,
        item => item.participants || [], 16).map(item => ({
        targetId: item.id,
        topic: item.topic,
        summary: String(item.summary || '').replace(/\s+/g, ' ').trim().slice(0, 320),
        status: item.status,
        certainty: item.certainty,
    }));
    const snapshot = {
        canonicalEntities: entities,
        activeStates: active.map(({ item }) => ({
            targetId: item.id,
            subject: item.subject,
            attribute: item.attribute,
            value: item.value,
            scope: item.scope,
        })),
        canonicalFacts: facts,
        canonicalRelationships: relationships,
        knownThreads: activeThreads,
        knownBackgrounds: backgrounds,
    };
    return `CANONICAL MEMORY CONTEXT (reference only; not source events):\n${JSON.stringify(snapshot)}\n\nFor entities, facts, states, relationships, threads, and backgrounds, set targetId to the supplied record ID when the new narrative updates the same underlying record even if its wording differs; preserve its canonical identity fields. Leave targetId empty only for genuinely new records. Do not output unchanged records. If multiple supplied facts, states, relationships, threads, or backgrounds are semantic duplicates of one durable item, add one recordMerges entry naming the canonical ID and duplicate IDs; never merge merely similar or recurring events. Clear an invalidated ongoing state with an empty value. Reuse exact canonical names, predicates, attributes, relationship kinds, thread titles, and background topics.`;
}

function extractionTemporalContext(world) {
    const anchors = temporalContext(world, getChatKey());
    return `IMMUTABLE NARRATIVE-TIME CONTEXT:\n${JSON.stringify(anchors)}\n\nTemporal output rules:\n- Message count, token count, L1 boundaries, extraction time, and real-world time never imply elapsed story time.\n- frame identifies the local subjective timeline or clock. Reuse an exact prior frame name when it is the same timeline; use a distinct frame for dreams, flashbacks, time-dilated locations, alternate timelines, or other unsynchronized clocks.\n- For sceneCapsule, relation is relative to the most recent earlier L1 in the same frame. For each event, relation is relative to the containing sceneCapsule: same-period, after, before, overlaps, detached, or unknown. Ordering does not imply a duration.\n- elapsed contains only an explicitly stated narrative interval such as "three years"; otherwise leave it empty. Perceived duration is not elapsed time.\n- certainty is explicit only when narration or dialogue establishes the timing, implicit for a clear qualitative sequence without a duration, and unknown otherwise.\n- Preserve phrases such as yesterday, tomorrow, last year, or the last 300 days in storyTime when no calendar exists. They will be bound to this immutable L1 anchor and must never float relative to a later current scene.\n- A time skip changes narrative time only when the source establishes it. Never invent dates or synchronize separate frames.`;
}

async function extractChunk(messages, world = runtime.world) {
    const settings = getSettings();
    const detail = settings.detail;
    const detailInstruction = detail === 'light'
        ? 'Capture only details likely to matter again.'
        : detail === 'detailed'
            ? 'Capture subtle recurring details, conditions, relationships, routines, rules, resources, and small changes as well as major developments, using whatever categories fit this scenario.'
            : 'Capture major developments and useful recurring or persistent details without recording filler.';
    const prompt = renderPromptTemplate(settings.extractionTaskTemplate ?? DEFAULT_EXTRACTION_TASK_TEMPLATE, {
        detail: detailInstruction,
        schema: JSON_SHAPE_EXAMPLE,
        messages: formatMessages(messages),
        active_states: extractionStateContext(world, messages),
        temporal_context: extractionTemporalContext(world),
    }, ['schema', 'messages', 'active_states', 'temporal_context']);
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const systemPrompt = buildExtractionSystemPrompt(settings.extractionSystemPrompt, settings.jbEnabled, settings.jbPrompt);
            const raw = await requestExtraction(prompt, systemPrompt);
            updateRuntime({ lastRawResponse: String(raw).slice(0, 30000) });
            const parsed = typeof raw === 'string' ? parseJsonResponse(raw) : raw;
            const result = validateResult(parsed, world);
            updateRuntime({ lastValidation: `Valid structured extraction${attempt > 1 ? ' after retry' : ''}` });
            return result;
        } catch (error) {
            lastError = error;
            updateRuntime({ lastValidation: `Extraction attempt ${attempt}/2 failed: ${error.message}` });
            if (isRateLimitError(error)) throw new Error(`Rate limited; this chunk remains pending. Resume processing after the endpoint recovers.`, { cause: error });
        }
    }
    throw new Error(`Structured extraction failed twice: ${lastError?.message || 'unknown error'}`);
}

async function requestExtraction(prompt, systemPrompt) {
    return requestStructured(prompt, systemPrompt, extractionJsonSchema, memoryResponseTokens('l1'));
}

function directRequestConfig(kind) {
    const settings = getSettings();
    const summary = kind === 'summary';
    const provider = settings[summary ? 'summaryDirectProvider' : 'extractionDirectProvider'] === 'openrouter' ? 'openrouter' : 'custom';
    const url = provider === 'openrouter'
        ? settings[summary ? 'summaryOpenRouterUrl' : 'extractionOpenRouterUrl'] || 'https://openrouter.ai/api/v1'
        : settings[summary ? 'summaryDirectUrl' : 'extractionDirectUrl'] || 'https://api.openai.com/v1';
    const model = provider === 'openrouter'
        ? settings[summary ? 'summaryOpenRouterModel' : 'extractionOpenRouterModel']
        : settings[summary ? 'summaryDirectModel' : 'extractionDirectModel'];
    const secretId = provider === 'custom' ? settings[summary ? 'summaryDirectSecretId' : 'extractionDirectSecretId'] : '';
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error(`Enter a valid ${summary ? 'summarizer' : 'extraction'} API URL.`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Direct API URLs must use HTTP or HTTPS.');
    if (!String(model || '').trim()) throw new Error(`Enter a ${summary ? 'summarizer' : 'extraction'} model ID.`);
    return { provider, url: parsed.toString().replace(/\/$/, ''), model: String(model).trim(), secretId };
}

async function requestDirectStructured(prompt, systemPrompt, jsonSchema, responseLength, kind, withSchema = true) {
    const config = directRequestConfig(kind);
    const thinking = buildThinkingRequest({
        mode: getSettings().thinkingMode,
        source: config.provider === 'openrouter' ? 'openrouter' : 'custom',
        model: config.model,
        url: config.url,
    });
    const body = {
        chat_completion_source: config.provider,
        model: config.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        stream: false,
        ...outputTokenPayload(config.model, responseLength),
        ...(config.provider === 'openrouter' ? { api_url: config.url } : { custom_url: config.url, secret_id: config.secretId || undefined }),
        ...(withSchema && shouldSendStructuredSchema(thinking.adapter, jsonSchema) ? { json_schema: jsonSchema } : {}),
        ...thinking.payload,
    };
    updateRuntime({ thinkingControl: { mode: getSettings().thinkingMode, adapter: thinking.adapter, fallback: false } });
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: text || response.statusText }; }
    if (!response.ok || payload?.error) {
        const detail = payload?.error?.message || payload?.error || payload?.message || `${response.status} ${response.statusText}`;
        throw new Error(`Direct ${kind} API failed: ${detail}`);
    }
    const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
    const result = Array.isArray(content) ? content.map(item => item?.text || '').join('') : content;
    if (!String(result || '').trim()) throw new Error(`Direct ${kind} API returned no text.`);
    return String(result);
}

export async function requestDirectText(prompt, systemPrompt, responseLength = 300, kind = 'extraction') {
    return requestDirectStructured(prompt, systemPrompt, null, responseLength, kind, false);
}

async function requestStructured(prompt, systemPrompt, jsonSchema, responseLength = null, profileId = getSettings().memoryProfileId, directKind = 'extraction') {
    if (profileId === DIRECT_PROFILE_ID) {
        try {
            return await requestDirectStructured(prompt, systemPrompt, jsonSchema, responseLength, directKind, true);
        } catch (error) {
            if (!shouldRetryWithoutSchema(error)) throw error;
            updateRuntime({ lastValidation: `Direct API JSON mode unavailable; using compatible plain mode: ${rootErrorMessage(error)}` });
            return requestDirectStructured(prompt, systemPrompt, jsonSchema, responseLength, directKind, false);
        }
    }
    if (!profileId) {
        try {
            return await generateWithThinkingPolicy({ prompt, systemPrompt, responseLength, jsonSchema });
        } catch (error) {
            if (!shouldRetryWithoutSchema(error)) throw error;
            console.warn('[Continuity] Native structured output failed; retrying with plain JSON prompting.', error);
            updateRuntime({ lastValidation: `Native JSON mode unavailable; using compatible plain mode: ${rootErrorMessage(error)}` });
            return await generateWithThinkingPolicy({ prompt, systemPrompt, responseLength });
        }
    }

    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const apiMap = ConnectionManagerRequestService.validateProfile(profile);
    const profileResponseLength = responseLength ?? undefined;
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
    ];
    const options = isolatedProfileOptions();
    const thinking = buildThinkingRequest({
        mode: getSettings().thinkingMode,
        source: apiMap.source,
        model: profile.model,
        url: profile['api-url'],
        profileName: profile.name,
    });
    let thinkingPayload = thinking.payload;
    updateRuntime({ thinkingControl: { mode: getSettings().thinkingMode, adapter: thinking.adapter, fallback: false } });
    const compatibilityPayload = () => isolatedProfilePayload({
        ...outputTokenPayload(profile.model, responseLength),
        ...thinkingPayload,
    });
    let response;
    if (!shouldSendStructuredSchema(thinking.adapter, jsonSchema)) {
        updateRuntime({ lastValidation: 'Gemini native schema omitted; using compatible exact-shape JSON prompting.' });
        try {
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messages, profileResponseLength, options, compatibilityPayload(),
            );
        } catch (error) {
            if (!thinking.controlled || !isThinkingControlError(error)) throw error;
            thinkingPayload = {};
            updateRuntime({ thinkingControl: { mode: getSettings().thinkingMode, adapter: thinking.adapter, fallback: true } });
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messages, profileResponseLength, options, compatibilityPayload(),
            );
        }
        const result = extractMessageFromData(response, apiMap.selected);
        if (!result || typeof result !== 'string') throw new Error(`Connection profile “${profile.name}” returned no text.`);
        return result;
    }
    try {
        response = await ConnectionManagerRequestService.sendRequest(
            profileId, messages, profileResponseLength, options, { ...compatibilityPayload(), json_schema: jsonSchema },
        );
    } catch (error) {
        if (thinking.controlled && isThinkingControlError(error)) {
            console.warn(`[Continuity] ${thinking.adapter} rejected its thinking control; retrying without it.`, error);
            thinkingPayload = {};
            updateRuntime({ thinkingControl: { mode: getSettings().thinkingMode, adapter: thinking.adapter, fallback: true } });
            try {
                response = await ConnectionManagerRequestService.sendRequest(
                    profileId, messages, profileResponseLength, options, { ...compatibilityPayload(), json_schema: jsonSchema },
                );
            } catch (retryError) {
                error = retryError;
            }
            if (response) {
                const result = extractMessageFromData(response, apiMap.selected);
                if (!result || typeof result !== 'string') throw new Error(`Connection profile “${profile.name}” returned no text.`);
                return result;
            }
        }
        if (!shouldRetryWithoutSchema(error)) throw error;
        console.warn('[Continuity] Connection profile rejected native structured output; retrying with plain JSON prompting.', error);
        updateRuntime({ lastValidation: `Profile JSON mode unavailable; using compatible plain mode: ${rootErrorMessage(error)}` });
        try {
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messages, profileResponseLength, options, compatibilityPayload(),
            );
        } catch (plainError) {
            if (!Object.keys(thinkingPayload).length || !isThinkingControlError(plainError)) throw plainError;
            thinkingPayload = {};
            updateRuntime({ thinkingControl: { mode: getSettings().thinkingMode, adapter: thinking.adapter, fallback: true } });
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messages, profileResponseLength, options, compatibilityPayload(),
            );
        }
    }
    const result = extractMessageFromData(response, apiMap.selected);
    if (!result || typeof result !== 'string') throw new Error(`Connection profile “${profile.name}” returned no text.`);
    return result;
}

export async function reviewMemoryCorrection(instruction) {
    const request = String(instruction || '').trim();
    if (!request) throw new Error('Describe the memory correction first.');
    if (request.length > 4000) throw new Error('The correction is too long. Split it into smaller corrections.');
    if (runtime.processing) throw new Error('Wait for current memory processing to finish.');
    const worldId = getBoundWorldId();
    if (!worldId) throw new Error('Open a chat with Continuity memory first.');
    let health = runtime.health;
    if (!health || Number(health.schemaVersion) < 7) {
        health = await api.health();
        updateRuntime({ health });
    }
    if (Number(health.schemaVersion) < 7) throw new Error('Restart SillyTavern once to activate durable memory corrections.');
    const world = runtime.world?.id === worldId ? runtime.world : (await api.getWorld(worldId)).world;
    const candidates = selectCorrectionContext(world, request);
    if (!candidates.length) throw new Error('No matching stored memories were found. Include specific names, places, or event details.');
    const prompt = `AUTHORITATIVE USER CORRECTION:\n${request}\n\nCANDIDATE STORED RECORDS:\n${candidates.map(item => JSON.stringify(item)).join('\n')}\n\nPropose the smallest complete correction plan. Every targetId must come from the candidate list.`;
    const epoch = runtime.generation;
    updateRuntime({ processing: true, status: 'reviewing-correction', lastError: '', retryStatus: `Reviewing ${candidates.length} potentially relevant memory record(s)…` });
    try {
        const raw = await requestStructured(
            prompt,
            CORRECTION_SYSTEM_PROMPT,
            correctionJsonSchema,
            resolveCorrectionResponseTokens(getSettings().correctionResponseTokens),
        );
        if (runtime.generation !== epoch) throw new Error('Correction review was stopped; no proposal was retained.');
        const parsed = typeof raw === 'string' ? parseJsonResponse(raw) : raw;
        const proposal = augmentCorrectionChronology(world, validateCorrectionProposal(world, parsed, request));
        updateRuntime({ status: 'idle', retryStatus: `Correction review ready with ${proposal.operations.length} proposed change(s).` });
        return { ...proposal, worldId, baseRevision: Number(world.revision) || 0 };
    } catch (error) {
        updateRuntime({ status: 'error', lastError: error.message, retryStatus: `Correction review failed: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

async function rebuildCorrectionHierarchy(result, expectedEpoch) {
    const hierarchyMode = getSettings().hierarchyMode;
    if (!['l2', 'l3'].includes(hierarchyMode)) return { arcs: 0, eras: 0, world: runtime.world };
    let world = runtime.world;
    const rebuiltArcIds = new Map();
    let arcs = 0;
    let eras = 0;
    const rebuildGroups = [...(result.invalidatedArcRecords || []).map(item => ({ previous: item, capsuleIds: item.capsuleIds || [] }))];
    const alreadyGrouped = new Set(rebuildGroups.flatMap(item => item.capsuleIds));
    for (const capsuleId of result.addedCapsuleIds || []) {
        if (!alreadyGrouped.has(capsuleId)) rebuildGroups.push({ previous: null, capsuleIds: [capsuleId] });
    }
    for (let index = 0; index < rebuildGroups.length; index++) {
        const group = rebuildGroups[index];
        const capsules = group.capsuleIds.map(id => (world.capsules || []).find(item => item.id === id)).filter(Boolean);
        if (!capsules.length || capsules.length !== group.capsuleIds.length) continue;
        updateRuntime({ retryStatus: `Correction saved. Rebuilding affected L2 ${index + 1}/${rebuildGroups.length}…` });
        const generated = await generateArc(capsules);
        if (runtime.generation !== expectedEpoch) throw new Error('Correction hierarchy rebuild was stopped.');
        const arc = await saveDerivedArc(structuredClone(world), generated, capsules);
        if (group.previous?.id) rebuiltArcIds.set(group.previous.id, arc.id);
        world = runtime.world;
        arcs++;
    }
    if (hierarchyMode === 'l3') {
        const eraGroups = result.invalidatedEraRecords || [];
        for (let index = 0; index < eraGroups.length; index++) {
            const previous = eraGroups[index];
            const sourceArcs = (previous.arcIds || []).map(id => {
                const currentId = rebuiltArcIds.get(id) || id;
                return (world.arcs || []).find(item => item.id === currentId);
            }).filter(Boolean);
            if (!sourceArcs.length || sourceArcs.length !== (previous.arcIds || []).length) continue;
            updateRuntime({ retryStatus: `Correction saved. Rebuilding affected L3 ${index + 1}/${eraGroups.length}…` });
            const generated = await generateEra(sourceArcs);
            if (runtime.generation !== expectedEpoch) throw new Error('Correction hierarchy rebuild was stopped.');
            await saveDerivedEra(structuredClone(world), generated, sourceArcs);
            world = runtime.world;
            eras++;
        }
    }
    return { arcs, eras, world };
}

export async function commitMemoryCorrection(proposal) {
    if (runtime.processing) throw new Error('Wait for current memory processing to finish.');
    const worldId = getBoundWorldId();
    if (!worldId || proposal?.worldId !== worldId) throw new Error('The reviewed correction belongs to a different memory. Review it again.');
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    if (Number(world.revision) !== Number(proposal.baseRevision)) throw new Error('Memory changed after this correction was reviewed. Review it again before applying.');
    const epoch = runtime.generation;
    updateRuntime({ processing: true, status: 'applying-correction', lastError: '', retryStatus: 'Applying reviewed memory correction…' });
    let canonicalSaved = false;
    try {
        const result = applyCorrectionProposal(world, proposal);
        world = (await api.saveWorld(world)).world;
        canonicalSaved = true;
        updateRuntime({ world, retryStatus: `Correction saved. Rebuilding ${result.invalidatedArcs} affected L2 and ${result.invalidatedEras} affected L3 record(s)…` });
        await embedWorldInChat(world);
        let hierarchy = { arcs: 0, eras: 0, world };
        let hierarchyError = '';
        try {
            hierarchy = await rebuildCorrectionHierarchy(result, epoch);
            world = hierarchy.world || runtime.world || world;
        } catch (error) {
            hierarchyError = error.message;
        }
        const status = hierarchyError ? 'error' : 'idle';
        const retryStatus = hierarchyError
            ? `Correction was saved, but its hierarchy rebuild stopped: ${hierarchyError}`
            : `Applied ${result.changed} correction change(s); rebuilt ${hierarchy.arcs} L2 and ${hierarchy.eras} L3 record(s).`;
        updateRuntime({ world, status, lastError: hierarchyError, retryStatus });
        return { ...result, ...hierarchy, world, hierarchyError };
    } catch (error) {
        const message = error.status === 409 ? 'Memory changed while the correction was being applied. Review it again.' : error.message;
        updateRuntime({ status: 'error', lastError: message, retryStatus: canonicalSaved ? `Correction was saved, but follow-up work failed: ${message}` : `Correction was not applied: ${message}` });
        throw new Error(message, { cause: error });
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

function rootErrorMessage(error) {
    return error?.cause?.message || error?.message || String(error);
}

function shouldRetryWithoutSchema(error) {
    const message = rootErrorMessage(error).toLowerCase();
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|incorrect (?:api )?key|password/.test(message)) return false;
    if (/enotfound|econnrefused|invalid url|failed to fetch|network error|timed? ?out|timeout/.test(message)) return false;
    return /response[_ -]?format|json[_ -]?schema|structured output|schema|deseriali[sz]e|unknown field|unsupported (?:field|parameter)|invalid[_ -]?request|bad request|\b(400|422)\b/.test(message);
}

function parseJsonResponse(value) {
    let text = String(value || '')
        .replace(/<(think|thinking|thought|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '')
        .trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1].trim();
    try {
        return JSON.parse(text);
    } catch {
        // Reasoning models sometimes put prose or an earlier scratch JSON object
        // around the answer. Parse complete top-level objects and prefer the last.
    }
    const candidates = [];
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') { quoted = true; continue; }
        if (char === '{') {
            if (depth === 0) start = index;
            depth++;
        } else if (char === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) candidates.push(text.slice(start, index + 1));
        }
    }
    for (let index = candidates.length - 1; index >= 0; index--) {
        try { return JSON.parse(candidates[index]); }
        catch { /* try the preceding complete object */ }
    }
    throw new Error('Extractor returned text without a valid JSON object.');
}

function formatCapsules(capsules) {
    return capsules.map((capsule, index) => JSON.stringify({
        sequence: index + 1,
        storyTime: capsule.storyTime,
        temporal: capsule.temporal,
        location: capsule.location,
        participants: capsule.participants,
        opening: capsule.opening,
        beats: capsule.beats,
        emotionalArc: capsule.emotionalArc,
        closing: capsule.closing,
        importance: capsule.importance,
    })).join('\n');
}

function formatArcs(arcs) {
    return arcs.map((arc, index) => JSON.stringify({
        sequence: index + 1,
        storyTime: arc.storyTime,
        temporalAnchorIds: arc.temporalAnchorIds,
        temporalFrames: arc.temporalFrames,
        participants: arc.participants,
        summary: arc.summary,
        turningPoints: arc.turningPoints,
        emotionalArc: arc.emotionalArc,
        closingState: arc.closingState,
        openThreads: arc.openThreads,
        importance: arc.importance,
    })).join('\n');
}

function nextEraArcs(world, settings = getSettings()) {
    if (settings.hierarchyMode !== 'l3') return null;
    const groupSize = Math.max(3, Math.min(16, Math.round(Number(settings.eraGroupSize) || 6)));
    const threshold = Math.max(groupSize * 2, Math.min(100, Math.round(Number(settings.eraStartArcs) || 12)));
    const covered = new Set((world.eras || []).flatMap(era => era.arcIds || []));
    const byChat = new Map();
    for (const arc of world.arcs || []) {
        const chatKey = arc.chatKey || '';
        if (!byChat.has(chatKey)) byChat.set(chatKey, []);
        byChat.get(chatKey).push(arc);
    }
    for (const arcs of byChat.values()) {
        arcs.sort((a, b) => Number(a.from ?? 0) - Number(b.from ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        if (arcs.length < threshold) continue;
        const ungrouped = arcs.filter(arc => !covered.has(arc.id));
        // Always retain at least one recent group as fine-grained L2-only history.
        if (ungrouped.length < groupSize * 2) continue;
        return ungrouped.slice(0, groupSize);
    }
    return null;
}

function validateArcResult(result, layer = 'L2') {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${layer} summarizer returned no JSON object.`);
    for (const key of ['participants', 'turningPoints', 'openThreads']) {
        if (!Array.isArray(result[key])) throw new Error(`${layer} field "${key}" is not an array.`);
    }
    if (!String(result.summary || '').trim()) throw new Error(`${layer} summarizer returned no summary.`);
    return result;
}

async function generateArc(capsules) {
    const settings = getSettings();
    const prompt = renderPromptTemplate(settings.arcTaskTemplate ?? DEFAULT_ARC_TASK_TEMPLATE, {
        schema: ARC_JSON_SHAPE_EXAMPLE,
        capsules: formatCapsules(capsules),
    }, ['schema', 'capsules']);
    const profileId = settings.arcProfileId || settings.memoryProfileId;
    const directKind = settings.arcProfileId === DIRECT_PROFILE_ID ? 'summary' : 'extraction';
    const raw = await requestStructured(prompt, buildHierarchySystemPrompt(settings.arcSystemPrompt ?? DEFAULT_ARC_SYSTEM_PROMPT), arcJsonSchema, memoryResponseTokens('l2'), profileId, directKind);
    updateRuntime({ lastArcResponse: String(raw).slice(0, 20000) });
    return validateArcResult(typeof raw === 'string' ? parseJsonResponse(raw) : raw, 'L2');
}

async function saveDerivedArc(world, result, capsules) {
    addDerivedArc(world, result, capsules);
    try {
        world = (await api.saveWorld(world)).world;
    } catch (error) {
        if (error.status !== 409) throw error;
        world = (await api.getWorld(world.id)).world;
        const currentCapsules = capsules.map(source => (world.capsules || []).find(item => item.id === source.id)).filter(Boolean);
        if (currentCapsules.length !== capsules.length) throw new Error('L1 records changed while L2 was being built; retry later.');
        addDerivedArc(world, result, currentCapsules);
        world = (await api.saveWorld(world)).world;
    }
    updateRuntime({ world, arcStatus: `Created L2 “${world.arcs.at(-1)?.title || 'Untitled'}”.`, arcError: '' });
    await embedWorldInChat(world);
    return world.arcs.at(-1);
}

export async function buildNextArc(worldId = getBoundWorldId(), expectedEpoch = null) {
    if (!worldId) throw new Error('Open a chat and prepare its memory first.');
    let health = runtime.health;
    if (!health || Number(health.schemaVersion) < 4) {
        health = await api.health();
        updateRuntime({ health });
    }
    if (Number(health.schemaVersion) < 4) throw new Error('Restart SillyTavern once to activate non-destructive L2 storage.');
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    const capsules = nextArcCapsules(world, getSettings());
    if (!capsules) return null;
    updateRuntime({ arcStatus: `Building L2 from ${capsules.length} L1 records…`, arcError: '' });
    const result = await generateArc(capsules);
    if (expectedEpoch !== null && runtime.generation !== expectedEpoch) throw new Error('Processing stopped; pending L2 result was discarded.');
    return saveDerivedArc(world, result, capsules);
}

async function saveDerivedEra(world, result, arcs) {
    addDerivedEra(world, result, arcs);
    try {
        world = (await api.saveWorld(world)).world;
    } catch (error) {
        if (error.status !== 409) throw error;
        world = (await api.getWorld(world.id)).world;
        const currentArcs = arcs.map(source => (world.arcs || []).find(item => item.id === source.id)).filter(Boolean);
        if (currentArcs.length !== arcs.length) throw new Error('L2 records changed while L3 was being built; retry later.');
        addDerivedEra(world, result, currentArcs);
        world = (await api.saveWorld(world)).world;
    }
    updateRuntime({ world, arcStatus: `Created L3 “${world.eras.at(-1)?.title || 'Untitled'}”.`, arcError: '' });
    await embedWorldInChat(world);
    return world.eras.at(-1);
}

export async function buildNextEra(worldId = getBoundWorldId(), expectedEpoch = null) {
    if (!worldId) throw new Error('Open a chat and prepare its memory first.');
    if (getSettings().hierarchyMode !== 'l3') return null;
    let health = runtime.health;
    if (!health || Number(health.schemaVersion) < 6) {
        health = await api.health();
        updateRuntime({ health });
    }
    if (Number(health.schemaVersion) < 6) throw new Error('Restart SillyTavern once to activate non-destructive L3 storage.');
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    const arcs = nextEraArcs(world);
    if (!arcs) return null;
    updateRuntime({ arcStatus: `Building L3 from ${arcs.length} L2 records…`, arcError: '' });
    const result = await generateEra(arcs);
    if (expectedEpoch !== null && runtime.generation !== expectedEpoch) throw new Error('Processing stopped; pending L3 result was discarded.');
    return saveDerivedEra(world, result, arcs);
}

async function requireRetryStorage() {
    let health = runtime.health;
    if (!health || Number(health.schemaVersion) < 5) {
        health = await api.health();
        updateRuntime({ health });
    }
    if (Number(health.schemaVersion) < 5) throw new Error('Restart SillyTavern once to activate editable L1/L2 storage.');
}

function retryTargets(world, layer) {
    if (layer === 'l1') {
        const chatKey = getChatKey();
        return (world.capsules || []).filter(item => item.chatKey === chatKey)
            .slice().sort((a, b) => Number(b.to ?? 0) - Number(a.to ?? 0));
    }
    if (layer === 'l2') {
        return (world.arcs || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    }
    return [];
}

async function saveRetriedL1(worldId, target, result, messages) {
    const apply = world => replaceExtraction(world, result, {
        chatKey: target.chatKey,
        from: target.from,
        to: target.to,
        allowStateUpdates: Number(target.to) >= (getContext().chat?.length || 1) - 1,
        messageFingerprints: messages.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
    });
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    apply(world);
    try {
        world = (await api.saveWorld(world)).world;
    } catch (error) {
        if (error.status !== 409) throw error;
        world = (await api.getWorld(worldId)).world;
        apply(world);
        world = (await api.saveWorld(world)).world;
    }
    updateRuntime({ world });
    await embedWorldInChat(world);
}

async function saveRetriedL2(worldId, target, result) {
    const apply = world => {
        const capsules = (target.capsuleIds || []).map(id => (world.capsules || []).find(item => item.id === id)).filter(Boolean);
        if (capsules.length !== (target.capsuleIds || []).length) throw new Error(`Cannot rebuild “${target.title}”; one or more source L1 records changed.`);
        world.arcs = (world.arcs || []).filter(item => item.id !== target.id);
        world.eras = (world.eras || []).filter(era => !(era.arcIds || []).includes(target.id));
        const replacement = addDerivedArc(world, result, capsules);
        replacement.id = target.id;
        replacement.createdAt = target.createdAt || replacement.createdAt;
        replacement.updatedAt = new Date().toISOString();
    };
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    apply(world);
    try {
        world = (await api.saveWorld(world)).world;
    } catch (error) {
        if (error.status !== 409) throw error;
        world = (await api.getWorld(worldId)).world;
        apply(world);
        world = (await api.saveWorld(world)).world;
    }
    updateRuntime({ world });
    await embedWorldInChat(world);
}

export async function retryMemoryLayer({ layer, targetId = 'latest', all = false } = {}) {
    if (!['l1', 'l2'].includes(layer)) throw new Error('Choose L1 or L2 to retry.');
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const worldId = getBoundWorldId();
    if (!worldId) throw new Error('Open a chat and prepare its memory first.');
    await requireRetryStorage();
    let world = runtime.world?.id === worldId ? runtime.world : (await api.getWorld(worldId)).world;
    let targets = retryTargets(world, layer);
    if (!all) {
        const selected = targetId === 'latest' ? targets[0] : targets.find(item => item.id === targetId);
        targets = selected ? [selected] : [];
    }
    if (!targets.length) return { retried: 0 };

    const epoch = runtime.generation;
    updateRuntime({ processing: true, status: 'retrying', lastError: '', retryStatus: `Retrying ${targets.length} ${layer.toUpperCase()} item(s)…` });
    let retried = 0;
    try {
        for (const target of targets) {
            if (runtime.generation !== epoch) throw new Error('Retry stopped; the current generated result was discarded.');
            if (layer === 'l1') {
                const messages = collectMessages(target.from, target.to);
                if (!messages.length) throw new Error(`Source messages ${target.from}–${target.to} are unavailable in this chat.`);
                const result = await extractChunk(messages);
                if (runtime.generation !== epoch) throw new Error('Retry stopped; the current generated result was discarded.');
                await saveRetriedL1(worldId, target, result, messages);
            } else {
                world = runtime.world?.id === worldId ? runtime.world : (await api.getWorld(worldId)).world;
                const capsules = (target.capsuleIds || []).map(id => (world.capsules || []).find(item => item.id === id)).filter(Boolean);
                if (capsules.length !== (target.capsuleIds || []).length) throw new Error(`Cannot rebuild “${target.title}”; its source L1 records changed.`);
                const result = await generateArc(capsules);
                if (runtime.generation !== epoch) throw new Error('Retry stopped; the current generated result was discarded.');
                await saveRetriedL2(worldId, target, result);
            }
            retried++;
            updateRuntime({ retryStatus: `Rebuilt ${retried}/${targets.length} ${layer.toUpperCase()} item(s).` });
        }
        updateRuntime({ status: 'idle', retryStatus: `Rebuilt ${retried} ${layer.toUpperCase()} item(s) with the currently selected model.` });
        return { retried };
    } catch (error) {
        updateRuntime({ status: 'error', lastError: error.message, retryStatus: `Retry stopped after ${retried} successful replacement(s): ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

async function generateEra(arcs) {
    const settings = getSettings();
    const prompt = renderPromptTemplate(settings.eraTaskTemplate ?? DEFAULT_ERA_TASK_TEMPLATE, {
        schema: ARC_JSON_SHAPE_EXAMPLE,
        arcs: formatArcs(arcs),
    }, ['schema', 'arcs']);
    const profileId = settings.arcProfileId || settings.memoryProfileId;
    const directKind = settings.arcProfileId === DIRECT_PROFILE_ID ? 'summary' : 'extraction';
    const raw = await requestStructured(prompt, buildHierarchySystemPrompt(settings.eraSystemPrompt ?? DEFAULT_ERA_SYSTEM_PROMPT), eraJsonSchema, memoryResponseTokens('l3'), profileId, directKind);
    updateRuntime({ lastEraResponse: String(raw).slice(0, 20000) });
    return validateArcResult(typeof raw === 'string' ? parseJsonResponse(raw) : raw, 'L3');
}

export async function syncChangedExtractions(force = false) {
    const settings = getSettings();
    if (!settings.enabled || (!settings.autoExtract && !force) || (runtime.paused && !force)) return { synced: 0, disabled: true };
    if (runtime.processing) return { synced: 0, deferred: true };
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) return { synced: 0 };

    let world = runtime.world?.id === worldId ? runtime.world : (await api.getWorld(worldId)).world;
    const currentMessages = collectMemoryEligibleMessages(getContext().chat || []);
    const targets = findChangedExtractions(world, currentMessages, chatKey);
    if (!targets.length) return { synced: 0 };

    const epoch = runtime.generation;
    const staged = [];
    updateRuntime({ processing: true, status: 'syncing', lastError: '', retryStatus: `Updating ${targets.length} changed memory section(s)…` });
    try {
        for (let index = 0; index < targets.length; index++) {
            const target = targets[index];
            const messages = collectMessages(target.from, target.to);
            if (!messages.length) throw new Error(`Changed source messages ${target.from}–${target.to} are unavailable.`);
            updateRuntime({
                progress: { current: index + 1, total: targets.length, from: target.from, to: target.to },
                retryStatus: `Updating changed memory section ${index + 1}/${targets.length}…`,
            });
            const result = await extractChunk(messages);
            if (runtime.generation !== epoch) throw new Error('Live memory update stopped; existing memory was left unchanged.');
            staged.push({ target, messages, result });
        }

        const apply = targetWorld => {
            for (const { target, messages, result } of staged) {
                replaceExtraction(targetWorld, result, {
                    chatKey,
                    from: target.from,
                    to: target.to,
                    allowStateUpdates: Number(target.to) >= (getContext().chat?.length || 1) - 1,
                    messageFingerprints: messages.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
                });
            }
        };
        world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
        apply(world);
        try {
            world = (await api.saveWorld(world)).world;
        } catch (error) {
            if (error.status !== 409) throw error;
            world = (await api.getWorld(worldId)).world;
            apply(world);
            world = (await api.saveWorld(world)).world;
        }
        updateRuntime({ world, status: 'idle', progress: null, retryStatus: `Updated ${staged.length} changed memory section(s).` });
        await embedWorldInChat(world);
        return { synced: staged.length };
    } catch (error) {
        updateRuntime({ status: 'error', progress: null, lastError: error.message, retryStatus: `Live memory update failed safely: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

export async function restartL1FromScratch() {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    const chat = getContext().chat || [];
    if (!worldId || !chatKey || !chat.length) throw new Error('Open a chat and prepare its memory first.');
    await requireRetryStorage();
    const allMessages = collectMemoryEligibleMessages(chat);
    if (!allMessages.length) throw new Error('This chat has no processable messages.');
    const groupSize = resolveL1GroupSize(getSettings().extractionBatchMessages);
    const messages = completeL1Messages(allMessages, groupSize);
    const pendingTail = allMessages.length - messages.length;
    if (!messages.length) throw new Error(`At least ${groupSize} processable messages are required for the first L1 record.`);
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error('Start Over cleared the processing queue.'));
    const epoch = runtime.generation;
    let completedChunks = 0;
    updateRuntime({ processing: true, paused: false, status: 'restarting', progress: null, lastError: '', retryStatus: 'Erasing all existing memory before the fresh build…' });
    try {
        const clear = world => resetWorldMemory(world);
        let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
        clear(world);
        try {
            world = (await api.saveWorld(world)).world;
        } catch (error) {
            if (error.status !== 409) throw error;
            world = (await api.getWorld(worldId)).world;
            clear(world);
            world = (await api.saveWorld(world)).world;
        }
        updateRuntime({ world, retryStatus: 'All old memory was erased. Preparing the first fresh L1 chunks…' });
        await embedWorldInChat(world);

        const chunks = await chunkMessages(messages, resolveExtractionChunk(getSettings().extractionChunkTokens, getContext().maxContext), groupSize);
        for (let index = 0; index < chunks.length; index++) {
            if (runtime.paused || runtime.generation !== epoch) throw new Error('Fresh rebuild stopped. Completed chunks remain saved; use Build to resume.');
            const chunk = chunks[index].messages;
            updateRuntime({
                progress: { current: index + 1, total: chunks.length, from: chunk[0].index, to: chunk.at(-1).index, inputTokens: chunks[index].tokens },
                retryStatus: `Rebuilding fresh L1 chunk ${index + 1}/${chunks.length}; each completed chunk is saved.`,
            });
            const result = await extractChunk(chunk);
            if (runtime.paused || runtime.generation !== epoch) throw new Error('Fresh rebuild stopped. Completed chunks remain saved; use Build to resume.');
            await saveExtraction(worldId, result, {
                chatKey,
                from: chunk[0].index,
                to: chunk.at(-1).index,
                allowStateUpdates: true,
                messageFingerprints: chunk.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
            });
            completedChunks++;
        }
        updateRuntime({
            status: 'idle',
            progress: null,
            retryStatus: `Fresh L1 build complete: ${messages.length} messages in ${chunks.length} saved chunk(s)${pendingTail ? `; ${pendingTail} recent message(s) remain raw until the next complete group` : ''}.`,
        });
        return { messages: messages.length, chunks: chunks.length, completedChunks, pendingTail };
    } catch (error) {
        const paused = runtime.paused || isRateLimitError(error) || /stopped/i.test(error.message);
        updateRuntime({
            paused,
            status: paused ? 'paused' : 'error',
            progress: null,
            lastError: error.message,
            retryStatus: `Fresh rebuild interrupted after ${completedChunks} saved chunk(s). Old memory remains erased. Use Build to resume missing ranges.`,
        });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

export async function restartHierarchyFromL1() {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const worldId = getBoundWorldId();
    if (!worldId) throw new Error('Open a chat with Continuity memory first.');
    await requireRetryStorage();
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error('L2/L3 rebuild cleared the processing queue.'));
    updateRuntime({ processing: true, paused: false, status: 'restarting', progress: null, lastError: '', retryStatus: 'Deleting existing L2 and L3 while preserving L1…' });
    try {
        const clear = world => resetWorldHierarchy(world);
        let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
        if (!(world.capsules || []).length) throw new Error('There are no L1 records to build L2/L3 from. Use Build or erase everything and start over.');
        const l1Kept = world.capsules.length;
        clear(world);
        try {
            world = (await api.saveWorld(world)).world;
        } catch (error) {
            if (error.status !== 409) throw error;
            world = (await api.getWorld(worldId)).world;
            if (!(world.capsules || []).length) throw new Error('There are no L1 records to build L2/L3 from. Use Build or erase everything and start over.');
            clear(world);
            world = (await api.saveWorld(world)).world;
        }
        updateRuntime({ world, status: 'idle', retryStatus: `Deleted old L2/L3. Rebuilding them from ${l1Kept} preserved L1 record(s)…` });
        await embedWorldInChat(world);
        return { l1Kept, continued: 0 };
    } catch (error) {
        updateRuntime({ status: 'error', progress: null, lastError: error.message, retryStatus: `L2/L3 reset failed: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

async function saveExtraction(worldId, result, meta) {
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    mergeExtraction(world, result, meta);
    try {
        world = (await api.saveWorld(world)).world;
    } catch (error) {
        if (error.status !== 409) throw error;
        world = (await api.getWorld(worldId)).world;
        mergeExtraction(world, result, meta);
        world = (await api.saveWorld(world)).world;
    }
    updateRuntime({ world });
    await embedWorldInChat(world);
    return world;
}

async function processRange(job, epoch) {
    const context = getContext();
    if (!context.chatId) throw new Error('Open a chat first.');
    const currentChatKey = getChatKey();
    if (currentChatKey !== job.chatKey) throw new Error('The active chat changed before processing began.');
    const messages = Array.isArray(job.sourceMessages)
        ? job.sourceMessages.filter(message => Number(message.index) >= job.from && Number(message.index) <= job.to)
        : collectMessages(job.from, job.to);
    if (!messages.length) throw new Error(`No messages found in range ${job.from}-${job.to}.`);
    let currentWorld = runtime.world?.id === job.worldId ? runtime.world : (await api.getWorld(job.worldId)).world;
    const processed = new Map((currentWorld.sources?.[job.chatKey]?.processedMessages || []).map(item => [Number(item.index), item]));
    const fingerprinted = messages.map(message => ({ ...message, fingerprint: fingerprintMessage(message) }));
    const selected = Array.isArray(job.messageIndexes) ? new Set(job.messageIndexes.map(Number)) : null;
    const unseen = fingerprinted.filter(message => {
        const record = processed.get(message.index);
        const current = record?.fingerprint === message.fingerprint && Number(record.version) === EXTRACTION_VERSION;
        return (!selected || selected.has(message.index)) && !current;
    });
    const skipped = messages.length - unseen.length;
    if (!unseen.length) {
        updateRuntime({ lastValidation: `Skipped ${skipped} unchanged message(s); they are already in memory.` });
        return { chunks: 0, messages: 0, skipped };
    }
    const groupSize = resolveL1GroupSize(job.l1GroupSize);
    const chunks = await chunkMessages(unseen, resolveExtractionChunk(getSettings().extractionChunkTokens, getContext().maxContext), groupSize);

    for (let index = 0; index < chunks.length; index++) {
        if (runtime.paused || runtime.generation !== epoch) throw new Error('Processing stopped; pending results were discarded.');
        const chunk = chunks[index].messages;
        updateRuntime({
            progress: { current: index + 1, total: chunks.length, from: chunk[0].index, to: chunk.at(-1).index, inputTokens: chunks[index].tokens },
            status: 'processing',
        });
        const result = await extractChunk(chunk);
        if (runtime.paused || runtime.generation !== epoch) throw new Error('Processing stopped; pending results were discarded.');
        await saveExtraction(job.worldId, result, {
            chatKey: job.chatKey,
            from: chunk[0].index,
            to: chunk.at(-1).index,
            allowStateUpdates: job.allowStateUpdates,
            messageFingerprints: chunk.map(message => ({ index: message.index, fingerprint: message.fingerprint })),
        });
        try {
            await buildNextArc(job.worldId, epoch);
            await buildNextEra(job.worldId, epoch);
        } catch (error) {
            console.warn('[Continuity] Non-destructive hierarchy generation was deferred.', error);
            updateRuntime({ arcStatus: 'L2/L3 hierarchy deferred; lower-level memory is safe.', arcError: error.message });
        }
    }
    return { chunks: chunks.length, messages: unseen.length, skipped };
}

async function processQueue() {
    if (runtime.processing || runtime.paused) return;
    const job = runtime.queue.shift();
    if (!job) return;
    const epoch = runtime.generation;
    updateRuntime({ processing: true, status: 'processing', lastStartedAt: new Date().toISOString(), lastError: '' });
    try {
        const result = await processRange(job, epoch);
        updateRuntime({ status: 'idle', lastCompletedAt: new Date().toISOString(), progress: null });
        job.resolve(result);
    } catch (error) {
        const stopped = /Processing stopped/.test(error.message);
        const rateLimited = isRateLimitError(error);
        updateRuntime({
            paused: runtime.paused || rateLimited,
            status: runtime.paused || rateLimited ? 'paused' : 'error',
            lastError: error.message,
            progress: null,
            lastValidation: stopped ? 'Stopped' : rateLimited ? 'Paused after rate limit; no failed messages were marked processed.' : `Failed: ${error.message}`,
        });
        job.reject(error);
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

export function enqueueRange({ from, to, worldId = getBoundWorldId(), allowStateUpdates = true, reason = 'manual', messageIndexes = null, sourceMessages = null, l1GroupSize = getSettings().extractionBatchMessages }) {
    if (!worldId) return Promise.reject(new Error('Select or create a world first.'));
    const chatKey = getChatKey();
    if (!chatKey) return Promise.reject(new Error('Open a chat first.'));
    return new Promise((resolve, reject) => {
        runtime.queue.push({ from: Number(from), to: Number(to), worldId, chatKey, allowStateUpdates, reason, messageIndexes, sourceMessages, l1GroupSize: resolveL1GroupSize(l1GroupSize), resolve, reject });
        updateRuntime({ status: runtime.paused ? 'paused' : 'queued' });
        processQueue();
    });
}

export function getProcessingCoverage(world = runtime.world, sourceMessages = null) {
    const chatKey = getChatKey();
    const chat = Array.isArray(sourceMessages) ? sourceMessages : (getContext().chat || []);
    if (!chatKey || !chat.length) {
        return { total: 0, latestIndex: -1, processed: 0, pending: 0, changed: 0, outdated: 0, neverProcessed: 0, pendingMessages: [], pendingRanges: [] };
    }
    const messages = Array.isArray(sourceMessages) ? sourceMessages : collectMemoryEligibleMessages(chat);
    return analyzeCoverage(messages, world?.sources?.[chatKey]?.processedMessages || []);
}

export function getBranchRepairStatus(world = runtime.world, sourceMessages = null) {
    const chatKey = getChatKey();
    if (!world || !chatKey) return { detected: false, earliestIndex: null, repairFrom: null, affectedExtractions: [] };
    const messages = Array.isArray(sourceMessages) ? sourceMessages : collectMemoryEligibleMessages(getContext().chat || []);
    return analyzeBranchDivergence(
        messages,
        world.sources?.[chatKey]?.processedMessages || [],
        world.extractions || [],
        chatKey,
    );
}

export async function repairDivergedBranch({ sourceMessages = null } = {}) {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) throw new Error('Open a chat with Continuity memory first.');
    await requireRetryStorage();
    const messages = Array.isArray(sourceMessages) ? sourceMessages : collectMemoryEligibleMessages(getContext().chat || []);
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    const divergence = getBranchRepairStatus(world, messages);
    if (!divergence.detected) return { repaired: false, repairFrom: null, retained: 0 };

    let repairFrom = divergence.repairFrom;
    let retained = (world.extractions || [])
        .filter(item => item.chatKey === chatKey && Number(item.to) < repairFrom)
        .sort((a, b) => Number(a.from) - Number(b.from));
    if (retained.some(item => !item.result || typeof item.result !== 'object')) {
        repairFrom = 0;
        retained = [];
    }
    const replay = targetWorld => {
        const previousWorld = structuredClone(targetWorld);
        removeChatContributions(targetWorld, chatKey);
        for (const item of retained) {
            mergeExtraction(targetWorld, item.result, {
                chatKey,
                from: Number(item.from),
                to: Number(item.to),
                allowStateUpdates: true,
                messageFingerprints: item.messageFingerprints || [],
            });
        }
        restoreRetainedReplayRecords(targetWorld, previousWorld, chatKey);
    };

    updateRuntime({ processing: true, status: 'repairing', lastError: '', retryStatus: `Removing stale memory from message ${repairFrom} onward before rebuilding the active branch…` });
    try {
        replay(world);
        try {
            world = (await api.saveWorld(world)).world;
        } catch (error) {
            if (error.status !== 409) throw error;
            world = (await api.getWorld(worldId)).world;
            replay(world);
            world = (await api.saveWorld(world)).world;
        }
        updateRuntime({ world, status: 'idle', progress: null, retryStatus: `Stale branch memory removed from message ${repairFrom} onward. Rebuilding from active messages…` });
        await embedWorldInChat(world);
        return { repaired: true, repairFrom, retained: retained.length, divergentIndexes: divergence.divergentIndexes };
    } catch (error) {
        updateRuntime({ status: 'error', progress: null, lastError: error.message, retryStatus: `Branch repair failed: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

export function getTailRollbackStatus(world = runtime.world) {
    const chatKey = getChatKey();
    const source = world?.sources?.[chatKey];
    if (!world || !chatKey || !source) return { detected: false, latestIndex: -1, removedMessages: 0, affectedExtractions: [] };
    return analyzeTailRollback(
        collectFingerprintMessages(getContext().chat || []),
        source.processedMessages || [],
        world.extractions || [],
        chatKey,
    );
}

export async function repairTailRollback({ allowChanged = false } = {}) {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) throw new Error('Open a chat with Continuity memory first.');
    await requireRetryStorage();
    let sourceWorld = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    const rollback = getTailRollbackStatus(sourceWorld);
    if (!rollback.detected) return { repaired: false, removedMessages: 0, replayed: 0, reextracted: 0 };
    const coverage = getProcessingCoverage(sourceWorld);
    if (coverage.changed && !allowChanged) throw new Error('This is not a pure tail rollback because retained messages also changed. Use Start over for this branch.');

    const retained = (sourceWorld.extractions || [])
        .filter(item => item.chatKey === chatKey && Number(item.to) <= rollback.latestIndex)
        .map(item => ({ result: item.result, from: Number(item.from), to: Number(item.to), messageFingerprints: item.messageFingerprints || [] }));
    const partial = [];
    const epoch = runtime.generation;
    updateRuntime({ processing: true, status: 'repairing', lastError: '', retryStatus: `Repairing rollback of ${rollback.removedMessages} tail message(s)…` });
    try {
        const crossing = rollback.affectedExtractions.filter(item => Number(item.from) <= rollback.latestIndex);
        for (let index = 0; index < crossing.length; index++) {
            const target = crossing[index];
            const messages = collectMessages(Number(target.from), Math.min(Number(target.to), rollback.latestIndex));
            if (!messages.length) continue;
            updateRuntime({
                progress: { current: index + 1, total: crossing.length, from: messages[0].index, to: messages.at(-1).index },
                retryStatus: `Re-extracting the retained edge of rollback range ${index + 1}/${crossing.length}…`,
            });
            const result = await extractChunk(messages);
            if (runtime.generation !== epoch) throw new Error('Rollback repair stopped; existing memory was left unchanged.');
            partial.push({
                result,
                from: messages[0].index,
                to: messages.at(-1).index,
                messageFingerprints: messages.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
            });
        }
        const replay = [...retained, ...partial].sort((a, b) => a.from - b.from || a.to - b.to);
        const apply = world => {
            removeChatContributions(world, chatKey);
            for (const item of replay) {
                mergeExtraction(world, item.result, {
                    chatKey,
                    from: item.from,
                    to: item.to,
                    allowStateUpdates: true,
                    messageFingerprints: item.messageFingerprints,
                });
            }
        };
        apply(sourceWorld);
        try {
            sourceWorld = (await api.saveWorld(sourceWorld)).world;
        } catch (error) {
            if (error.status !== 409) throw error;
            sourceWorld = (await api.getWorld(worldId)).world;
            apply(sourceWorld);
            sourceWorld = (await api.saveWorld(sourceWorld)).world;
        }
        updateRuntime({ world: sourceWorld, status: 'idle', progress: null, retryStatus: `Rollback repaired: removed ${rollback.removedMessages} deleted message(s), replayed ${replay.length} retained L1 range(s).` });
        await embedWorldInChat(sourceWorld);
        return { repaired: true, removedMessages: rollback.removedMessages, replayed: replay.length, reextracted: partial.length };
    } catch (error) {
        updateRuntime({ status: 'error', progress: null, lastError: error.message, retryStatus: `Rollback repair failed safely: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

export async function maybeAutoExtract(force = false, sourceMessages = null) {
    const settings = getSettings();
    if (!settings.enabled || (!settings.autoExtract && !force) || runtime.paused) return null;
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    const context = getContext();
    const activeMessages = Array.isArray(sourceMessages) ? sourceMessages : null;
    if (!worldId || !chatKey || !(activeMessages?.length || context.chat?.length)) return null;
    if (runtime.queue.some(job => job.chatKey === chatKey && job.reason === 'auto')) return null;

    let world = runtime.world?.id === worldId ? runtime.world : null;
    if (!world) {
        world = (await api.getWorld(worldId)).world;
        updateRuntime({ world });
    }
    const lastIndex = activeMessages?.at(-1)?.index ?? context.chat.length - 1;
    const source = world.sources?.[chatKey];
    const coverage = getProcessingCoverage(world, activeMessages);
    const groupSize = resolveL1GroupSize(settings.extractionBatchMessages);
    let pending = coverage.pendingMessages;
    if (!force) {
        if (source) {
            const processedIndexes = new Set((source.processedMessages || [])
                .filter(item => Number(item.version) === EXTRACTION_VERSION)
                .map(item => Number(item.index)));
            const lastProcessedIndex = Number(source.lastProcessedIndex ?? -1);
            // Automatic work includes genuinely new tail messages and edits to
            // messages already seen. Old never-processed history remains an
            // explicit user choice via Process all pending or Backfill.
            pending = pending.filter(message => processedIndexes.has(message.index) || message.index > lastProcessedIndex);
        }
        // The shared eligible-message view already omits the provisional
        // newest AI reply from every automatic and forced CM path.
        pending = selectAutomaticL1Messages(pending, groupSize, !source);
    } else {
        pending = completeL1Messages(pending, groupSize);
    }
    if (!pending.length) return null;
    return enqueueRange({
        from: pending[0].index,
        to: pending.at(-1).index,
        worldId,
        allowStateUpdates: pending.at(-1).index >= coverage.latestIndex,
        reason: force ? 'pending' : 'auto',
        messageIndexes: pending.map(message => message.index),
        sourceMessages: activeMessages,
    });
}

export async function loadBoundWorld() {
    const worldId = getBoundWorldId();
    if (!worldId) {
        updateRuntime({ world: null });
        return null;
    }
    const world = (await api.getWorld(worldId)).world;
    updateRuntime({ world });
    await embedWorldInChat(world);
    return world;
}

export function continueQueue() {
    processQueue();
}

export async function testExtractor() {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    updateRuntime({ status: 'testing', lastError: '', lastValidation: 'Testing active API…' });
    try {
        const result = await extractChunk([
            { index: 0, name: 'Alice', text: 'I always take my tea without sugar.' },
            { index: 1, name: 'Bob', text: 'I will remember that for our picnic tomorrow.' },
        ]);
        updateRuntime({ status: 'idle', lastValidation: `Extractor healthy: ${result.facts.length} fact(s), ${result.threads.length} open-thread candidate(s).` });
        return result;
    } catch (error) {
        updateRuntime({ status: 'error', lastError: error.message, lastValidation: `Extractor test failed: ${error.message}` });
        throw error;
    }
}
