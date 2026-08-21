import { extractMessageFromData, generateRaw, getRequestHeaders } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { getTokenCountAsync } from '/scripts/tokenizers.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { oai_settings, openai_setting_names, openai_settings, proxies } from '/scripts/openai.js';
import { api } from './api.js';
import { analyzeBranchDivergence, analyzeCoverage, analyzeTailRollback, EXTRACTION_VERSION } from './coverage.js';
import { isRateLimitError, isTransientApiError } from './errors.js';
import { collectFingerprintMessages, collectMemoryEligibleMessages, findChangedExtractions, fingerprintMessage } from './message-digest.js?v=0.14.0-standalone.237';
import { resolveExtractionChunk } from './extraction-budget.js';
import { nextArcCapsules } from './hierarchy-policy.js';
import { completeL1Messages, latestCompleteL1MessageIndex, l1StabilityRepairFrom, L1_STABILITY_BUFFER_MESSAGES, partitionL1StabilityBuffer, partitionPendingL1Messages, resolveL1GroupSize, selectAutomaticL1Messages } from './l1-policy.js';
import { applyCorrectionProposal, augmentCorrectionChronology, selectCorrectionContext, validateCorrectionProposal } from './memory-correction.js';
import { resolveCorrectionResponseTokens } from './correction-policy.js';
import { isExplicitExtractionOutputLimitError, processAdaptiveExtractionChunks } from './extraction-recovery.js?v=0.14.0-standalone.237';
import { requestExtractionReview } from './extraction-review.js';
import { migrateLegacyBeliefs } from './attributed-beliefs.js';
import { addDerivedArc, addDerivedEra, compactDuplicateMemoryRecords, freshResetResiduals, getLatestL1UndoStatus as inspectLatestL1Undo, mergeExtraction, promoteStoredTailSnapshot, removeChatContributions, replaceExtraction, resetWorldHierarchy, resetWorldMemory, restoreRetainedReplayRecords, undoLatestL1Extraction } from './memory-model.js';
import { memoryResponseTokens, resolveMemoryResponseTokens, storyResponseTokens } from './memory-response-policy.js';
import { outputTokenPayload } from './model-compatibility.js?v=0.14.0-standalone.237';
import { formatExtractionMessages, precedingUserAttributionContext } from './extraction-context.js?v=0.14.0-standalone.237';
import { embedWorldInChat } from './portable.js';
import { connectionProfileModel, isolatedProfileOptions, isolatedProfilePayload } from './profile-request-policy.js?v=0.14.0-standalone.237';
import { buildExtractionSystemPrompt, buildHierarchySystemPrompt, DEFAULT_ARC_SYSTEM_PROMPT, DEFAULT_ARC_TASK_TEMPLATE, DEFAULT_ERA_SYSTEM_PROMPT, DEFAULT_ERA_TASK_TEMPLATE, DEFAULT_EXTRACTION_SYSTEM_PROMPT, DEFAULT_EXTRACTION_TASK_TEMPLATE, ROLLING_STORY_RULE, ROLLING_STORY_TASK_TEMPLATE, renderPromptTemplate } from './prompts.js?v=0.14.0-standalone.237';
import { applySourceAttributionFailClosed, canonicalFactReference, removeInvalidStoredAddressFacts, sanitizeReconciliationMetadata } from './reconciliation-policy.js';
import { getBoundWorldId, getChatKey, getSettings } from './settings.js?v=0.14.0-standalone.237';
import { buildThinkingRequest, isMandatoryThinkingError, isThinkingControlError, shouldSendStructuredSchema, thinkingControlFallbackPayload } from './thinking-policy.js?v=0.14.0-standalone.237';
import { isRuntimeCancellation, onRuntimeStop, RUNTIME_CANCELLED_CODE, runtime, updateRuntime } from './runtime.js?v=0.14.0-standalone.237';
import { completedDetachedWorldIsNewer, detachedProgressNeedsRefresh, latestCompletedDetachedJob } from './detached-reconnect-policy.js?v=0.14.0-standalone.237';
import { isActiveState, latestSourceRange } from './state-lifecycle.js';
import { temporalContext } from './temporal-anchors.js';
import { dynamicStorySourceChunk, resolveStoryBudget, storyWithinAllowance } from './story-budget.js?v=0.14.0-standalone.237';
import { storyCompressionTarget, storyGenerationTargets } from './story-output-policy.js?v=0.14.0-standalone.237';
import { resolveStoryRequestProfile } from './story-profile.js?v=0.14.0-standalone.237';
import { resolveProfileThinkingMode } from './story-thinking.js?v=0.14.0-standalone.237';
import { completeStoryMessages, resolveStoryBatchMessages, rollingStoryBuildPlan, rollingStoryRebuildCheckpoint, rollingStoryRebuildPlan, stableStoryMessages, storyChunkMessageLimit } from './story-cadence.js?v=0.14.0-standalone.237';
import { compileRollingStorySnapshot, ROLLING_STORY_SNAPSHOT_EXAMPLE, ROLLING_STORY_SNAPSHOT_SCHEMA } from './story-snapshot.js?v=0.14.0-standalone.237';
import { planStoryMutationRecovery, withStoryCheckpoint } from './story-checkpoints.js?v=0.14.0-standalone.237';
import { buildStorySourceUnits, resolveStorySourceMode, storedStorySourceMode, storySourceModeLabel, STORY_SOURCE_L1 } from './story-source.js?v=0.14.0-standalone.237';
import { DIRECT_PROFILE_ID } from './direct-profile.js?v=0.14.0-standalone.237';

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
                required: ['targetId', 'name', 'type', 'aliases', 'description', 'characterProfile', 'importance'],
                properties: {
                    targetId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } },
                    description: { type: 'string', description: 'Durable description for a non-person entity. Leave empty for a person; characterProfile is validated and formatted into the stored description.' },
                    characterProfile: {
                        type: 'object', additionalProperties: false,
                        required: ['roleBackground', 'ageDemographics', 'appearance', 'personalityQuirks'],
                        properties: {
                            roleBackground: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic established roles, identity-defining history, and durable social functions grammatically attributed to this named person. Never copy a nearby person. Ground in narrative or accepted memory, never status/control-panel fields. Empty when unknown or not a person.' },
                            ageDemographics: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic established age, life-stage, and demographic identity details grammatically attributed to this named person. Never treat age as personality or copy another person. Ground in narrative or accepted memory, never status/control-panel fields. Exclude guesses unless the narrative itself establishes the estimate.' },
                            appearance: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic concise physical traits grammatically attributed to this named person. Never copy another person, an internal reaction, or narrative action. Ground in narrative or accepted memory, never status/control-panel fields. Exclude temporary clothing, wounds, emotion, and pose.' },
                            personalityQuirks: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic established recurring temperament, habits, speech patterns, and quirks grammatically attributed to this named person. Never copy another person or a physical comparison. Ground in narrative or accepted memory, never status/control-panel fields. Exclude one-off reactions.' },
                        },
                    },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
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
    description: 'Structured continuity memory extracted from a roleplay or simulation excerpt of any genre. All canonical prose uses explicit names and third person, never first/second person or player-facing advice.',
    strict: true,
    returnInvalid: true,
    value: extractionSchema,
});

const rollingStoryJsonSchema = Object.freeze({
    name: 'continuity_rolling_story',
    description: 'A bounded world-state snapshot with foundational premises, chronological major developments, state at the covered boundary, and unresolved central matters.',
    strict: true,
    returnInvalid: true,
    value: ROLLING_STORY_SNAPSHOT_SCHEMA,
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
    description: 'A non-destructive L2 record derived from chronological L1 records. Canonical prose uses explicit names and third person.',
    strict: true,
    returnInvalid: true,
    value: arcSchema,
});

const eraJsonSchema = Object.freeze({
    name: 'continuity_l3_era',
    description: 'A non-destructive L3 record derived from chronological L2 records. Canonical prose uses explicit names and third person.',
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
The correction is authoritative only for the scope it states. Distinguish established facts from attributed facts whose category is "character belief". "That never happened" can change facts, events, and chronology; "Alice was wrong about it" changes only the fact about Alice's belief and does not establish what actually happened. "Bob was never told" adds or updates a persistent fact with Bob as subject, predicate "knowledge of CANONICAL_TOPIC", category "knowledge boundary", and an explicit value describing what Bob does not know; it may also add or update one open thread when the pending reveal is consequential. "Bob learned it" updates that same boundary fact to the established knowledge state and resolves the thread. If the roleplay has not established what happened, do not invent a fact or event about it.
Change only records that conflict with the correction or are necessary to preserve it.
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
    entities: [{ targetId: '', name: '', type: '', aliases: [], description: '', characterProfile: { roleBackground: '', ageDemographics: '', appearance: '', personalityQuirks: '' }, importance: 3 }],
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
const watchedDetachedJobs = new Set();
const activeDetachedJobs = new Set();

onRuntimeStop(async () => {
    const ids = [...activeDetachedJobs];
    await Promise.allSettled(ids.map(id => api.cancelExtractionJob(id)));
});

export function applyExtractionRequestSettings(data) {
    if (!activeExtractionThinkingMode || !data || typeof data !== 'object') return;
    const control = buildThinkingRequest({
        mode: activeExtractionThinkingMode,
        source: data.chat_completion_source,
        model: data.model,
        url: data.custom_url || data.reverse_proxy,
    });
    Object.assign(data, outputTokenPayload(data.model, resolveMemoryResponseTokens(data.max_tokens ?? data.max_completion_tokens, control.adapter)), control.payload);
    if (!shouldSendStructuredSchema(control.adapter, data.json_schema)) delete data.json_schema;
    updateRuntime({ thinkingControl: { mode: activeExtractionThinkingMode, adapter: control.adapter, fallback: false } });
}

export async function generateWithThinkingPolicy(options, thinkingMode = getSettings().thinkingMode) {
    thinkingMode = resolveThinkingModeForProfile(thinkingMode);
    activeExtractionThinkingMode = thinkingMode;
    try {
        try {
            return await generateRaw(options);
        } catch (error) {
            const mandatory = isMandatoryThinkingError(error);
            if (!isThinkingControlError(error) || (activeExtractionThinkingMode === 'default' && !mandatory)) throw error;
            console.warn(`[Continuity] Endpoint rejected its detected thinking control; retrying with ${mandatory ? 'mandatory reasoning enabled' : 'the provider default'}.`, error);
            updateRuntime({ thinkingControl: { mode: activeExtractionThinkingMode, adapter: mandatory ? 'mandatory-reasoning' : 'provider-default', fallback: true } });
            activeExtractionThinkingMode = mandatory ? 'minimum' : 'default';
            return await generateRaw(options);
        }
    } finally {
        activeExtractionThinkingMode = null;
    }
}

function formatMessages(messages) {
    return formatExtractionMessages(messages);
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
        messages.push({
            index,
            name: message.name || (message.is_user ? 'User' : 'Character'),
            text: body,
            isUser: Boolean(message.is_user),
        });
    }
    return messages;
}

async function chunkMessages(messages, tokenLimit, maxMessages = Infinity, firstTokenLimit = tokenLimit) {
    const chunks = [];
    let chunk = [];
    let tokens = 0;
    for (const message of messages) {
        const sourceFrom = Number(message?.sourceFrom ?? message?.index);
        const discontinuous = chunk.length && sourceFrom > Number(chunk.at(-1)?.index) + 1;
        const candidate = discontinuous ? [message] : [...chunk, message];
        const candidateTokens = await getTokenCountAsync(formatMessages(candidate));
        const activeTokenLimit = chunks.length ? tokenLimit : firstTokenLimit;
        if (chunk.length && (candidateTokens > activeTokenLimit || candidate.length > maxMessages || discontinuous)) {
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

function validateResult(result, world, messages) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Extractor returned no JSON object.');
    if (!Array.isArray(result.facts)) throw new Error('Extractor field "facts" is not an array.');
    migrateLegacyBeliefs(result);
    if (!result.sceneCapsule || typeof result.sceneCapsule !== 'object' || !Array.isArray(result.sceneCapsule.beats)) {
        throw new Error('Extractor returned no valid chronological scene capsule.');
    }
    for (const key of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']) {
        if (!Array.isArray(result[key])) throw new Error(`Extractor field "${key}" is not an array.`);
    }
    const validation = sanitizeReconciliationMetadata(result, world, messages);
    return { result, validation };
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
    }).slice(0, 30).map(entity => ({
        targetId: entity.id,
        name: entity.name,
        aliases: entity.aliases || [],
        description: String(entity.description || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    }));
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
        item => [item.subject], 18).map(canonicalFactReference);
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
    const snapshot = Object.fromEntries(Object.entries({
        canonicalEntities: entities,
        activeStates: active.map(({ item }) => ({
            targetId: item.id,
            subject: item.subject,
            attribute: item.attribute,
            value: item.value,
            scope: item.scope,
        })),
        knownFacts: facts,
        canonicalRelationships: relationships,
        knownThreads: activeThreads,
        knownBackgrounds: backgrounds,
    }).filter(([, records]) => records.length));
    if (!Object.keys(snapshot).length) return '';
    return `KNOWN CONTINUITY RECORDS (facts categorized as "character belief" are subjective, not established facts):\n${JSON.stringify(snapshot)}\nUse targetId for updates, omit unchanged records, and preserve canonical identity fields.`;
}

function extractionTemporalContext(world) {
    const anchors = temporalContext(world, getChatKey());
    if (!anchors.length) return '';
    return `TEMPORAL ANCHORS:\n${JSON.stringify(anchors)}\nUse only these anchors; never infer elapsed time from message or extraction order.`;
}

async function extractChunk(messages, world = runtime.world) {
    const prepared = prepareExtractionPrompts(messages, world);
    const { prompt, fallbackPrompt, systemPrompt } = prepared;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const raw = await requestExtraction(prompt, systemPrompt, fallbackPrompt);
            updateRuntime({ lastRawResponse: String(raw).slice(0, 30000) });
            const parsed = typeof raw === 'string' ? parseJsonResponse(raw) : raw;
            const { result, validation } = validateResult(parsed, world, messages);
            const failedClosedRecords = applySourceAttributionFailClosed(result, [
                ...(validation.sourceAttributionConflicts || []),
                ...(validation.relationshipEndpointConflicts || []),
            ]);
            const recovered = Number(validation.recovered || 0)
                + Number(validation.recoveredAliases || 0)
                + Number(validation.recoveredBoundaries || 0)
                + Number(validation.recoveredKnowledge || 0)
                + Number(validation.recoveredIdentities || 0)
                + Number(validation.recoveredCoverage || 0)
                + Number(validation.reconciledThreads || 0);
            const repaired = Number(validation.repairedAddresses || 0);
            const discarded = Number(validation.discardedAddressValues || 0);
            const unsupported = Number(validation.discardedUnsupportedAddresses || 0);
            const pronouns = Number(validation.discardedPronounAddresses || 0);
            const reconciled = Number(validation.reconciledAddresses || 0);
            const normalizedRelationships = Number(validation.normalizedRelationshipDescriptions || 0);
            const normalizedEpistemicFacts = Number(validation.normalizedEpistemicFacts || 0);
            const stateTransitions = Number(validation.reconciledStateTransitions || 0);
            const discardedProfileDetails = Number(validation.discardedCharacterProfileDetails || 0);
            const warnings = validation.warnings?.length || 0;
            updateRuntime({
                lastValidation: `Valid structured extraction${attempt > 1 ? ' after malformed-output retry' : ''}${recovered ? `; recovered ${recovered} omitted durable record(s)` : ''}${normalizedEpistemicFacts ? `; normalized ${normalizedEpistemicFacts} attributed fact(s)` : ''}${normalizedRelationships ? `; completed ${normalizedRelationships} relationship description(s)` : ''}${stateTransitions ? `; reconciled ${stateTransitions} state transition(s)` : ''}${discardedProfileDetails ? `; withheld ${discardedProfileDetails} unsupported character-profile detail(s)` : ''}${failedClosedRecords ? `; withheld ${failedClosedRecords} unsafe objective or identity record(s)` : ''}${repaired ? `; repaired ${repaired} reversed address value(s)` : ''}${discarded ? `; discarded ${discarded} cross-direction address value(s)` : ''}${unsupported ? `; discarded ${unsupported} unsupported address value(s)` : ''}${pronouns ? `; discarded ${pronouns} unsupported pronoun address value(s)` : ''}${reconciled ? `; reconciled ${reconciled} duplicate address record(s)` : ''}${warnings ? `; ${warnings} diagnostic continuity warning(s)` : ''}`,
            });
            return result;
        } catch (error) {
            lastError = error;
            updateRuntime({ lastValidation: `Extraction attempt ${attempt}/2 failed: ${error.message}` });
            if (isRateLimitError(error)) throw new Error(`Rate limited; this chunk remains pending. Resume processing after the endpoint recovers.`, { cause: error });
            if (isExplicitExtractionOutputLimitError(error)) throw error;
        }
    }
    throw new Error(`Structured extraction failed twice: ${lastError?.message || 'unknown error'}`);
}

function prepareExtractionPrompts(messages, world = runtime.world) {
    const settings = getSettings();
    const detail = settings.detail;
    const detailInstruction = detail === 'light'
        ? 'Capture only details likely to matter again.'
        : detail === 'detailed'
            ? 'Capture subtle recurring details, conditions, relationships, routines, rules, resources, and small changes as well as major developments, using whatever categories fit this scenario.'
            : 'Capture major developments and useful recurring or persistent details without recording filler.';
    const profileId = settings.memoryProfileId;
    const usesStructuredSchema = requestSupportsStructuredSchema(extractionJsonSchema, profileId, 'extraction');
    const taskTemplate = settings.extractionTaskTemplate ?? DEFAULT_EXTRACTION_TASK_TEMPLATE;
    const attributionContext = precedingUserAttributionContext(getContext().chat || [], messages);
    const taskValues = {
        detail: detailInstruction,
        messages: formatExtractionMessages(messages, attributionContext),
        story_so_far: '',
        active_states: extractionStateContext(world, messages),
        temporal_context: extractionTemporalContext(world),
    };
    const prompt = renderStructuredTaskPrompt(taskTemplate, DEFAULT_EXTRACTION_TASK_TEMPLATE, taskValues, JSON_SHAPE_EXAMPLE, usesStructuredSchema, ['messages', 'active_states', 'temporal_context']);
    const fallbackPrompt = usesStructuredSchema
        ? renderStructuredTaskPrompt(taskTemplate, DEFAULT_EXTRACTION_TASK_TEMPLATE, taskValues, JSON_SHAPE_EXAMPLE, false, ['messages', 'active_states', 'temporal_context'])
        : prompt;
    return {
        prompt,
        fallbackPrompt,
        systemPrompt: buildExtractionSystemPrompt(settings.extractionSystemPrompt, settings.jbEnabled, settings.jbPrompt),
        usesStructuredSchema,
    };
}

async function requestExtraction(prompt, systemPrompt, fallbackPrompt = prompt) {
    return requestStructured(prompt, systemPrompt, extractionJsonSchema, memoryResponseTokens('l1'), undefined, 'extraction', fallbackPrompt);
}

function directRequestConfig(kind) {
    const settings = getSettings();
    const category = ['extraction', 'retrieval', 'story', 'correction', 'summary'].includes(kind) ? kind : 'extraction';
    const label = category === 'summary' ? 'summarizer' : category;
    const provider = settings[`${category}DirectProvider`] === 'openrouter' ? 'openrouter' : 'custom';
    const url = provider === 'openrouter'
        ? settings[`${category}OpenRouterUrl`] || 'https://openrouter.ai/api/v1'
        : settings[`${category}DirectUrl`] || 'https://api.openai.com/v1';
    const model = provider === 'openrouter'
        ? settings[`${category}OpenRouterModel`]
        : settings[`${category}DirectModel`];
    const secretId = settings[provider === 'openrouter' ? `${category}OpenRouterSecretId` : `${category}DirectSecretId`] || '';
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error(`Enter a valid ${label} API URL.`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Direct API URLs must use HTTP or HTTPS.');
    if (!String(model || '').trim()) throw new Error(`Enter a ${label} model ID.`);
    return { provider, url: parsed.toString().replace(/\/$/, ''), model: String(model).trim(), secretId };
}

export function resolveThinkingModeForProfile(configuredMode, profileId = '') {
    const profile = profileId && profileId !== DIRECT_PROFILE_ID
        ? ConnectionManagerRequestService.getProfile(profileId)
        : null;
    return resolveProfileThinkingMode(
        configuredMode,
        profile,
        openai_setting_names,
        openai_settings,
        oai_settings?.reasoning_effort,
    );
}

function requestSupportsStructuredSchema(jsonSchema, profileId = getSettings().memoryProfileId, directKind = 'extraction', thinkingMode = getSettings().thinkingMode) {
    if (!profileId) return false;
    thinkingMode = resolveThinkingModeForProfile(thinkingMode, profileId);
    if (profileId === DIRECT_PROFILE_ID) {
        const config = directRequestConfig(directKind);
        const thinking = buildThinkingRequest({
            mode: thinkingMode,
            source: config.provider === 'openrouter' ? 'openrouter' : 'custom',
            model: config.model,
            url: config.url,
        });
        return shouldSendStructuredSchema(thinking.adapter, jsonSchema);
    }
    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const apiMap = ConnectionManagerRequestService.validateProfile(profile);
    const model = connectionProfileModel(profile);
    const thinking = buildThinkingRequest({
        mode: thinkingMode,
        source: apiMap.source,
        model,
        url: profile['api-url'],
        profileName: profile.name,
    });
    return shouldSendStructuredSchema(thinking.adapter, jsonSchema);
}

function renderStructuredTaskPrompt(template, defaultTemplate, values, schemaExample, usesStructuredSchema, required = []) {
    const source = String(template ?? defaultTemplate);
    const usesFormatPlaceholder = source.includes('{{format}}');
    const format = usesStructuredSchema
        ? 'Return one schema-valid JSON object with all required keys.'
        : `Return one JSON object with this exact shape and all keys:\n${schemaExample}`;
    return renderPromptTemplate(source, {
        ...values,
        format,
        // Preserve custom legacy templates that explicitly use {{schema}}.
        schema: schemaExample,
    }, [usesFormatPlaceholder ? 'format' : 'schema', ...required]);
}

async function requestDirectStructured(prompt, systemPrompt, jsonSchema, responseLength, kind, withSchema = true, thinkingMode = getSettings().thinkingMode) {
    thinkingMode = resolveThinkingModeForProfile(thinkingMode, DIRECT_PROFILE_ID);
    const config = directRequestConfig(kind);
    const thinking = buildThinkingRequest({
        mode: thinkingMode,
        source: config.provider === 'openrouter' ? 'openrouter' : 'custom',
        model: config.model,
        url: config.url,
    });
    const body = {
        chat_completion_source: config.provider,
        model: config.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        stream: false,
        ...outputTokenPayload(config.model, resolveMemoryResponseTokens(responseLength, thinking.adapter)),
        ...(config.provider === 'openrouter'
            ? { api_url: config.url, secret_id: config.secretId || undefined }
            : { custom_url: config.url, secret_id: config.secretId || undefined }),
        ...(withSchema && shouldSendStructuredSchema(thinking.adapter, jsonSchema) ? { json_schema: jsonSchema } : {}),
        ...thinking.payload,
    };
    updateRuntime({ thinkingControl: { mode: thinkingMode, adapter: thinking.adapter, fallback: false } });
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
    assertCompletionNotTruncated(payload, `Direct ${kind} API`);
    const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
    const result = Array.isArray(content) ? content.map(item => item?.text || '').join('') : content;
    if (!String(result || '').trim()) throw new Error(`Direct ${kind} API returned no text.`);
    return String(result);
}

function reviewStatus(review) {
    if (review.layer === 'L1') return `Review L1 extracted memory for messages ${review.from}–${review.to} before it is saved.`;
    const sourceLayer = review.layer === 'L3' ? 'L2' : 'L1';
    return `Review ${review.layer} summary from ${review.sourceCount} ${sourceLayer} record(s) before it is saved.`;
}

async function reviewMemoryBeforeSave(result, meta, validate, regenerate = null) {
    if (!getSettings().reviewBeforeCommit) return result;
    return await requestExtractionReview({
        result,
        meta,
        validate,
        regenerate,
        onPending: review => updateRuntime({
            pendingExtractionReview: review,
            status: review.phase === 'regenerating' ? 'regenerating-review' : 'awaiting-review',
            retryStatus: review.phase === 'regenerating' ? `Regenerating ${review.layer} candidate…` : reviewStatus(review),
        }),
        onSettled: () => updateRuntime({ pendingExtractionReview: null }),
    });
}

async function reviewExtractionBeforeSave(result, world, messages, meta = {}, regenerate = null) {
    return reviewMemoryBeforeSave(result, { ...meta, layer: 'L1' }, candidate => validateResult(candidate, world, messages).result, regenerate);
}

async function reviewHierarchyBeforeSave(result, layer, sources, reason = 'hierarchy', regenerate = null) {
    const ranges = (sources || []).flatMap(item => [Number(item?.from), Number(item?.to)]).filter(Number.isFinite);
    return reviewMemoryBeforeSave(result, {
        layer,
        reason,
        sourceCount: sources?.length || 0,
        from: ranges.length ? Math.min(...ranges) : 0,
        to: ranges.length ? Math.max(...ranges) : 0,
    }, candidate => validateArcResult(candidate, layer), regenerate);
}

function completionFinishReason(payload) {
    return String(
        payload?.choices?.[0]?.finish_reason
        ?? payload?.data?.choices?.[0]?.finish_reason
        ?? payload?.response?.choices?.[0]?.finish_reason
        ?? '',
    ).trim().toLocaleLowerCase();
}

function assertCompletionNotTruncated(payload, label) {
    const reason = completionFinishReason(payload);
    if (reason === 'length' || reason === 'max_tokens') {
        throw new Error(`${label} reached its output limit (finish_reason: ${reason}).`);
    }
}

function extractProfileResponse(response, apiMap, profileName) {
    assertCompletionNotTruncated(response, `Connection profile “${profileName}”`);
    const result = extractMessageFromData(response, apiMap.selected);
    if (!result || typeof result !== 'string') throw new Error(`Connection profile “${profileName}” returned no text.`);
    return result;
}

export async function requestDirectText(prompt, systemPrompt, responseLength = 300, kind = 'extraction', thinkingMode = getSettings().thinkingMode) {
    return requestDirectStructured(prompt, systemPrompt, null, responseLength, kind, false, thinkingMode);
}

async function requestStructured(prompt, systemPrompt, jsonSchema, responseLength = null, profileId = getSettings().memoryProfileId, directKind = 'extraction', fallbackPrompt = prompt, thinkingMode = getSettings().thinkingMode) {
    thinkingMode = resolveThinkingModeForProfile(thinkingMode, profileId);
    if (profileId === DIRECT_PROFILE_ID) {
        let directThinkingMode = thinkingMode;
        try {
            return await requestDirectStructured(prompt, systemPrompt, jsonSchema, responseLength, directKind, true, directThinkingMode);
        } catch (error) {
            const mandatory = isMandatoryThinkingError(error);
            if (isThinkingControlError(error) && (mandatory || !['auto', 'default'].includes(directThinkingMode))) {
                directThinkingMode = mandatory ? 'minimum' : 'default';
                updateRuntime({ thinkingControl: { mode: thinkingMode, adapter: mandatory ? 'mandatory-reasoning' : 'provider-default', fallback: true } });
                try {
                    return await requestDirectStructured(prompt, systemPrompt, jsonSchema, responseLength, directKind, true, directThinkingMode);
                } catch (retryError) {
                    error = retryError;
                }
            }
            if (!shouldRetryWithoutSchema(error)) throw error;
            updateRuntime({ lastValidation: `Direct API JSON mode unavailable; using compatible plain mode: ${rootErrorMessage(error)}` });
            return requestDirectStructured(fallbackPrompt, systemPrompt, jsonSchema, responseLength, directKind, false, directThinkingMode);
        }
    }
    if (!profileId) {
        try {
            return await generateWithThinkingPolicy({ prompt, systemPrompt, responseLength, jsonSchema }, thinkingMode);
        } catch (error) {
            if (!shouldRetryWithoutSchema(error)) throw error;
            console.warn('[Continuity] Native structured output failed; retrying with plain JSON prompting.', error);
            updateRuntime({ lastValidation: `Native JSON mode unavailable; using compatible plain mode: ${rootErrorMessage(error)}` });
            return await generateWithThinkingPolicy({ prompt: fallbackPrompt, systemPrompt, responseLength }, thinkingMode);
        }
    }

    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const apiMap = ConnectionManagerRequestService.validateProfile(profile);
    const model = connectionProfileModel(profile);
    const messagesFor = userPrompt => [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
    const messages = messagesFor(prompt);
    const options = isolatedProfileOptions();
    const thinking = buildThinkingRequest({
        mode: thinkingMode,
        source: apiMap.source,
        model,
        url: profile['api-url'],
        profileName: profile.name,
    });
    const profileResponseLength = resolveMemoryResponseTokens(responseLength, thinking.adapter) ?? undefined;
    let thinkingPayload = thinking.payload;
    updateRuntime({ thinkingControl: { mode: thinkingMode, adapter: thinking.adapter, fallback: false } });
    const compatibilityPayload = () => isolatedProfilePayload({
        ...outputTokenPayload(model, responseLength),
        ...thinkingPayload,
    });
    let response;
    if (!shouldSendStructuredSchema(thinking.adapter, jsonSchema)) {
        updateRuntime({ lastValidation: 'Gemini native schema omitted; using compatible exact-shape JSON prompting.' });
        try {
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messagesFor(fallbackPrompt), profileResponseLength, options, compatibilityPayload(),
            );
        } catch (error) {
            if (!isThinkingControlError(error) || (!thinking.controlled && !isMandatoryThinkingError(error))) throw error;
            thinkingPayload = thinkingControlFallbackPayload(error, thinkingPayload);
            updateRuntime({ thinkingControl: { mode: thinkingMode, adapter: thinking.adapter, fallback: true } });
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messagesFor(fallbackPrompt), profileResponseLength, options, compatibilityPayload(),
            );
        }
        return extractProfileResponse(response, apiMap, profile.name);
    }
    try {
        response = await ConnectionManagerRequestService.sendRequest(
            profileId, messages, profileResponseLength, options, { ...compatibilityPayload(), json_schema: jsonSchema },
        );
    } catch (error) {
        if (isThinkingControlError(error) && (thinking.controlled || isMandatoryThinkingError(error))) {
            console.warn(`[Continuity] ${thinking.adapter} rejected its thinking policy; retrying with a compatible policy.`, error);
            thinkingPayload = thinkingControlFallbackPayload(error, thinkingPayload);
            updateRuntime({ thinkingControl: { mode: thinkingMode, adapter: thinking.adapter, fallback: true } });
            try {
                response = await ConnectionManagerRequestService.sendRequest(
                    profileId, messages, profileResponseLength, options, { ...compatibilityPayload(), json_schema: jsonSchema },
                );
            } catch (retryError) {
                error = retryError;
            }
            if (response) {
                return extractProfileResponse(response, apiMap, profile.name);
            }
        }
        if (!shouldRetryWithoutSchema(error)) throw error;
        console.warn('[Continuity] Connection profile rejected native structured output; retrying with plain JSON prompting.', error);
        updateRuntime({ lastValidation: `Profile JSON mode unavailable; using compatible plain mode: ${rootErrorMessage(error)}` });
        try {
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messagesFor(fallbackPrompt), profileResponseLength, options, compatibilityPayload(),
            );
        } catch (plainError) {
            if (!isThinkingControlError(plainError) || (!Object.keys(thinkingPayload).length && !isMandatoryThinkingError(plainError))) throw plainError;
            thinkingPayload = thinkingControlFallbackPayload(plainError, thinkingPayload);
            updateRuntime({ thinkingControl: { mode: thinkingMode, adapter: thinking.adapter, fallback: true } });
            response = await ConnectionManagerRequestService.sendRequest(
                profileId, messagesFor(fallbackPrompt), profileResponseLength, options, compatibilityPayload(),
            );
        }
    }
    return extractProfileResponse(response, apiMap, profile.name);
}

function storyRetryableError(error) {
    return isTransientApiError(error)
        || /empty rolling story|invalid json|no json object|unexpected end|reached its output limit|finish_reason:\s*(?:length|max_tokens)|exceeded its \d+-token allowance/i.test(String(error?.message || ''));
}

async function regenerateRollingStory(priorStory, messages, expectedEpoch = runtime.storyGeneration) {
    const settings = getSettings();
    const allowance = resolveStoryBudget(settings.storySoFarTokens, getContext().maxContext).tokens;
    const { profileId, directKind } = resolveStoryRequestProfile(settings, DIRECT_PROFILE_ID);
    const thinkingMode = resolveThinkingModeForProfile(settings.storyThinkingMode, profileId);
    const usesStructuredSchema = requestSupportsStructuredSchema(rollingStoryJsonSchema, profileId, directKind, thinkingMode);
    const generationTargets = storyGenerationTargets(allowance);
    const values = {
        allowance,
        ...generationTargets,
        prior: String(priorStory || '').trim() || '(No prior story yet.)',
        messages: formatExtractionMessages(messages),
        format: usesStructuredSchema
            ? 'Return one schema-valid JSON object.'
            : `Return one JSON object with this exact shape: ${ROLLING_STORY_SNAPSHOT_EXAMPLE}`,
    };
    const prompt = renderPromptTemplate(ROLLING_STORY_TASK_TEMPLATE, values, ['prior', 'messages']);
    const fallbackPrompt = renderPromptTemplate(ROLLING_STORY_TASK_TEMPLATE, {
        ...values,
        format: `Return one JSON object with this exact shape: ${ROLLING_STORY_SNAPSHOT_EXAMPLE}`,
    }, ['prior', 'messages']);
    let lastError;
    let oversizedCandidate = '';
    let compressionPass = 0;
    const maximumAttempts = 6;
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
        if (runtime.storyGeneration !== expectedEpoch) {
            const error = new Error('Rolling-story request was stopped before retrying.');
            error.code = RUNTIME_CANCELLED_CODE;
            throw error;
        }
        try {
            const previousFailure = String(lastError?.message || '');
            const retryRequirement = attempt <= 1 ? ''
                : /exceeded its \d+-token allowance/i.test(previousFailure)
                    ? ''
                    : `\n\nRETRY REQUIREMENT: The provider ended the previous response before valid completion. Return complete valid JSON and compress storySoFar to at most ${allowance} tokens.`;
            const compressionTarget = storyCompressionTarget(allowance, compressionPass || 1);
            const compressionPrompt = oversizedCandidate
                ? `Rewrite the complete candidate world-state snapshot below into the same four JSON arrays. Preserve its full causal span, foundational secrets, durable state, and open matters, but remove redundancy and lower-value detail. Aim for at most ${compressionTarget} tokens by your estimate so the result remains safely below the absolute ${allowance}-token limit under SillyTavern's tokenizer. Never clip, truncate, use an ellipsis, or leave a thought incomplete. Return only the complete requested JSON object; do not introduce facts.\n${values.format}\n\nOVERSIZED COMPLETE CANDIDATE:\n${oversizedCandidate}`
                : '';
            const compressionFallbackPrompt = oversizedCandidate
                ? `Rewrite the complete candidate world-state snapshot below into the same four JSON arrays. Preserve its full causal span, foundational secrets, durable state, and open matters, but remove redundancy and lower-value detail. Aim for at most ${compressionTarget} tokens by your estimate so the result remains safely below the absolute ${allowance}-token limit under SillyTavern's tokenizer. Never clip, truncate, use an ellipsis, or leave a thought incomplete. Return only the complete requested JSON object; do not introduce facts.\nReturn one JSON object with this exact shape: ${ROLLING_STORY_SNAPSHOT_EXAMPLE}\n\nOVERSIZED COMPLETE CANDIDATE:\n${oversizedCandidate}`
                : '';
            const raw = await requestStructured(
                compressionPrompt || `${prompt}${retryRequirement}`,
                ROLLING_STORY_RULE,
                rollingStoryJsonSchema,
                storyResponseTokens(),
                profileId,
                directKind,
                compressionFallbackPrompt || `${fallbackPrompt}${retryRequirement}`,
                thinkingMode,
            );
            const parsed = typeof raw === 'string' ? parseJsonResponse(raw) : raw;
            const story = compileRollingStorySnapshot(parsed?.storySoFar ?? parsed);
            if (!story) throw new Error('The summarizer returned an empty rolling story.');
            const measuredTokens = Math.max(1, Number(await getTokenCountAsync(story)) || Math.ceil([...story].length / 4));
            if (!storyWithinAllowance(measuredTokens, allowance)) {
                const oversized = new Error(`The rolling story exceeded its ${allowance}-token allowance (${measuredTokens} tokens).`);
                oversized.storyCandidate = story;
                oversized.measuredTokens = measuredTokens;
                throw oversized;
            }
            return story;
        } catch (error) {
            lastError = error;
            const oversizedStory = Boolean(error?.storyCandidate) || /exceeded its \d+-token allowance/i.test(String(error?.message || ''));
            if (error?.storyCandidate) {
                oversizedCandidate = error.storyCandidate;
                compressionPass += 1;
            }
            if (runtime.storyGeneration !== expectedEpoch) {
                const cancelled = new Error('Rolling-story request was stopped; no retry was started.');
                cancelled.code = RUNTIME_CANCELLED_CODE;
                throw cancelled;
            }
            if (isRuntimeCancellation(error) || attempt >= maximumAttempts || !storyRetryableError(error)) throw error;
            const delay = oversizedStory ? 0 : 750 * (2 ** (attempt - 1));
            const outputLimit = /reached its output limit|finish_reason:\s*(?:length|max_tokens)/i.test(String(error?.message || ''));
            updateRuntime({ storyRetryStatus: oversizedStory
                ? `Condensing the complete ${Number(error?.measuredTokens) || 'over-budget'}-token Story candidate automatically (pass ${compressionPass}/${maximumAttempts - 1}); nothing was clipped or saved partially.`
                : outputLimit
                ? `Story API attempt ${attempt}/${maximumAttempts} exhausted the provider output limit. Retrying with stricter compression in ${delay} ms; the selected profile controls output capacity and the Story allowance is unchanged.`
                : `Story API attempt ${attempt}/${maximumAttempts} failed temporarily. Retrying in ${delay} ms; the last completed checkpoint is safe.` });
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

function detachedRequestBodies({ prompt, fallbackPrompt, systemPrompt, usesStructuredSchema }, {
    jsonSchema = extractionJsonSchema,
    layer = 'l1',
    profileId = getSettings().memoryProfileId,
    directKind = 'extraction',
} = {}) {
    const settings = getSettings();
    const thinkingMode = resolveThinkingModeForProfile(settings.thinkingMode, profileId);
    const messagesFor = userPrompt => [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
    let base;
    let thinking;
    let model;
    if (profileId === DIRECT_PROFILE_ID) {
        const config = directRequestConfig(directKind);
        model = config.model;
        thinking = buildThinkingRequest({
            mode: thinkingMode,
            source: config.provider === 'openrouter' ? 'openrouter' : 'custom',
            model,
            url: config.url,
        });
        base = {
            chat_completion_source: config.provider,
            model,
            ...(config.provider === 'openrouter'
                ? { api_url: config.url, secret_id: config.secretId || undefined }
                : { custom_url: config.url, secret_id: config.secretId || undefined }),
        };
    } else if (profileId) {
        const profile = ConnectionManagerRequestService.getProfile(profileId);
        const apiMap = ConnectionManagerRequestService.validateProfile(profile);
        if (apiMap.selected !== 'openai' || !apiMap.source) return null;
        const proxy = proxies.find(item => item.name === profile.proxy);
        model = connectionProfileModel(profile);
        thinking = buildThinkingRequest({
            mode: thinkingMode,
            source: apiMap.source,
            model,
            url: profile['api-url'],
            profileName: profile.name,
        });
        base = {
            chat_completion_source: apiMap.source,
            model,
            secret_id: profile['secret-id'] || undefined,
            custom_url: profile['api-url'] || undefined,
            api_url: profile['api-url'] || undefined,
            vertexai_region: profile['api-url'] || undefined,
            zai_endpoint: profile['api-url'] || undefined,
            siliconflow_endpoint: profile['api-url'] || undefined,
            minimax_endpoint: profile['api-url'] || undefined,
            pollinations_endpoint: profile['api-url'] || undefined,
            reverse_proxy: proxy?.url || undefined,
            proxy_password: proxy?.password || undefined,
        };
    } else {
        // Native active-chat settings require browser-side preset expansion.
        return null;
    }
    const layerTokens = memoryResponseTokens(layer);
    const responseLength = resolveMemoryResponseTokens(layerTokens, thinking.adapter) ?? undefined;
    const compatible = isolatedProfilePayload({
        ...outputTokenPayload(model, layerTokens),
        ...thinking.payload,
    });
    const thinkingKeys = new Set(['include_reasoning', 'reasoning_effort', 'reasoning_budget', 'thinking_budget', 'thinking_level', 'thinking', 'reasoning', 'think', 'enable_thinking', 'chat_template_kwargs', 'custom_include_body']);
    const uncontrolled = Object.fromEntries(Object.entries(compatible).filter(([key]) => !thinkingKeys.has(key)));
    const requestFor = (userPrompt, withSchema, withThinking = true) => ({
        ...base,
        stream: false,
        use_sysprompt: true,
        messages: messagesFor(userPrompt),
        max_tokens: responseLength,
        ...(withThinking ? compatible : uncontrolled),
        ...(withSchema && usesStructuredSchema ? { json_schema: jsonSchema } : {}),
    });
    return {
        request: requestFor(prompt, true),
        fallbackRequest: usesStructuredSchema ? requestFor(fallbackPrompt, false) : null,
        uncontrolledRequest: thinking.controlled ? requestFor(fallbackPrompt, false, false) : null,
    };
}

function splitDetachedMessages(messages) {
    if (messages.length < 2) return null;
    const weights = messages.map(message => Math.max(1, String(message.text || '').length));
    const total = weights.reduce((sum, value) => sum + value, 0);
    let running = 0;
    let boundary = 1;
    let difference = Number.POSITIVE_INFINITY;
    for (let index = 1; index < messages.length; index++) {
        running += weights[index - 1];
        const candidate = Math.abs(total - running * 2);
        if (candidate < difference) {
            difference = candidate;
            boundary = index;
        }
    }
    return [messages.slice(0, boundary), messages.slice(boundary)];
}

function prepareDetachedTask(messages, world) {
    const prepared = prepareExtractionPrompts(messages, world);
    const requests = detachedRequestBodies(prepared);
    if (!requests) return null;
    const split = splitDetachedMessages(messages);
    return {
        messages,
        ...requests,
        ...(split ? { parts: split.map(part => prepareDetachedTask(part, world)) } : {}),
    };
}

function prepareDetachedHierarchyLayer(layer) {
    const settings = getSettings();
    const l2 = layer === 'l2';
    const profileId = settings.arcProfileId || settings.memoryProfileId;
    const directKind = settings.arcProfileId === DIRECT_PROFILE_ID ? 'summary' : 'extraction';
    const jsonSchema = l2 ? arcJsonSchema : eraJsonSchema;
    const usesStructuredSchema = requestSupportsStructuredSchema(jsonSchema, profileId, directKind);
    const placeholder = '__CONTINUITY_DETACHED_HIERARCHY_PROMPT__';
    const requests = detachedRequestBodies({
        prompt: placeholder,
        fallbackPrompt: placeholder,
        systemPrompt: buildHierarchySystemPrompt(l2
            ? settings.arcSystemPrompt ?? DEFAULT_ARC_SYSTEM_PROMPT
            : settings.eraSystemPrompt ?? DEFAULT_ERA_SYSTEM_PROMPT),
        usesStructuredSchema,
    }, { jsonSchema, layer, profileId, directKind });
    if (!requests) return null;
    return {
        ...requests,
        placeholder,
        usesStructuredSchema,
        taskTemplate: l2
            ? settings.arcTaskTemplate ?? DEFAULT_ARC_TASK_TEMPLATE
            : settings.eraTaskTemplate ?? DEFAULT_ERA_TASK_TEMPLATE,
        shapeExample: ARC_JSON_SHAPE_EXAMPLE,
        valueKey: l2 ? 'capsules' : 'arcs',
    };
}

function prepareDetachedHierarchyPlan() {
    const settings = getSettings();
    if (!['l2', 'l3'].includes(settings.hierarchyMode)) return null;
    try {
        const l2 = prepareDetachedHierarchyLayer('l2');
        const l3 = settings.hierarchyMode === 'l3' ? prepareDetachedHierarchyLayer('l3') : null;
        if (!l2 || (settings.hierarchyMode === 'l3' && !l3)) return null;
        return {
            settings: {
                hierarchyMode: settings.hierarchyMode,
                arcGroupSize: settings.arcGroupSize,
                eraGroupSize: settings.eraGroupSize,
                eraStartArcs: settings.eraStartArcs,
            },
            l2,
            l3,
        };
    } catch (error) {
        console.warn('[Continuity] Detached L2/L3 could not be prepared; detached L1 will continue safely.', error);
        return null;
    }
}

async function waitForDetachedJob(id, worldId = '') {
    let syncedChunks = 0;
    while (true) {
        const { job } = await api.getExtractionJob(id);
        const hierarchyPhase = job.phase === 'l2' || job.phase === 'l3';
        updateRuntime({
            status: job.status === 'complete' ? 'processing' : job.status,
            progress: hierarchyPhase ? null : {
                current: job.current,
                total: job.total,
                from: job.from,
                to: job.to,
                inputTokens: job.inputTokens,
            },
            ...(hierarchyPhase ? {
                arcStatus: `${job.phase === 'l2' ? 'Building eligible L2' : 'Building eligible L3'}… created L2 ${job.l2 || 0}, L3 ${job.l3 || 0}.`,
            } : {}),
            lastValidation: job.validation || 'Detached extraction is running in SillyTavern; this tab may be closed.',
        });
        if (worldId && detachedProgressNeedsRefresh(syncedChunks, job)) {
            try {
                const world = (await api.getWorld(worldId)).world;
                updateRuntime({ world });
                await embedWorldInChat(world);
                syncedChunks = Number(job.chunks) || syncedChunks;
            } catch (error) {
                // Canonical L1 is already safe in server storage. A temporary
                // browser refresh failure must not cancel the detached job.
                console.warn('[Continuity] Could not refresh saved detached L1 progress yet.', error);
            }
        }
        if (job.status === 'complete') return job;
        if (job.status === 'cancelled') {
            const error = new Error(job.error || 'Detached extraction was cancelled.');
            error.code = RUNTIME_CANCELLED_CODE;
            throw error;
        }
        if (job.status === 'error') throw new Error(job.error || 'Detached extraction failed.');
        await new Promise(resolve => setTimeout(resolve, 750));
    }
}

async function reconnectDetachedExtraction(worldId, chatKey) {
    try {
        const health = runtime.health || await api.health();
        updateRuntime({ health });
        if (!health?.detachedJobs) return;
        const { jobs } = await api.listExtractionJobs({ worldId, chatKey });
        const active = jobs.find(job => job.status === 'queued' || job.status === 'processing');
        if (!active) {
            // A detached job can finish between the initial world load and
            // this status request. Refresh completed work too so the viewer,
            // retrieval, coverage, and portable chat snapshot cannot remain
            // on the pre-job revision until another page reload.
            const completed = latestCompletedDetachedJob(jobs);
            if (!completed) return;
            const world = (await api.getWorld(worldId)).world;
            if (!completedDetachedWorldIsNewer(runtime.world, world, completed)) return;
            updateRuntime({
                world,
                status: 'idle',
                progress: null,
                arcStatus: completed.hierarchyError
                    ? 'L2/L3 hierarchy deferred; saved L1 remains intact.'
                    : `Detached hierarchy complete: L2 ${completed.l2 || 0}, L3 ${completed.l3 || 0}.`,
                arcError: completed.hierarchyError || '',
                lastValidation: completed.validation || `Detached extraction saved ${completed.messages || 0} message(s).`,
                lastCompletedAt: completed.completedAt || new Date().toISOString(),
            });
            await embedWorldInChat(world);
            return;
        }
        if (watchedDetachedJobs.has(active.id)) return;
        watchedDetachedJobs.add(active.id);
        activeDetachedJobs.add(active.id);
        updateRuntime({
            status: active.status,
            lastValidation: 'Reconnected to a detached CM extraction running in SillyTavern.',
        });
        const completed = await waitForDetachedJob(active.id, worldId);
        const world = (await api.getWorld(worldId)).world;
        updateRuntime({
            world,
            status: 'idle',
            progress: null,
            arcStatus: completed.hierarchyError
                ? 'L2/L3 hierarchy deferred; saved L1 remains intact.'
                : `Detached hierarchy complete: L2 ${completed.l2 || 0}, L3 ${completed.l3 || 0}.`,
            arcError: completed.hierarchyError || '',
            lastCompletedAt: new Date().toISOString(),
        });
        await embedWorldInChat(world);
    } catch (error) {
        if (runtime.paused && isRuntimeCancellation(error)) {
            updateRuntime({ status: 'paused', progress: null, lastError: '', lastValidation: runtime.retryStatus || 'Processing paused safely.' });
        } else {
            updateRuntime({ status: 'error', progress: null, lastError: error.message, lastValidation: `Detached CM extraction failed: ${error.message}` });
        }
    } finally {
        for (const id of [...watchedDetachedJobs]) {
            try {
                const { job } = await api.getExtractionJob(id);
                if (job.status !== 'queued' && job.status !== 'processing') watchedDetachedJobs.delete(id);
            } catch {
                watchedDetachedJobs.delete(id);
            }
        }
        for (const id of [...activeDetachedJobs]) {
            if (!watchedDetachedJobs.has(id)) activeDetachedJobs.delete(id);
        }
    }
}

async function processDetachedRange(job, chunks, currentWorld) {
    const health = runtime.health || await api.health();
    updateRuntime({ health });
    if (!health?.detachedJobs || getSettings().reviewBeforeCommit) return null;
    const tasks = chunks.map(chunk => ({ ...prepareDetachedTask(chunk.messages, currentWorld), inputTokens: chunk.tokens }));
    if (tasks.some(task => !task)) return null;
    const started = await api.startExtractionJob({
        worldId: job.worldId,
        chatKey: job.chatKey,
        reason: job.reason,
        allowStateUpdates: job.allowStateUpdates,
        tasks,
        hierarchy: prepareDetachedHierarchyPlan(),
    });
    updateRuntime({
        status: started.existing ? 'processing' : 'queued',
        lastValidation: started.existing
            ? 'Reconnected to the detached CM build already running in SillyTavern.'
            : 'Detached CM build accepted by SillyTavern; it will continue if this tab closes.',
    });
    activeDetachedJobs.add(started.job.id);
    try {
        const completed = await waitForDetachedJob(started.job.id, job.worldId);
        const world = (await api.getWorld(job.worldId)).world;
        updateRuntime({
            world,
            arcStatus: completed.hierarchyError
                ? 'L2/L3 hierarchy deferred; saved L1 remains intact.'
                : `Detached hierarchy complete: L2 ${completed.l2 || 0}, L3 ${completed.l3 || 0}.`,
            arcError: completed.hierarchyError || '',
            lastValidation: completed.validation || `Detached extraction saved ${completed.messages} message(s).`,
        });
        await embedWorldInChat(world);
        return {
            chunks: completed.chunks,
            adaptiveSplits: completed.splits,
            messages: completed.messages,
            skipped: 0,
            arcs: completed.l2 || 0,
            eras: completed.l3 || 0,
            hierarchyError: completed.hierarchyError || '',
        };
    } finally {
        activeDetachedJobs.delete(started.job.id);
    }
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
    const settings = getSettings();
    const profileId = settings.correctionProfileId || settings.memoryProfileId;
    const directKind = settings.correctionProfileId === DIRECT_PROFILE_ID ? 'correction' : 'extraction';
    const epoch = runtime.generation;
    updateRuntime({ processing: true, status: 'reviewing-correction', lastError: '', retryStatus: `Reviewing ${candidates.length} potentially relevant memory record(s)…` });
    try {
        const raw = await requestStructured(
            prompt,
            CORRECTION_SYSTEM_PROMPT,
            correctionJsonSchema,
            resolveCorrectionResponseTokens(settings.correctionResponseTokens),
            profileId,
            directKind,
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
        if (!runtime.paused && !runtime.queue.length && resolveStorySourceMode(getSettings().storySourceMode) === STORY_SOURCE_L1) {
            queueMicrotask(() => maybeAutoUpdateRollingStory().catch(error => {
                if (!isRuntimeCancellation(error)) updateRuntime({ storyLastError: `Automatic Story update after L1 failed: ${error.message}` });
            }));
        }
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
    const profileId = settings.arcProfileId || settings.memoryProfileId;
    const directKind = settings.arcProfileId === DIRECT_PROFILE_ID ? 'summary' : 'extraction';
    const usesStructuredSchema = requestSupportsStructuredSchema(arcJsonSchema, profileId, directKind);
    const taskTemplate = settings.arcTaskTemplate ?? DEFAULT_ARC_TASK_TEMPLATE;
    const taskValues = {
        capsules: formatCapsules(capsules),
    };
    const prompt = renderStructuredTaskPrompt(taskTemplate, DEFAULT_ARC_TASK_TEMPLATE, taskValues, ARC_JSON_SHAPE_EXAMPLE, usesStructuredSchema, ['capsules']);
    const fallbackPrompt = usesStructuredSchema
        ? renderStructuredTaskPrompt(taskTemplate, DEFAULT_ARC_TASK_TEMPLATE, taskValues, ARC_JSON_SHAPE_EXAMPLE, false, ['capsules'])
        : prompt;
    const raw = await requestStructured(prompt, buildHierarchySystemPrompt(settings.arcSystemPrompt ?? DEFAULT_ARC_SYSTEM_PROMPT), arcJsonSchema, memoryResponseTokens('l2'), profileId, directKind, fallbackPrompt);
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
    let result = await generateArc(capsules);
    if (expectedEpoch !== null && runtime.generation !== expectedEpoch) throw new Error('Processing stopped; pending L2 result was discarded.');
    result = await reviewHierarchyBeforeSave(result, 'L2', capsules, 'hierarchy', () => generateArc(capsules));
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
    let result = await generateEra(arcs);
    if (expectedEpoch !== null && runtime.generation !== expectedEpoch) throw new Error('Processing stopped; pending L3 result was discarded.');
    result = await reviewHierarchyBeforeSave(result, 'L3', arcs, 'hierarchy', () => generateEra(arcs));
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

function latestCurrentCompleteL1Index() {
    const messages = collectMemoryEligibleMessages(getContext().chat || []);
    const stableMessages = partitionL1StabilityBuffer(messages).extractable;
    return latestCompleteL1MessageIndex(stableMessages, getSettings().extractionBatchMessages);
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
        allowStateUpdates: Number(target.to) >= latestCurrentCompleteL1Index(),
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
                let result = await extractChunk(messages);
                result = await reviewExtractionBeforeSave(result, runtime.world, messages, { from: target.from, to: target.to, reason: 'retry' }, () => extractChunk(messages));
                if (runtime.generation !== epoch) throw new Error('Retry stopped; the current generated result was discarded.');
                await saveRetriedL1(worldId, target, result, messages);
            } else {
                world = runtime.world?.id === worldId ? runtime.world : (await api.getWorld(worldId)).world;
                const capsules = (target.capsuleIds || []).map(id => (world.capsules || []).find(item => item.id === id)).filter(Boolean);
                if (capsules.length !== (target.capsuleIds || []).length) throw new Error(`Cannot rebuild “${target.title}”; its source L1 records changed.`);
                let result = await generateArc(capsules);
                if (runtime.generation !== epoch) throw new Error('Retry stopped; the current generated result was discarded.');
                result = await reviewHierarchyBeforeSave(result, 'L2', capsules, 'retry', () => generateArc(capsules));
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
    const profileId = settings.arcProfileId || settings.memoryProfileId;
    const directKind = settings.arcProfileId === DIRECT_PROFILE_ID ? 'summary' : 'extraction';
    const usesStructuredSchema = requestSupportsStructuredSchema(eraJsonSchema, profileId, directKind);
    const taskTemplate = settings.eraTaskTemplate ?? DEFAULT_ERA_TASK_TEMPLATE;
    const taskValues = {
        arcs: formatArcs(arcs),
    };
    const prompt = renderStructuredTaskPrompt(taskTemplate, DEFAULT_ERA_TASK_TEMPLATE, taskValues, ARC_JSON_SHAPE_EXAMPLE, usesStructuredSchema, ['arcs']);
    const fallbackPrompt = usesStructuredSchema
        ? renderStructuredTaskPrompt(taskTemplate, DEFAULT_ERA_TASK_TEMPLATE, taskValues, ARC_JSON_SHAPE_EXAMPLE, false, ['arcs'])
        : prompt;
    const raw = await requestStructured(prompt, buildHierarchySystemPrompt(settings.eraSystemPrompt ?? DEFAULT_ERA_SYSTEM_PROMPT), eraJsonSchema, memoryResponseTokens('l3'), profileId, directKind, fallbackPrompt);
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
            let result = await extractChunk(messages);
            result = await reviewExtractionBeforeSave(result, world, messages, { from: target.from, to: target.to, reason: 'changed-source' }, () => extractChunk(messages));
            if (runtime.generation !== epoch) throw new Error('Live memory update stopped; existing memory was left unchanged.');
            staged.push({ target, messages, result });
        }

        const apply = targetWorld => {
            for (const { target, messages, result } of staged) {
                replaceExtraction(targetWorld, result, {
                    chatKey,
                    from: target.from,
                    to: target.to,
                    allowStateUpdates: Number(target.to) >= latestCurrentCompleteL1Index(),
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

async function persistVerifiedEmptyWorld(worldId) {
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
    if (world?.id !== worldId) throw new Error(`Memory purge reset the wrong world (${world?.id || 'missing'} instead of ${worldId}).`);
    const resetResiduals = freshResetResiduals(world);
    if (resetResiduals.length) {
        throw new Error(`Memory purge did not persist an empty world (${resetResiduals.join(', ')}).`);
    }
    return world;
}

async function persistRollingStory(worldId, chatKey, story) {
    const apply = world => {
        world.storySoFar ||= {};
        if (story) world.storySoFar[chatKey] = structuredClone(story);
        else delete world.storySoFar[chatKey];
    };
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    for (let attempt = 1; ; attempt++) {
        apply(world);
        try {
            world = (await api.saveWorld(world)).world;
            break;
        } catch (error) {
            if (error.status !== 409 || attempt >= 6) throw error;
            world = (await api.getWorld(worldId)).world;
        }
    }
    updateRuntime({ world });
    return world;
}

export async function deleteRollingStory() {
    if (runtime.storyProcessing) throw new Error('Wait for Story processing to finish.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) throw new Error('Open a chat with Continuity memory first.');
    await requireRetryStorage();
    updateRuntime({ storyProcessing: true, storyStatus: 'deleting-story', storyLastError: '', storyFailure: null, storyRetryStatus: 'Deleting this chat’s rolling story…' });
    try {
        const world = await persistRollingStory(worldId, chatKey, null);
        await embedWorldInChat(world);
        updateRuntime({ storyStatus: 'idle', storyRetryStatus: 'This chat’s rolling story was deleted. Structured recall was unchanged.' });
        return { world, deleted: true };
    } catch (error) {
        updateRuntime({ storyStatus: 'error', storyLastError: error.message, storyRetryStatus: `Rolling-story deletion failed: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ storyProcessing: false });
    }
}

async function runManualRollingStory(rebuildFromBeginning) {
    if (runtime.storyProcessing) throw new Error('A Story build is already running.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) throw new Error('Open a chat with Continuity memory first.');
    const allMessages = stableStoryMessages(collectMemoryEligibleMessages(getContext().chat || []));
    if (!allMessages.length) throw new Error('This chat has no eligible raw messages to summarize.');
    const epoch = runtime.storyGeneration;
    let world = runtime.world?.id === worldId ? runtime.world : null;
    let savedWorld = world;
    let previous;
    let plan;
    let messages = [];
    let sourceUnits = [];
    let sourceBreakdown = { l1Count: 0, rawCount: 0, blockedFrom: null };
    let chunks = [];
    let checkpointState = null;
    let action = rebuildFromBeginning ? 'Rebuilding' : 'Building';
    updateRuntime({
        storyProcessing: true,
        storyStatus: rebuildFromBeginning ? 'pending-story-rebuild' : 'pending-story-build',
        storyLastError: '',
        storyFailure: null,
        storyProgress: {
            phase: 'pending',
            label: rebuildFromBeginning ? 'preparing Story rebuild' : 'preparing Story build',
            from: allMessages[0]?.index,
            to: allMessages.at(-1)?.index,
        },
        storyRetryStatus: `Pending ${rebuildFromBeginning ? 'rebuild' : 'build'}: loading the Story checkpoint and preparing ${allMessages.length} eligible raw message(s)…`,
    });
    try {
        await requireRetryStorage();
        if (runtime.storyGeneration !== epoch) {
            const error = new Error('Story construction was stopped while preparing raw history.');
            error.code = RUNTIME_CANCELLED_CODE;
            throw error;
        }
        world = world || (await api.getWorld(worldId)).world;
        if (runtime.storyGeneration !== epoch) {
            const error = new Error('Story construction was stopped while loading its checkpoint.');
            error.code = RUNTIME_CANCELLED_CODE;
            throw error;
        }
        savedWorld = world;
        previous = world.storySoFar?.[chatKey];
        const settings = getSettings();
        const sourceMode = resolveStorySourceMode(settings.storySourceMode);
        const sourceChanged = Boolean(previous?.text) && storedStorySourceMode(previous) !== sourceMode;
        plan = rebuildFromBeginning || sourceChanged
            ? rollingStoryRebuildPlan(allMessages)
            : rollingStoryBuildPlan(allMessages, previous);
        checkpointState = rebuildFromBeginning || sourceChanged ? null : previous;
        messages = plan.messages;
        if (!messages.length) {
            updateRuntime({ storyStatus: 'idle', storyProgress: null, storyLastError: '', storyFailure: null, storyRetryStatus: 'Story so far is already caught up to its eligible source boundary.' });
            return { world, messages: 0, batches: 0, resumed: false, rebuilt: false, caughtUp: true };
        }
        action = rebuildFromBeginning || sourceChanged || plan.restarting ? 'Rebuilding' : plan.resuming ? 'Continuing' : previous?.text ? 'Advancing' : 'Building';
        updateRuntime({
            storyRetryStatus: `Pending ${action.toLowerCase()}: preparing ${storySourceModeLabel(sourceMode)} through ${messages.length} eligible message(s)…`,
            storyProgress: { phase: 'pending', label: `${action.toLowerCase()} Story`, from: messages[0]?.index, to: messages.at(-1)?.index },
        });
        if (rebuildFromBeginning || sourceChanged) {
            world = await persistRollingStory(worldId, chatKey, { ...rollingStoryRebuildCheckpoint(plan), sourceMode });
            savedWorld = world;
        }
        const requiredL1Through = sourceMode === STORY_SOURCE_L1
            ? latestCompleteL1MessageIndex(allMessages, settings.extractionBatchMessages)
            : -1;
        sourceBreakdown = buildStorySourceUnits(messages, world.capsules, chatKey, sourceMode, requiredL1Through);
        sourceUnits = sourceBreakdown.units;
        if (!sourceUnits.length && sourceBreakdown.blockedFrom !== null) {
            const waiting = `Story is waiting for L1 extraction beginning at message ${sourceBreakdown.blockedFrom + 1}.`;
            updateRuntime({ storyStatus: 'idle', storyProgress: null, storyLastError: '', storyFailure: null, storyRetryStatus: waiting });
            return { world: savedWorld, messages: 0, batches: 0, resumed: false, rebuilt: rebuildFromBeginning || sourceChanged, waitingL1: true };
        }
        const allowance = resolveStoryBudget(settings.storySoFarTokens, getContext().maxContext).tokens;
        const rollingChunkLimit = dynamicStorySourceChunk(getContext().maxContext, allowance, true);
        const firstChunkLimit = dynamicStorySourceChunk(getContext().maxContext, allowance, Boolean(plan.story));
        chunks = await chunkMessages(sourceUnits, rollingChunkLimit, storyChunkMessageLimit(false, settings.storyBatchMessages), firstChunkLimit);
        if (runtime.storyGeneration !== epoch) {
            const error = new Error('Story construction was stopped while preparing context-safe chunks.');
            error.code = RUNTIME_CANCELLED_CODE;
            throw error;
        }
        let story = plan.story;
        updateRuntime({
            storyStatus: rebuildFromBeginning ? 'rebuilding-story' : 'updating-story',
            storyProgress: { phase: 'processing', current: 0, total: chunks.length, from: sourceUnits[0]?.sourceFrom ?? sourceUnits[0]?.index, to: sourceUnits.at(-1)?.index },
            storyRetryStatus: `${action} Story so far from ${sourceBreakdown.l1Count} L1 summary record(s) and ${sourceBreakdown.rawCount} uncovered raw message(s)…`,
        });
        for (let index = 0; index < chunks.length; index++) {
            if (runtime.storyGeneration !== epoch) {
                const error = new Error('Story construction was stopped; completed batches remain saved.');
                error.code = RUNTIME_CANCELLED_CODE;
                throw error;
            }
            const chunk = chunks[index];
            updateRuntime({
                storyProgress: { phase: 'processing', current: index + 1, total: chunks.length, from: chunk.messages[0]?.index, to: chunk.messages.at(-1)?.index, inputTokens: chunk.tokens },
                storyRetryStatus: `${action} Story so far ${index + 1}/${chunks.length} from ${storySourceModeLabel(sourceMode)}…`,
            });
            story = await regenerateRollingStory(story, chunk.messages, epoch);
            if (runtime.storyGeneration !== epoch) {
                const error = new Error('Story construction was stopped; the unfinished batch was discarded.');
                error.code = RUNTIME_CANCELLED_CODE;
                throw error;
            }
            const incomplete = index < chunks.length - 1 || sourceBreakdown.blockedFrom !== null;
            checkpointState = withStoryCheckpoint(checkpointState, {
                text: story,
                from: plan.from,
                to: Number(chunk.messages.at(-1)?.index ?? 0),
                updatedAt: new Date().toISOString(),
                sourceMode,
                rebuiltFromRawChat: sourceMode !== STORY_SOURCE_L1,
                rebuildIncomplete: incomplete,
                rebuildRestartPending: false,
                rebuildTargetTo: plan.targetTo,
            }, allMessages, fingerprintMessage);
            savedWorld = await persistRollingStory(worldId, chatKey, checkpointState);
        }
        await embedWorldInChat(savedWorld);
        const processedThrough = Number(checkpointState?.to ?? -1);
        const processedMessages = messages.filter(message => Number(message.index) <= processedThrough).length;
        const sourceDescription = `${sourceBreakdown.l1Count} L1 summary record(s) and ${sourceBreakdown.rawCount} uncovered raw message(s)`;
        const waitingSuffix = sourceBreakdown.blockedFrom === null ? '' : ` Waiting for L1 extraction at message ${sourceBreakdown.blockedFrom + 1}.`;
        updateRuntime({ storyStatus: 'idle', storyProgress: null, storyFailure: null, storyRetryStatus: rebuildFromBeginning || sourceChanged
            ? `Rebuild processed ${sourceDescription} in ${chunks.length} batch(es).${waitingSuffix}`
            : `Story so far ${plan.resuming ? 'continued' : previous?.text ? 'advanced' : 'built'} from ${sourceDescription} in ${chunks.length} batch(es).${waitingSuffix}` });
        return { world: savedWorld, messages: processedMessages, batches: chunks.length, resumed: plan.resuming, rebuilt: rebuildFromBeginning || sourceChanged, waitingL1: sourceBreakdown.blockedFrom !== null, l1Records: sourceBreakdown.l1Count, rawMessages: sourceBreakdown.rawCount };
    } catch (error) {
        if (isRuntimeCancellation(error)) updateRuntime({ storyStatus: 'idle', storyProgress: null, storyLastError: '', storyFailure: null, storyRetryStatus: error.message });
        else {
            const checkpoint = savedWorld?.storySoFar?.[chatKey];
            const resume = checkpoint?.rebuildRestartPending
                ? ' Build / Continue will retry from the first raw message.'
                : checkpoint?.rebuildIncomplete ? ` Build / Continue will resume after message ${Number(checkpoint.to) + 1}.` : ' Build / Continue will retry the pending Story range.';
            updateRuntime({
                storyStatus: 'error',
                storyProgress: null,
                storyLastError: error.message,
                storyFailure: { chatKey, message: error.message, recovery: resume.trim(), at: new Date().toISOString() },
                storyRetryStatus: `Story construction failed safely: ${error.message}${resume}`,
            });
        }
        throw error;
    } finally {
        updateRuntime({ storyProcessing: false });
    }
}

export async function buildRollingStory() {
    return runManualRollingStory(false);
}

export async function rebuildRollingStory() {
    return runManualRollingStory(true);
}

export async function maybeAutoUpdateRollingStory(sourceMessages = null) {
    const settings = getSettings();
    if (!settings.enabled || !settings.storySoFarEnabled || runtime.storyProcessing) return null;
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) return null;
    const messages = stableStoryMessages(Array.isArray(sourceMessages)
        ? sourceMessages
        : collectMemoryEligibleMessages(getContext().chat || []));
    if (!messages.length) return null;
    let world = runtime.world?.id === worldId ? runtime.world : (await api.getWorld(worldId)).world;
    if (runtime.world?.id !== worldId) updateRuntime({ world });
    const previous = world.storySoFar?.[chatKey];
    const sourceMode = resolveStorySourceMode(settings.storySourceMode);
    if (previous?.text && storedStorySourceMode(previous) !== sourceMode) {
        updateRuntime({ storyRetryStatus: `Story source changed to ${storySourceModeLabel(sourceMode)}; use Build / Continue or Rebuild to recreate it safely.` });
        return null;
    }
    if (previous?.rebuildRestartPending) return buildRollingStory();
    const rebuilding = Boolean(previous?.rebuildIncomplete && previous?.text && Number.isFinite(Number(previous?.rebuildTargetTo)));
    const rebuildTargetTo = Number(previous?.rebuildTargetTo);
    const pending = messages.filter(message => Number(message.index) > Number(previous?.to ?? -1)
        && (!rebuilding || Number(message.index) <= rebuildTargetTo));
    const batchSize = resolveStoryBatchMessages(settings.storyBatchMessages);
    const ready = rebuilding ? pending : completeStoryMessages(pending, batchSize);
    if (!ready.length) return null;
    const requiredL1Through = sourceMode === STORY_SOURCE_L1
        ? latestCompleteL1MessageIndex(messages, settings.extractionBatchMessages)
        : -1;
    const sourceBreakdown = buildStorySourceUnits(ready, world.capsules, chatKey, sourceMode, requiredL1Through);
    const sourceUnits = sourceBreakdown.units;
    if (!sourceUnits.length && sourceBreakdown.blockedFrom !== null) {
        updateRuntime({ storyRetryStatus: `Story is waiting for L1 extraction beginning at message ${sourceBreakdown.blockedFrom + 1}.` });
        return null;
    }
    if (runtime.storyProcessing) return null;
    const epoch = runtime.storyGeneration;
    let story = String(previous?.text || '').trim();
    let savedWorld = world;
    let checkpointState = previous;
    const firstIndex = Number(previous?.from ?? messages[0]?.index ?? ready[0].index);
    updateRuntime({
        storyProcessing: true,
        storyStatus: 'updating-story',
        storyLastError: '',
        storyFailure: null,
        storyProgress: { phase: 'pending', current: 0, total: 0, from: ready[0]?.index, to: ready.at(-1)?.index },
        storyRetryStatus: `${rebuilding ? 'Resuming interrupted' : previous?.text ? 'Updating' : 'Building'} Story so far from ${sourceBreakdown.l1Count} L1 summary record(s) and ${sourceBreakdown.rawCount} uncovered raw message(s)…`,
    });
    try {
        await requireRetryStorage();
        const allowance = resolveStoryBudget(settings.storySoFarTokens, getContext().maxContext).tokens;
        const hasPriorStory = Boolean(previous?.text);
        const rollingChunkLimit = dynamicStorySourceChunk(getContext().maxContext, allowance, true);
        const firstChunkLimit = dynamicStorySourceChunk(getContext().maxContext, allowance, hasPriorStory);
        const chunks = await chunkMessages(sourceUnits, rollingChunkLimit, rebuilding ? Infinity : storyChunkMessageLimit(hasPriorStory, batchSize), firstChunkLimit);
        if (runtime.storyGeneration !== epoch) {
            const error = new Error('Automatic Story update was stopped while preparing its independent request.');
            error.code = RUNTIME_CANCELLED_CODE;
            throw error;
        }
        updateRuntime({ storyProgress: { phase: 'processing', current: 0, total: chunks.length, from: ready[0]?.index, to: ready.at(-1)?.index } });
        for (let index = 0; index < chunks.length; index++) {
            if (runtime.storyGeneration !== epoch) {
                const error = new Error('Automatic Story update was stopped; completed batches remain saved.');
                error.code = RUNTIME_CANCELLED_CODE;
                throw error;
            }
            const chunk = chunks[index];
            updateRuntime({
                storyProgress: { phase: 'processing', current: index + 1, total: chunks.length, from: chunk.messages[0]?.index, to: chunk.messages.at(-1)?.index, inputTokens: chunk.tokens },
                storyRetryStatus: `${rebuilding ? 'Resuming interrupted' : previous?.text ? 'Updating' : 'Building'} Story so far ${index + 1}/${chunks.length} with its selected model…`,
            });
            story = await regenerateRollingStory(story, chunk.messages, epoch);
            if (runtime.storyGeneration !== epoch) {
                const error = new Error('Automatic Story update was stopped; the in-flight batch was discarded.');
                error.code = RUNTIME_CANCELLED_CODE;
                throw error;
            }
            checkpointState = withStoryCheckpoint(checkpointState, {
                text: story,
                from: firstIndex,
                to: Number(chunk.messages.at(-1)?.index ?? firstIndex),
                updatedAt: new Date().toISOString(),
                sourceMode,
                rebuiltFromRawChat: sourceMode !== STORY_SOURCE_L1,
                rebuildIncomplete: rebuilding && (index < chunks.length - 1 || sourceBreakdown.blockedFrom !== null),
                ...(rebuilding ? { rebuildTargetTo } : {}),
            }, messages, fingerprintMessage);
            savedWorld = await persistRollingStory(worldId, chatKey, checkpointState);
        }
        await embedWorldInChat(savedWorld);
        const processedThrough = Number(checkpointState?.to ?? -1);
        const processedMessages = ready.filter(message => Number(message.index) <= processedThrough).length;
        const waitingSuffix = sourceBreakdown.blockedFrom === null ? '' : ` Waiting for L1 extraction at message ${sourceBreakdown.blockedFrom + 1}.`;
        updateRuntime({ storyStatus: 'idle', storyProgress: null, storyFailure: null, storyRetryStatus: `Story so far advanced through ${processedMessages} eligible message(s) using ${storySourceModeLabel(sourceMode)}.${waitingSuffix}` });
        return { world: savedWorld, messages: processedMessages, batches: chunks.length, fresh: !previous?.text, waitingL1: sourceBreakdown.blockedFrom !== null, l1Records: sourceBreakdown.l1Count, rawMessages: sourceBreakdown.rawCount };
    } catch (error) {
        if (isRuntimeCancellation(error)) updateRuntime({ storyStatus: 'idle', storyProgress: null, storyLastError: '', storyFailure: null, storyRetryStatus: error.message });
        else {
            const checkpoint = savedWorld?.storySoFar?.[chatKey];
            const resume = checkpoint?.rebuildIncomplete
                ? `Build / Continue will resume after message ${Number(checkpoint.to) + 1}.`
                : 'Build / Continue will retry the pending eligible messages.';
            updateRuntime({
                storyStatus: 'error',
                storyProgress: null,
                storyLastError: error.message,
                storyFailure: { chatKey, message: error.message, recovery: resume, at: new Date().toISOString() },
                storyRetryStatus: `Automatic Story update failed safely: ${error.message} ${resume}`,
            });
        }
        throw error;
    } finally {
        updateRuntime({ storyProcessing: false });
    }
}

export async function eraseAllMemory() {
    if (runtime.processing || runtime.storyProcessing) throw new Error('Wait for current memory and Story processing to finish.');
    const worldId = getBoundWorldId();
    if (!worldId) throw new Error('Open a chat with Continuity memory first.');
    await requireRetryStorage();
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error('Delete All cleared the processing queue.'));
    updateRuntime({ processing: true, paused: false, status: 'deleting', progress: null, lastError: '', retryStatus: 'Erasing all Continuity memory…' });
    try {
        const world = await persistVerifiedEmptyWorld(worldId);
        updateRuntime({
            world,
            status: 'idle',
            progress: null,
            lastInjection: '',
            lastInjectionTokens: 0,
            lastGenerationRetrieval: null,
            nextRetrievalPreview: null,
            retryStatus: 'All Continuity memory was erased and verified empty.',
        });
        await embedWorldInChat(world);
        return { world, erased: true };
    } catch (error) {
        updateRuntime({ status: 'error', progress: null, lastError: error.message, retryStatus: `Delete All failed safely: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
}

export async function restartL1FromScratch(afterReset = null) {
    if (runtime.processing || runtime.storyProcessing) throw new Error('Wait for current memory and Story processing to finish.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    const chat = getContext().chat || [];
    if (!worldId || !chatKey || !chat.length) throw new Error('Open a chat and prepare its memory first.');
    await requireRetryStorage();
    const allMessages = collectMemoryEligibleMessages(chat);
    if (!allMessages.length) throw new Error('This chat has no processable messages.');
    const groupSize = resolveL1GroupSize(getSettings().extractionBatchMessages);
    const stability = partitionL1StabilityBuffer(allMessages);
    const messages = completeL1Messages(stability.extractable, groupSize);
    const pendingTail = allMessages.length - messages.length;
    if (!messages.length) throw new Error(`At least ${groupSize + L1_STABILITY_BUFFER_MESSAGES} processable messages are required for the first L1 record while preserving the ${L1_STABILITY_BUFFER_MESSAGES}-message stability buffer.`);
    runtime.generation++;
    const queued = runtime.queue.splice(0);
    for (const job of queued) job.reject?.(new Error('Start Over cleared the processing queue.'));
    const epoch = runtime.generation;
    let completedChunks = 0;
    updateRuntime({ processing: true, paused: false, status: 'restarting', progress: null, lastError: '', retryStatus: 'Erasing all Continuity memory before the fresh build…' });
    try {
        const world = await persistVerifiedEmptyWorld(worldId);
        updateRuntime({ world, retryStatus: 'All old Continuity memory was erased and verified empty. Preparing the first fresh L1 chunks…' });
        await embedWorldInChat(world);
        if (typeof afterReset === 'function') afterReset(world);

        const chunks = await chunkMessages(messages, resolveExtractionChunk(getSettings().extractionChunkTokens, getContext().maxContext), groupSize);
        for (let index = 0; index < chunks.length; index++) {
            if (runtime.paused || runtime.generation !== epoch) throw new Error('Fresh rebuild stopped. Completed chunks remain saved; use Build to resume.');
            const chunk = chunks[index].messages;
            updateRuntime({
                progress: { current: index + 1, total: chunks.length, from: chunk[0].index, to: chunk.at(-1).index, inputTokens: chunks[index].tokens },
                retryStatus: `Rebuilding fresh L1 chunk ${index + 1}/${chunks.length}; each completed chunk is saved.`,
            });
            let result = await extractChunk(chunk);
            result = await reviewExtractionBeforeSave(result, runtime.world, chunk, { from: chunk[0].index, to: chunk.at(-1).index, reason: 'fresh-rebuild' }, () => extractChunk(chunk));
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
            retryStatus: `Fresh L1 build complete: ${messages.length} messages in ${chunks.length} saved chunk(s)${pendingTail ? `; ${pendingTail} recent message(s) remain raw, including the ${stability.buffered.length}-message stability buffer` : ''}.`,
        });
        return { messages: messages.length, chunks: chunks.length, completedChunks, pendingTail, bufferedMessages: stability.buffered.length };
    } catch (error) {
        const paused = runtime.paused || isRateLimitError(error) || /stopped/i.test(error.message);
        updateRuntime({
            paused,
            status: paused ? 'paused' : 'error',
            progress: null,
            lastError: error.message,
            retryStatus: `Fresh rebuild interrupted after ${completedChunks} saved chunk(s). Old extracted memory remains erased. Use Build to resume missing ranges.`,
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

    const detached = await processDetachedRange(job, chunks, currentWorld);
    if (detached) return { ...detached, skipped };

    const adaptive = await processAdaptiveExtractionChunks(chunks, {
        measureMessages: chunk => getTokenCountAsync(formatMessages(chunk)),
        onAttempt: ({ messages: chunk, tokens, current, total }) => {
            if (runtime.paused || runtime.generation !== epoch) throw new Error('Processing stopped; pending results were discarded.');
            updateRuntime({
                progress: { current, total, from: chunk[0].index, to: chunk.at(-1).index, inputTokens: tokens },
                status: 'processing',
            });
        },
        extract: async chunk => {
            let result = await extractChunk(chunk);
            result = await reviewExtractionBeforeSave(result, runtime.world, chunk, { from: chunk[0].index, to: chunk.at(-1).index, reason: job.reason }, () => extractChunk(chunk));
            if (runtime.paused || runtime.generation !== epoch) throw new Error('Processing stopped; pending results were discarded.');
            return result;
        },
        onSplit: ({ original, parts, current, total }) => {
            const [left, right] = parts;
            updateRuntime({
                progress: { current, total, from: original.messages[0].index, to: original.messages.at(-1).index, inputTokens: original.tokens },
                retryStatus: `Extraction output was incomplete for messages ${original.messages[0].index}-${original.messages.at(-1).index}. Retrying as messages ${left.messages[0].index}-${left.messages.at(-1).index} and ${right.messages[0].index}-${right.messages.at(-1).index}.`,
            });
        },
        save: (result, chunk) => saveExtraction(job.worldId, result, {
            chatKey: job.chatKey,
            from: chunk[0].index,
            to: chunk.at(-1).index,
            allowStateUpdates: job.allowStateUpdates,
            messageFingerprints: chunk.map(message => ({ index: message.index, fingerprint: message.fingerprint })),
        }),
        afterSave: async () => {
            try {
                await buildNextArc(job.worldId, epoch);
                await buildNextEra(job.worldId, epoch);
            } catch (error) {
                console.warn('[Continuity] Non-destructive hierarchy generation was deferred.', error);
                updateRuntime({ arcStatus: 'L2/L3 hierarchy deferred; lower-level memory is safe.', arcError: error.message });
            }
        },
    });
    if (adaptive.splits) {
        updateRuntime({ retryStatus: `Adaptive extraction recovered ${adaptive.splits} incomplete section${adaptive.splits === 1 ? '' : 's'} as ${adaptive.completed} validated L1 parts.` });
    }
    return { chunks: adaptive.completed, adaptiveSplits: adaptive.splits, messages: unseen.length, skipped };
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
        const reviewCancelled = error?.code === 'EXTRACTION_REVIEW_CANCELLED';
        const intentionalCancellation = runtime.paused && isRuntimeCancellation(error);
        updateRuntime({
            paused: runtime.paused || rateLimited,
            status: reviewCancelled ? 'idle' : intentionalCancellation || runtime.paused || rateLimited ? 'paused' : 'error',
            lastError: reviewCancelled || intentionalCancellation ? '' : error.message,
            progress: null,
            lastValidation: reviewCancelled ? error.message : intentionalCancellation ? runtime.retryStatus || 'Processing paused safely.' : stopped ? 'Stopped' : rateLimited ? 'Paused after rate limit; no failed messages were marked processed.' : `Failed: ${error.message}`,
        });
        if (reviewCancelled || intentionalCancellation) job.resolve({ cancelled: true, messages: 0, chunks: 0 });
        else job.reject(error);
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
        return { total: 0, latestIndex: -1, latestExtractableIndex: -1, latestCompleteExtractableIndex: -1, processed: 0, pending: 0, extractable: 0, buffered: 0, required: 0, requiredExtractable: 0, changed: 0, outdated: 0, neverProcessed: 0, pendingMessages: [], extractableMessages: [], bufferedMessages: [], requiredMessages: [], requiredExtractableMessages: [], pendingRanges: [] };
    }
    const messages = Array.isArray(sourceMessages) ? sourceMessages : collectMemoryEligibleMessages(chat);
    const coverage = analyzeCoverage(messages, world?.sources?.[chatKey]?.processedMessages || []);
    const stability = partitionL1StabilityBuffer(messages);
    const pending = partitionPendingL1Messages(messages, coverage.pendingMessages);
    const requiredIndexes = new Set((world?.sources?.[chatKey]?.requiredMemoryIndexes || []).map(Number));
    const requiredMessages = coverage.pendingMessages.filter(message => requiredIndexes.has(message.index));
    const requiredExtractableMessages = pending.extractable.filter(message => requiredIndexes.has(message.index));
    return {
        ...coverage,
        latestExtractableIndex: stability.extractable.at(-1)?.index ?? -1,
        latestCompleteExtractableIndex: latestCompleteL1MessageIndex(stability.extractable, getSettings().extractionBatchMessages),
        extractable: pending.extractable.length,
        buffered: pending.buffered.length,
        required: requiredMessages.length,
        requiredExtractable: requiredExtractableMessages.length,
        extractableMessages: pending.extractable,
        bufferedMessages: pending.buffered,
        requiredMessages,
        requiredExtractableMessages,
    };
}

export function getLatestL1UndoStatus(world = runtime.world) {
    const chatKey = getChatKey();
    return chatKey ? inspectLatestL1Undo(world, chatKey) : inspectLatestL1Undo(null, '');
}

export async function undoLatestL1() {
    if (runtime.processing) throw new Error('Wait for current processing to finish before undoing memory.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) throw new Error('Open a chat with Continuity memory first.');
    await requireRetryStorage();

    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    const expected = inspectLatestL1Undo(world, chatKey);
    if (!expected.available) throw new Error('There is no saved L1 memory to undo for this chat.');
    if (!expected.replayable) throw new Error('This memory predates stored L1 replay data and cannot safely undo one range. Rebuild it from scratch first.');

    const applyUndo = targetWorld => undoLatestL1Extraction(targetWorld, chatKey, expected.extractionId);
    updateRuntime({ processing: true, status: 'undoing', lastError: '', retryStatus: `Undoing L1 messages ${expected.from}–${expected.to} and dependent memory…` });
    try {
        let result = applyUndo(world);
        try {
            world = (await api.saveWorld(world)).world;
        } catch (error) {
            if (error.status !== 409) throw error;
            world = (await api.getWorld(worldId)).world;
            result = applyUndo(world);
            world = (await api.saveWorld(world)).world;
        }
        updateRuntime({ world, status: 'idle', progress: null, retryStatus: `L1 messages ${result.from}–${result.to} are pending memory rebuild before the next reply.` });
        await embedWorldInChat(world);
        return { ...result, world };
    } catch (error) {
        updateRuntime({ status: 'error', progress: null, lastError: error.message, retryStatus: `Undo latest L1 failed: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) queueMicrotask(processQueue);
    }
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

export async function repairDivergedBranch({ sourceMessages = null, sourceMutation = false } = {}) {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const worldId = getBoundWorldId();
    const chatKey = getChatKey();
    if (!worldId || !chatKey) throw new Error('Open a chat with Continuity memory first.');
    await requireRetryStorage();
    const messages = Array.isArray(sourceMessages) ? sourceMessages : collectMemoryEligibleMessages(getContext().chat || []);
    let world = runtime.world?.id === worldId ? structuredClone(runtime.world) : (await api.getWorld(worldId)).world;
    const divergence = getBranchRepairStatus(world, messages);
    const stabilityRepairFrom = l1StabilityRepairFrom(messages, world.extractions, chatKey);
    const storyMessages = stableStoryMessages(messages);
    const fingerprintedStoryMessages = storyMessages.map(message => ({ index: Number(message.index), fingerprint: fingerprintMessage(message) }));
    const storyRecoveryFor = targetWorld => planStoryMutationRecovery(
        targetWorld.storySoFar?.[chatKey], fingerprintedStoryMessages,
        { mutationObserved: sourceMutation, knownChangeFrom: divergence.earliestIndex },
    );
    const storyRecovery = storyRecoveryFor(world);
    let appliedStoryRecovery = storyRecovery;
    const structuredRepair = divergence.detected || stabilityRepairFrom !== null;
    if (!structuredRepair && !storyRecovery.changed) return { repaired: false, repairFrom: null, retained: 0, storyRepaired: false };

    const repairStarts = [divergence.detected ? divergence.repairFrom : null, stabilityRepairFrom]
        .filter(value => value !== null && value !== undefined)
        .map(Number)
        .filter(Number.isFinite);
    let repairFrom = structuredRepair ? Math.min(...repairStarts) : null;
    let retained = structuredRepair ? (world.extractions || [])
        .filter(item => item.chatKey === chatKey && Number(item.to) < repairFrom)
        .sort((a, b) => Number(a.from) - Number(b.from)) : [];
    if (structuredRepair && retained.some(item => !item.result || typeof item.result !== 'object')) {
        repairFrom = 0;
        retained = [];
    }
    const applyStoryRecovery = (targetWorld, recovery = storyRecoveryFor(targetWorld)) => {
        appliedStoryRecovery = recovery;
        if (!recovery.changed) return;
        targetWorld.storySoFar ||= {};
        if (recovery.story) targetWorld.storySoFar[chatKey] = structuredClone(recovery.story);
        else delete targetWorld.storySoFar[chatKey];
    };
    const replay = targetWorld => {
        const previousStory = structuredClone(targetWorld.storySoFar?.[chatKey]);
        const recovery = storyRecoveryFor(targetWorld);
        appliedStoryRecovery = recovery;
        const previousWorld = structuredClone(targetWorld);
        removeChatContributions(targetWorld, chatKey);
        for (const item of retained) {
            mergeExtraction(targetWorld, item.result, {
                chatKey,
                from: Number(item.from),
                to: Number(item.to),
                allowStateUpdates: true,
                replayStoredExtraction: true,
                messageFingerprints: item.messageFingerprints || [],
            });
        }
        restoreRetainedReplayRecords(targetWorld, previousWorld, chatKey);
        if (recovery.changed) applyStoryRecovery(targetWorld, recovery);
        else if (previousStory) {
            targetWorld.storySoFar ||= {};
            targetWorld.storySoFar[chatKey] = previousStory;
        }
    };

    const stabilityRewound = stabilityRepairFrom !== null;
    const repairLabel = divergence.detected
        ? `Removing stale memory from message ${repairFrom} onward${stabilityRewound ? ' and restoring the two-message stability buffer' : ''}…`
        : stabilityRewound ? `Rewinding memory from message ${repairFrom} onward to restore the two-message stability buffer…`
            : `Rewinding Story so far to ${storyRecovery.checkpointTo === null ? 'the beginning' : `checkpoint ${storyRecovery.checkpointTo}`} after a raw-chat change…`;
    updateRuntime({ processing: true, status: 'repairing', lastError: '', retryStatus: repairLabel });
    try {
        if (structuredRepair) replay(world);
        else applyStoryRecovery(world);
        try {
            world = (await api.saveWorld(world)).world;
        } catch (error) {
            if (error.status !== 409) throw error;
            world = (await api.getWorld(worldId)).world;
            if (structuredRepair) replay(world);
            else applyStoryRecovery(world);
            world = (await api.saveWorld(world)).world;
        }
        const completedLabel = divergence.detected
            ? `Stale branch memory removed from message ${repairFrom} onward. Rebuilding from active messages…`
            : stabilityRewound ? `Two-message stability buffer restored by rewinding memory from message ${repairFrom} onward.`
                : `Story so far safely rewound after a raw-chat change.`;
        updateRuntime({ world, status: 'idle', progress: null, retryStatus: completedLabel });
        await embedWorldInChat(world);
        return {
            repaired: true,
            repairFrom,
            retained: retained.length,
            divergenceDetected: divergence.detected,
            stabilityRewound,
            divergentIndexes: divergence.divergentIndexes || [],
            storyRepaired: Boolean(appliedStoryRecovery.changed),
            storyCheckpointTo: appliedStoryRecovery.checkpointTo ?? null,
        };
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
            let result = await extractChunk(messages);
            result = await reviewExtractionBeforeSave(result, sourceWorld, messages, { from: messages[0].index, to: messages.at(-1).index, reason: 'rollback-repair' }, () => extractChunk(messages));
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
            const previousWorld = structuredClone(world);
            removeChatContributions(world, chatKey);
            for (const item of replay) {
                mergeExtraction(world, item.result, {
                    chatKey,
                    from: item.from,
                    to: item.to,
                    allowStateUpdates: true,
                    replayStoredExtraction: true,
                    messageFingerprints: item.messageFingerprints,
                });
            }
            restoreRetainedReplayRecords(world, previousWorld, chatKey);
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

export async function maybeAutoExtract(force = false, sourceMessages = null, { requiredOnly = false } = {}) {
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
    let pending = coverage.extractableMessages;
    if (requiredOnly) {
        const requiredIndexes = new Set(coverage.requiredExtractableMessages.map(message => message.index));
        pending = pending.filter(message => requiredIndexes.has(message.index));
    } else if (!force) {
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
        allowStateUpdates: pending.at(-1).index >= coverage.latestCompleteExtractableIndex,
        reason: requiredOnly ? 'required-rebuild' : force ? 'pending' : 'auto',
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
    let world = (await api.getWorld(worldId)).world;
    const messages = collectMemoryEligibleMessages(getContext().chat || []);
    const stability = partitionL1StabilityBuffer(messages);
    const latestCompleteIndex = latestCompleteL1MessageIndex(stability.extractable, getSettings().extractionBatchMessages);
    const removedInvalidFacts = removeInvalidStoredAddressFacts(world, messages) > 0;
    const compactedDuplicateRecords = compactDuplicateMemoryRecords(world, messages) > 0;
    const promotedSnapshot = promoteStoredTailSnapshot(world, getChatKey(), latestCompleteIndex);
    if (removedInvalidFacts || compactedDuplicateRecords || promotedSnapshot) world = (await api.saveWorld(world)).world;
    updateRuntime({ world });
    await embedWorldInChat(world);
    void reconnectDetachedExtraction(worldId, getChatKey());
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
