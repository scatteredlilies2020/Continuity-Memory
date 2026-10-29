import { assertCompleteExtractionRecords, extractionCompletenessFeedback, formatStructuredResponseGuide } from '../extension/extraction-contract.js';
import { appendMemoryFeedback, requestPrefill, decodeMemoryResponse, memoryWireRequest } from '../extension/preset-prefill.js';
import { parseJsonResponse } from '../extension/json-response.js';
import crypto from 'node:crypto';

import { isRateLimitError, isTransientApiError } from '../extension/errors.js';
import { EXTRACTION_OUTPUT_RECOVERY_GUIDE, isAdaptiveExtractionSplitError, isExplicitExtractionOutputLimitError } from '../extension/extraction-recovery.js';
import { extractionRecoveryRequest } from '../extension/memory-response-policy.js';
import { assertAuthoritativeMetaProvenance, authoritativeMetaBoundaries } from '../extension/extraction-context.js';
import { fingerprintMessage } from '../extension/message-digest.js';
import { addDerivedChronicle, mergeExtraction } from '../extension/memory-model.js';
import { isCurrentStorySnapshot } from '../extension/story-source.js';
import { migrateLegacyBeliefs } from '../extension/attributed-beliefs.js';
import { normalizeHierarchyResult } from '../extension/hierarchy-result.js';
import { captureScenarioContext } from '../extension/scenario-context.js';
import { renderPromptTemplate } from '../extension/prompts.js';
import { sanitizeReconciliationMetadata } from '../extension/reconciliation-policy.js';
import { isMandatoryThinkingError, isThinkingControlError } from '../extension/thinking-policy.js';
import { nextChroniclePromotion } from '../extension/chronicle.js';
import { chronicleRetryFeedback, retryChroniclePromotion } from '../extension/chronicle-retry.js';
import { retryConnection } from '../extension/connection-retry.js';
import { EXTRACTION_VERSION } from '../extension/coverage.js';
import { requestModel } from './model-response.js';

const jobs = new Map();
const activeByWorld = new Map();
const MAX_FINISHED_JOBS = 40;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 60000;
const DEFAULT_MAX_NETWORK_ATTEMPTS = Infinity;
const INTERRUPTED_BATCH_SPLIT_ATTEMPTS = 3;
const INTERRUPTED_BATCH_SPLIT_CODE = 'CONTINUITY_INTERRUPTED_BATCH_SPLIT';
const TASK_REQUEST_FIELDS = ['request', 'fallbackRequest', 'mandatoryRequest', 'mandatoryFallbackRequest', 'uncontrolledRequest'];

export function releaseDetachedTaskPayload(task, { recursive = true } = {}) {
    if (!task || typeof task !== 'object') return;
    for (const field of TASK_REQUEST_FIELDS) task[field] = null;
    if (recursive && Array.isArray(task.parts)) {
        for (const part of task.parts) releaseDetachedTaskPayload(part);
    }
    task.parts = null;
    task.messages = [];
}

function publicJob(job) {
    return {
        id: job.id,
        worldId: job.worldId,
        chatKey: job.chatKey,
        status: job.status,
        reason: job.reason,
        createdAt: job.createdAt,
        startedAt: job.startedAt || null,
        completedAt: job.completedAt || null,
        current: job.current,
        total: job.total,
        from: job.from,
        to: job.to,
        chunks: job.chunks,
        messages: job.messages,
        splits: job.splits,
        error: job.error || '',
        validation: job.validation || '',
        inputTokens: job.inputTokens,
        connection: job.connection ? { ...job.connection } : null,
        phase: job.phase,
        chronicle: job.chronicle,
        hierarchyError: job.hierarchyError || '',
        pendingTasks: job.tasks.length,
    };
}

function completionText(payload) {
    const direct = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? payload?.completions?.[0]?.text;
    if (Array.isArray(direct)) {
        const text = direct.map(item => item?.text || item?.content || '').join('');
        if (text.trim()) return text;
    }
    if (typeof direct === 'string' && direct.trim()) return direct;
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
        const text = parts.filter(part => !part?.thought).map(part => part?.text || '').join('');
        if (text.trim()) return text;
    }
    if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text;
    throw new Error('Extractor returned no text.');
}

function finishReason(payload) {
    return String(payload?.choices?.[0]?.finish_reason ?? payload?.candidates?.[0]?.finishReason ?? payload?.finishReason ?? '').toLocaleLowerCase();
}

function assertNotTruncated(payload) {
    const reason = finishReason(payload);
    if (reason === 'length' || reason === 'max_tokens') {
        throw new Error(`Extractor reached its output limit (finish_reason: ${reason}).`);
    }
}

function validateResult(result, world, messages) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Extractor returned no JSON object.');
    if (!Array.isArray(result.facts)) throw new Error('Extractor field "facts" is not an array.');
    migrateLegacyBeliefs(result);
    assertCompleteExtractionRecords(result);
    if (!result.sceneCapsule || typeof result.sceneCapsule !== 'object' || !Array.isArray(result.sceneCapsule.beats)) {
        throw new Error('Extractor returned no valid chronological scene capsule.');
    }
    for (const key of ['entities', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds']) {
        if (!Array.isArray(result[key])) throw new Error(`Extractor field "${key}" is not an array.`);
    }
    const provenanceBoundaries = authoritativeMetaBoundaries(messages);
    delete result._sourceScenarioContext;
    assertAuthoritativeMetaProvenance(result, provenanceBoundaries);
    const validation = sanitizeReconciliationMetadata(result, world, messages, { neutralSupporting: true });
    assertAuthoritativeMetaProvenance(result, provenanceBoundaries);
    result._authoritativeMetaBoundaries = provenanceBoundaries;
    result._sourceScenarioContext = captureScenarioContext(messages);
    return { result, validation };
}

function validationLabel(validation, attempt) {
    const recovered = Number(validation.recovered || 0) + Number(validation.recoveredAliases || 0);
    const repaired = Number(validation.repairedAddresses || 0);
    const discarded = Number(validation.discardedAddressValues || 0);
    const unsupported = Number(validation.discardedUnsupportedAddresses || 0);
    const pronouns = Number(validation.discardedPronounAddresses || 0);
    const reconciled = Number(validation.reconciledAddresses || 0);
    const warnings = validation.warnings?.length || 0;
    return `Valid detached extraction${attempt > 1 ? ' after retry' : ''}${recovered ? `; recovered ${recovered} omitted durable record(s)` : ''}${repaired ? `; repaired ${repaired} reversed address value(s)` : ''}${discarded ? `; discarded ${discarded} cross-direction address value(s)` : ''}${unsupported ? `; discarded ${unsupported} unsupported address value(s)` : ''}${pronouns ? `; discarded ${pronouns} unsupported pronoun address value(s)` : ''}${reconciled ? `; reconciled ${reconciled} duplicate address record(s)` : ''}${warnings ? `; ${warnings} Digest coverage warning(s)` : ''}`;
}

function formatChronicleNodes(nodes) {
    return nodes.map((node, index) => JSON.stringify({
        sequence: index + 1,
        layer: `C${Number(node.level) || 0}`,
        storyTime: node.storyTime,
        text: node.text || node.summary,
        turningPoints: node.turningPoints || [],
        closingState: node.closingState || '',
        openThreads: node.openThreads || [],
    })).join('\n');
}

function validateHierarchyResult(result, label) {
    return normalizeHierarchyResult(result, label);
}

function chronicleProvenanceBoundaries(nodes) {
    const seen = new Set();
    return (nodes || []).flatMap(node => node?.provenanceBoundaries || []).filter(boundary => {
        const key = JSON.stringify(boundary);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function hierarchyPrompt(layer, records, withSchema) {
    const source = String(layer.taskTemplate || '');
    const usesFormatPlaceholder = source.includes('{{format}}');
    const format = formatStructuredResponseGuide(layer.shapeExample, withSchema);
    return renderPromptTemplate(source, {
        [layer.valueKey]: formatChronicleNodes(records),
        format,
        schema: layer.shapeExample,
    }, [usesFormatPlaceholder ? 'format' : 'schema', layer.valueKey]);
}

function requestFromTemplate(template, placeholder, prompt) {
    if (!template) return null;
    const request = structuredClone(template);
    request.messages = (request.messages || []).map(message => ({
        ...message,
        content: typeof message.content === 'string' ? message.content.replace(placeholder, prompt) : message.content,
    }));
    return request;
}

async function requestHierarchy(job, layer, records, label, previousError = null) {
    const feedback = chronicleRetryFeedback(previousError);
    const prompt = hierarchyPrompt(layer, records, layer.usesStructuredSchema) + feedback;
    const fallbackPrompt = layer.usesStructuredSchema ? hierarchyPrompt(layer, records, false) + feedback : prompt;
    const primary = requestFromTemplate(layer.request, layer.placeholder, prompt);
    const fallback = requestFromTemplate(layer.fallbackRequest, layer.placeholder, fallbackPrompt);
    const mandatory = requestFromTemplate(layer.mandatoryRequest, layer.placeholder, prompt);
    const mandatoryFallback = requestFromTemplate(layer.mandatoryFallbackRequest, layer.placeholder, fallbackPrompt);
    const uncontrolled = requestFromTemplate(layer.uncontrolledRequest, layer.placeholder, fallbackPrompt);
    let raw;
    try {
        raw = await backendRequest(job, primary);
    } catch (error) {
        if (mandatory && isMandatoryThinkingError(error)) raw = await backendRequest(job, mandatory);
        else if (uncontrolled && isThinkingControlError(error)) raw = await backendRequest(job, uncontrolled);
        else if (fallback && shouldRetryWithoutSchema(error)) {
            try { raw = await backendRequest(job, fallback); }
            catch (fallbackError) {
                if (mandatoryFallback && isMandatoryThinkingError(fallbackError)) raw = await backendRequest(job, mandatoryFallback);
                else if (uncontrolled && isThinkingControlError(fallbackError)) raw = await backendRequest(job, uncontrolled);
                else throw fallbackError;
            }
        } else throw error;
    }
    const result = validateHierarchyResult(parseJsonResponse(raw), label);
    assertAuthoritativeMetaProvenance(result, chronicleProvenanceBoundaries(records), records.map(node => node.text || node.summary || ''));
    return result;
}

async function saveChronicleResult(job, result, sourceRecords) {
    assertAuthoritativeMetaProvenance(result, chronicleProvenanceBoundaries(sourceRecords), sourceRecords.map(node => node.text || node.summary || ''));
    return retryDetached(job, async () => {
        const world = await job.loadWorld();
        if (job.cancelled) throw new Error('Detached processing was cancelled.');
        const childIds = sourceRecords.map(source => source.id).join('|');
        if ((world.chronicle || []).some(node => (node.childIds || []).join('|') === childIds)) return false;
        const current = sourceRecords.map(source => (world.chronicle || []).find(item => item.id === source.id)).filter(Boolean);
        if (current.length !== sourceRecords.length || current.some((node, index) => JSON.stringify(node) !== JSON.stringify(sourceRecords[index]))) {
            throw new Error('Chronicle sources changed while detached promotion was being built.');
        }
        addDerivedChronicle(world, result, current);
        await job.saveWorld(world);
        return true;
    }, 'Saving the completed Chronicle response', true);
}

async function runHierarchy(job) {
    const plan = job.hierarchy;
    if (plan?.chronicle) {
        job.phase = 'chronicle';
        while (!job.cancelled) {
            const pending = await retryChroniclePromotion(async previousError => {
                const world = await job.loadWorld();
                const nodes = nextChroniclePromotion(world, plan.settings);
                if (!nodes) return false;
                const destination = (Number(nodes[0].level) || 0) + 1;
                job.validation = `Promoting ${nodes.length} Chronicle C${nodes[0].level} nodes into C${destination}…`;
                const result = await requestHierarchy(job, plan.chronicle, nodes, `C${destination}`, previousError);
                if (job.cancelled) throw new Error('Detached processing was cancelled.');
                if (await saveChronicleResult(job, result, nodes)) job.chronicle++;
                job.hierarchyError = '';
                return true;
            }, {
                signal: job.controller.signal,
                wait: delay => waitForRetry(job, delay),
                retryDelayMs: job.retryDelayMs,
                maxRetryDelayMs: job.maxRetryDelayMs,
                onRetry: (error, delay, failures) => {
                    job.hierarchyError = error.message;
                    job.validation = `Chronicle promotion remains pending; retrying in ${Math.ceil(delay / 1000)}s (attempt ${failures + 1}): ${error.message}`;
                },
            });
            if (!pending) break;
        }
    }
}

function waitForRetry(job, delay) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const finish = () => {
            job.controller.signal.removeEventListener('abort', cancel);
            resolve();
        };
        const cancel = () => {
            clearTimeout(timer);
            job.controller.signal.removeEventListener('abort', cancel);
            reject(new Error('Detached processing was cancelled.'));
        };
        timer = setTimeout(finish, delay);
        if (job.controller.signal.aborted) cancel();
        else job.controller.signal.addEventListener('abort', cancel, { once: true });
    });
}

async function backendRequestOnce(job, body) {
    const { response, payload } = await requestModel(job.fetchImpl, job.backendUrl, {
        method: 'POST', headers: job.backendHeaders,
        body: JSON.stringify({ ...memoryWireRequest(body), stream: true }),
        signal: job.controller.signal,
    }, job.requestTimeoutMs, progress => { job.connection = { ...job.connection, ...progress }; });
    if (!response.ok || payload?.error) {
        const detail = payload?.error?.message || payload?.message || payload?.error || `${response.status} ${response.statusText}`;
        const error = new Error(`Detached API request failed: ${detail}`);
        error.status = response.status;
        throw error;
    }
    assertNotTruncated(payload);
    return decodeMemoryResponse(completionText(payload), body.continuity_prefill ?? { prefill: requestPrefill(body.messages) });
}

function retryDetached(job, operation, label = 'Connection interrupted', conflicts = false, onRetry = () => {}) {
    return retryConnection(operation, {
        signal: job.controller.signal,
        retryable: error => conflicts && error.status === 409 || isTransientApiError(error),
        wait: delay => waitForRetry(job, delay),
        retryDelayMs: job.retryDelayMs, maxRetryDelayMs: job.maxRetryDelayMs,
        maxAttempts: job.maxNetworkAttempts,
        onRetry: (error, delay, failures) => {
            job.networkFailures = failures;
            job.connection = { phase: 'retrying', attempt: failures + 1, retryAt: Date.now() + delay, label };
            job.validation = `${label}; retrying the pending operation in ${Math.ceil(delay / 1000)}s (attempt ${failures + 1}).`;
            onRetry(error, failures);
        },
    });
}

async function backendRequest(job, body, { canSplit = false } = {}) {
    job.networkFailures = 0;
    try {
        const result = await retryDetached(job, () => {
            job.connection = { phase: 'connecting', attempt: job.networkFailures + 1, startedAt: Date.now() };
            return backendRequestOnce(job, body);
        }, 'Connection interrupted', false, (error, failures) => {
            // Large responses repeatedly lost in transit need a shorter window
            // of stable signal. Leaves continue reconnecting without a limit.
            // Rate limits need time, rather than smaller source sections.
            if (canSplit && failures >= INTERRUPTED_BATCH_SPLIT_ATTEMPTS && !isRateLimitError(error)) {
                throw Object.assign(new Error('Connection repeatedly interrupted; continuing with smaller memory sections.', { cause: error }),
                    { code: INTERRUPTED_BATCH_SPLIT_CODE, networkAttemptsExhausted: true });
            }
        });
        job.networkFailures = 0;
        job.connection = null;
        return result;
    } catch (error) {
        if (isTransientApiError(error)) error.networkAttemptsExhausted = true;
        throw error;
    }
}

function shouldRetryWithoutSchema(error) {
    const message = String(error?.cause?.message || error?.message || error).toLocaleLowerCase();
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|incorrect (?:api )?key|password/.test(message)) return false;
    if (/enotfound|econnrefused|invalid url|failed to fetch|network error|timed? ?out|timeout/.test(message)) return false;
    return /response[_ -]?format|json[_ -]?schema|structured output|schema|deseriali[sz]e|unknown field|unsupported (?:field|parameter)|invalid[_ -]?request|bad request|\b(400|422)\b/.test(message);
}

async function extractTask(job, task, world) {
    const storedStory = world?.storySoFar?.[job.chatKey];
    const priorStory = isCurrentStorySnapshot(storedStory) && String(storedStory.text || '').trim()
        ? String(storedStory.text).trim()
        : '(No prior story yet.)';
    const request = task.storySoFarPlaceholder ? requestFromTemplate(task.request, task.storySoFarPlaceholder, priorStory) : task.request;
    const fallbackRequest = task.storySoFarPlaceholder ? requestFromTemplate(task.fallbackRequest, task.storySoFarPlaceholder, priorStory) : task.fallbackRequest;
    const mandatoryRequest = task.storySoFarPlaceholder ? requestFromTemplate(task.mandatoryRequest, task.storySoFarPlaceholder, priorStory) : task.mandatoryRequest;
    const mandatoryFallbackRequest = task.storySoFarPlaceholder ? requestFromTemplate(task.mandatoryFallbackRequest, task.storySoFarPlaceholder, priorStory) : task.mandatoryFallbackRequest;
    const uncontrolledRequest = task.storySoFarPlaceholder ? requestFromTemplate(task.uncontrolledRequest, task.storySoFarPlaceholder, priorStory) : task.uncontrolledRequest;
    const send = body => backendRequest(job, body, { canSplit: Array.isArray(task.parts) && task.parts.length === 2 });
    let lastError;
    let outputRecovery = false;
    let maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const feedback = extractionCompletenessFeedback(lastError);
            const retryRequest = body => {
                if (!body || (!feedback && !outputRecovery)) return body;
                // Keep routing, schema, prefill metadata and thinking controls;
                // only use the matching fallback's more explicit prompt messages.
                const explicit = body === request ? fallbackRequest
                    : body === mandatoryRequest ? mandatoryFallbackRequest : null;
                const guidance = [feedback.trim(), outputRecovery ? EXTRACTION_OUTPUT_RECOVERY_GUIDE : ''].filter(Boolean).join('\n\n');
                return { ...(outputRecovery ? extractionRecoveryRequest(body) : body),
                    messages: appendMemoryFeedback(explicit?.messages ?? body.messages, guidance) };
            };
            let raw;
            try {
                raw = await send(retryRequest(request));
            } catch (error) {
                if (mandatoryRequest && isMandatoryThinkingError(error)) {
                    raw = await send(retryRequest(mandatoryRequest));
                } else if (uncontrolledRequest && isThinkingControlError(error)) {
                    raw = await send(retryRequest(uncontrolledRequest));
                } else if (fallbackRequest && shouldRetryWithoutSchema(error)) {
                    try {
                        raw = await send(retryRequest(fallbackRequest));
                    } catch (fallbackError) {
                        if (mandatoryFallbackRequest && isMandatoryThinkingError(fallbackError)) {
                            raw = await send(retryRequest(mandatoryFallbackRequest));
                        } else if (uncontrolledRequest && isThinkingControlError(fallbackError)) {
                            raw = await send(retryRequest(uncontrolledRequest));
                        } else {
                            throw fallbackError;
                        }
                    }
                } else {
                    throw error;
                }
            }
            const parsed = parseJsonResponse(raw);
            const validated = validateResult(parsed, world, task.messages);
            job.validation = validationLabel(validated.validation, attempt);
            return validated.result;
        } catch (error) {
            lastError = error;
            if (error?.networkAttemptsExhausted) throw error;
            if (isRateLimitError(error)) throw new Error('Rate limited; detached processing paused without marking this section processed.', { cause: error });
            if (isExplicitExtractionOutputLimitError(error)) {
                // Multi-message tasks split immediately. A leaf cannot split,
                // so give it one larger, concise request before failing safely.
                if (task.messages.length !== 1 || outputRecovery) throw error;
                outputRecovery = true;
                maxAttempts = attempt + 1;
                job.validation = 'Single-message extraction reached its output limit; retrying with more output capacity and concise JSON instructions.';
            }
        }
    }
    throw new Error(`Structured extraction failed twice: ${lastError?.message || 'unknown error'}`, { cause: lastError });
}

function taskIsSaved(world, chatKey, messages) {
    const processed = new Map((world.sources?.[chatKey]?.processedMessages || []).map(item => [Number(item.index), item]));
    return messages.length > 0 && messages.every(message => {
        const saved = processed.get(Number(message.index));
        return saved?.version === EXTRACTION_VERSION && saved.fingerprint === fingerprintMessage(message);
    });
}

async function runTask(job, task) {
    if (job.cancelled) throw new Error('Detached processing was cancelled.');
    const world = await job.loadWorld();
    if (taskIsSaved(world, job.chatKey, task.messages)) {
        job.validation = 'Reused saved Digest; these messages are already processed.';
        return;
    }
    job.current = job.chunks + 1;
    job.from = task.messages[0]?.index ?? null;
    job.to = task.messages.at(-1)?.index ?? null;
    job.inputTokens = Math.max(0, Number(task.inputTokens) || 0) || null;
    try {
        const result = await extractTask(job, task, world);
        if (job.cancelled) throw new Error('Detached processing was cancelled.');
        const meta = {
            chatKey: job.chatKey,
            from: job.from,
            to: job.to,
            allowStateUpdates: job.allowStateUpdates,
            messageFingerprints: task.messages.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
        };
        await retryDetached(job, async () => {
            const latest = await job.loadWorld();
            if (taskIsSaved(latest, job.chatKey, task.messages)) return;
            mergeExtraction(latest, result, meta);
            await job.saveWorld(latest);
        }, 'Saving the completed Digest response', true);
        job.chunks++;
        job.messages += task.messages.length;
        return;
    } catch (error) {
        if (job.cancelled || (!isAdaptiveExtractionSplitError(error) && error.code !== INTERRUPTED_BATCH_SPLIT_CODE)
            || !Array.isArray(task.parts) || task.parts.length !== 2) throw error;
        const parts = task.parts;
        task.parts = null;
        for (const field of TASK_REQUEST_FIELDS) task[field] = null;
        job.splits++;
        job.total++;
        if (error.code === INTERRUPTED_BATCH_SPLIT_CODE) {
            job.validation = 'Connection interrupted repeatedly; retrying smaller memory sections. Completed sections remain saved.';
        }
        for (const part of parts) {
            try {
                await runTask(job, part);
            } finally {
                releaseDetachedTaskPayload(part);
            }
        }
    }
}

function trimFinishedJobs() {
    const finished = [...jobs.values()]
        .filter(job => ['complete', 'error', 'cancelled'].includes(job.status))
        .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
    for (const job of finished.slice(MAX_FINISHED_JOBS)) jobs.delete(job.id);
}

async function run(job) {
    job.status = 'processing';
    job.startedAt = new Date().toISOString();
    try {
        while (job.tasks.length) {
            const task = job.tasks.shift();
            try {
                await runTask(job, task);
            } finally {
                releaseDetachedTaskPayload(task);
            }
        }
        try {
            await runHierarchy(job);
        } catch (error) {
            if (job.cancelled) throw error;
            job.hierarchyError = error.message || String(error);
            console.warn('[continuity-memory] detached hierarchy was deferred; saved Digest remains intact:', error);
        }
        job.phase = 'complete';
        job.validation = job.hierarchyError
            ? `Digest complete; Chronicle promotion deferred: ${job.hierarchyError}`
            : `Detached build complete: Digest ${job.chunks}, Chronicle promotions ${job.chronicle}.`;
        job.status = 'complete';
    } catch (error) {
        job.status = job.cancelled ? 'cancelled' : 'error';
        job.error = error.message || String(error);
        console.error('[continuity-memory] detached extraction failed:', error);
    } finally {
        job.connection = null;
        job.completedAt = new Date().toISOString();
        activeByWorld.delete(job.activeKey);
        job.backendHeaders = null;
        job.hierarchy = null;
        job.tasks = [];
        trimFinishedJobs();
    }
}

function backendContext(req) {
    const port = Number(req.socket?.localPort);
    if (!Number.isInteger(port) || port <= 0) throw new Error('Could not resolve the SillyTavern server port.');
    const headers = { 'Content-Type': 'application/json' };
    for (const name of ['cookie', 'x-csrf-token', 'authorization']) {
        if (req.headers[name]) headers[name] = req.headers[name];
    }
    return {
        url: `http://127.0.0.1:${port}/api/backends/chat-completions/generate`,
        headers,
    };
}

export function createDetachedJob(req, payload, storage, {
    fetchImpl = fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxRetryDelayMs = MAX_RETRY_DELAY_MS,
    maxNetworkAttempts = DEFAULT_MAX_NETWORK_ATTEMPTS,
} = {}) {
    const worldId = String(payload?.worldId || '');
    const chatKey = String(payload?.chatKey || '');
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks.filter(task => Array.isArray(task?.messages) && task.messages.length && task.request && typeof task.request === 'object') : [];
    const hierarchy = payload?.hierarchy;
    const chronicleOnly = payload?.reason === 'chronicle' && Array.isArray(payload?.tasks) && payload.tasks.length === 0
        && hierarchy?.chronicle?.request && hierarchy?.chronicle?.placeholder && hierarchy?.chronicle?.taskTemplate;
    if (!worldId || !chatKey || (!tasks.length && !chronicleOnly)) throw Object.assign(new Error('Detached extraction requires a world, chat, and at least one task or a Chronicle promotion plan.'), { status: 400 });
    if (tasks.length > 1000 || tasks.some(task => task.messages.length > 64)) {
        throw Object.assign(new Error('Detached extraction job is too large.'), { status: 413 });
    }
    const activeKey = `${req.user.directories.root}|${worldId}|${chatKey}`;
    const existingId = activeByWorld.get(activeKey);
    if (existingId && jobs.has(existingId)) return { job: jobs.get(existingId), existing: true };
    const requestId = String(payload.requestId || '');
    const completed = requestId && [...jobs.values()].find(job => job.activeKey === activeKey && job.requestId === requestId);
    if (completed) return { job: completed, existing: true };
    const backend = backendContext(req);
    const job = {
        id: crypto.randomUUID(),
        worldId,
        chatKey,
        requestId,
        tasks,
        hierarchy: payload?.hierarchy && typeof payload.hierarchy === 'object' ? payload.hierarchy : null,
        reason: String(payload.reason || 'manual'),
        allowStateUpdates: payload.allowStateUpdates !== false,
        activeKey,
        backendUrl: backend.url,
        backendHeaders: backend.headers,
        fetchImpl,
        requestTimeoutMs: Number.isFinite(Number(payload.requestIdleTimeoutMs)) && Number(payload.requestIdleTimeoutMs) > 0
            ? Math.max(1000, Number(payload.requestIdleTimeoutMs)) : Math.max(10, Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS),
        retryDelayMs: Math.max(10, Number(retryDelayMs) || DEFAULT_RETRY_DELAY_MS),
        maxRetryDelayMs: Math.max(10, Number(maxRetryDelayMs) || MAX_RETRY_DELAY_MS),
        maxNetworkAttempts: Math.max(1, Number(maxNetworkAttempts) || DEFAULT_MAX_NETWORK_ATTEMPTS),
        networkFailures: 0,
        connection: null,
        loadWorld: () => retryDetached(job, () => storage.loadWorld(worldId), 'Reloading saved memory'),
        saveWorld: world => storage.saveWorld(worldId, world),
        status: 'queued',
        createdAt: new Date().toISOString(),
        current: 0,
        total: tasks.length,
        from: tasks[0]?.messages[0]?.index ?? null,
        to: tasks.at(-1)?.messages.at(-1)?.index ?? null,
        chunks: 0,
        messages: 0,
        splits: 0,
        inputTokens: null,
        phase: 'digest',
        chronicle: 0,
        hierarchyError: '',
        error: '',
        validation: '',
        cancelled: false,
        controller: new AbortController(),
    };
    jobs.set(job.id, job);
    activeByWorld.set(activeKey, job.id);
    setImmediate(() => run(job));
    return { job, existing: false };
}

export function getDetachedJob(req, id) {
    const job = jobs.get(String(id || ''));
    if (!job || !job.activeKey.startsWith(`${req.user.directories.root}|`)) return null;
    return publicJob(job);
}

export function listDetachedJobs(req, { worldId = '', chatKey = '' } = {}) {
    const prefix = `${req.user.directories.root}|`;
    return [...jobs.values()]
        .filter(job => job.activeKey.startsWith(prefix)
            && (!worldId || job.worldId === worldId)
            && (!chatKey || job.chatKey === chatKey))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(publicJob);
}

export function cancelDetachedJob(req, id) {
    const job = jobs.get(String(id || ''));
    if (!job || !job.activeKey.startsWith(`${req.user.directories.root}|`)) return null;
    job.cancelled = true;
    job.controller.abort();
    if (job.status === 'queued') {
        job.status = 'cancelled';
        job.completedAt = new Date().toISOString();
        activeByWorld.delete(job.activeKey);
    }
    return publicJob(job);
}
