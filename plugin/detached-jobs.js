import crypto from 'node:crypto';

import { isRateLimitError } from '../extension/errors.js';
import { isRecoverableExtractionOutputError } from '../extension/extraction-recovery.js';
import { fingerprintMessage } from '../extension/message-digest.js';
import { addDerivedArc, addDerivedEra, mergeExtraction } from '../extension/memory-model.js';
import { isCurrentStorySnapshot } from '../extension/story-source.js';
import { migrateLegacyBeliefs } from '../extension/attributed-beliefs.js';
import { nextArcCapsules } from '../extension/hierarchy-policy.js';
import { normalizeHierarchyResult } from '../extension/hierarchy-result.js';
import { renderPromptTemplate } from '../extension/prompts.js';
import { sanitizeReconciliationMetadata } from '../extension/reconciliation-policy.js';
import { isMandatoryThinkingError, isThinkingControlError } from '../extension/thinking-policy.js';

const jobs = new Map();
const activeByWorld = new Map();
const MAX_FINISHED_JOBS = 40;

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
        phase: job.phase,
        l2: job.l2,
        l3: job.l3,
        hierarchyError: job.hierarchyError || '',
    };
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
        // Some reasoning endpoints surround the final object with prose.
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
        catch { /* Try the preceding complete object. */ }
    }
    throw new Error('Extractor returned text without a valid JSON object.');
}

function completionText(payload) {
    const direct = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
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
    return String(payload?.choices?.[0]?.finish_reason ?? payload?.candidates?.[0]?.finishReason ?? '').toLocaleLowerCase();
}

function assertNotTruncated(payload) {
    const reason = finishReason(payload);
    if (reason === 'length' || reason === 'max_tokens' || reason === 'max_tokens') {
        throw new Error(`Extractor reached its output limit (finish_reason: ${reason}).`);
    }
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

function validationLabel(validation, attempt) {
    const recovered = Number(validation.recovered || 0) + Number(validation.recoveredAliases || 0);
    const repaired = Number(validation.repairedAddresses || 0);
    const discarded = Number(validation.discardedAddressValues || 0);
    const unsupported = Number(validation.discardedUnsupportedAddresses || 0);
    const pronouns = Number(validation.discardedPronounAddresses || 0);
    const reconciled = Number(validation.reconciledAddresses || 0);
    const warnings = validation.warnings?.length || 0;
    return `Valid detached extraction${attempt > 1 ? ' after retry' : ''}${recovered ? `; recovered ${recovered} omitted durable record(s)` : ''}${repaired ? `; repaired ${repaired} reversed address value(s)` : ''}${discarded ? `; discarded ${discarded} cross-direction address value(s)` : ''}${unsupported ? `; discarded ${unsupported} unsupported address value(s)` : ''}${pronouns ? `; discarded ${pronouns} unsupported pronoun address value(s)` : ''}${reconciled ? `; reconciled ${reconciled} duplicate address record(s)` : ''}${warnings ? `; ${warnings} L1 coverage warning(s)` : ''}`;
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

function nextEraArcs(world, settings = {}) {
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
        if (ungrouped.length < groupSize * 2) continue;
        return ungrouped.slice(0, groupSize);
    }
    return null;
}

function validateHierarchyResult(result, label) {
    return normalizeHierarchyResult(result, label);
}

function hierarchyPrompt(layer, records, withSchema) {
    const source = String(layer.taskTemplate || '');
    const usesFormatPlaceholder = source.includes('{{format}}');
    const format = withSchema
        ? 'Return one schema-valid JSON object with all required keys.'
        : `Return one JSON object with this exact shape and all keys:\n${layer.shapeExample}`;
    return renderPromptTemplate(source, {
        [layer.valueKey]: layer.valueKey === 'capsules' ? formatCapsules(records) : formatArcs(records),
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

async function requestHierarchy(job, layer, records, label) {
    const prompt = hierarchyPrompt(layer, records, layer.usesStructuredSchema);
    const fallbackPrompt = layer.usesStructuredSchema ? hierarchyPrompt(layer, records, false) : prompt;
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
    return validateHierarchyResult(parseJsonResponse(raw), label);
}

async function saveHierarchyResult(job, result, sourceRecords, layer) {
    for (let attempt = 0; attempt < 4; attempt++) {
        const world = await job.loadWorld();
        const collection = layer === 'l2' ? world.capsules || [] : world.arcs || [];
        const current = sourceRecords.map(source => collection.find(item => item.id === source.id)).filter(Boolean);
        if (current.length !== sourceRecords.length) throw new Error(`${layer.toUpperCase()} sources changed while detached hierarchy was being built.`);
        const before = (layer === 'l2' ? world.arcs : world.eras)?.length || 0;
        if (layer === 'l2') addDerivedArc(world, result, current);
        else addDerivedEra(world, result, current);
        const after = (layer === 'l2' ? world.arcs : world.eras)?.length || 0;
        if (after === before) return false;
        try {
            await job.saveWorld(world);
            return true;
        } catch (error) {
            if (error.status !== 409 || attempt === 3) throw error;
        }
    }
    return false;
}

async function runHierarchy(job) {
    const plan = job.hierarchy;
    if (!plan?.l2) return;
    job.phase = 'l2';
    while (!job.cancelled) {
        const world = await job.loadWorld();
        const capsules = nextArcCapsules(world, plan.settings);
        if (!capsules) break;
        job.validation = `Building eligible L2 ${job.l2 + 1} from ${capsules.length} L1 records…`;
        const result = await requestHierarchy(job, plan.l2, capsules, 'L2');
        if (job.cancelled) throw new Error('Detached processing was cancelled.');
        if (await saveHierarchyResult(job, result, capsules, 'l2')) job.l2++;
    }
    if (!plan.l3 || plan.settings?.hierarchyMode !== 'l3') return;
    job.phase = 'l3';
    while (!job.cancelled) {
        const world = await job.loadWorld();
        const arcs = nextEraArcs(world, plan.settings);
        if (!arcs) break;
        job.validation = `Building eligible L3 ${job.l3 + 1} from ${arcs.length} L2 records…`;
        const result = await requestHierarchy(job, plan.l3, arcs, 'L3');
        if (job.cancelled) throw new Error('Detached processing was cancelled.');
        if (await saveHierarchyResult(job, result, arcs, 'l3')) job.l3++;
    }
}

async function backendRequest(job, body) {
    const response = await job.fetchImpl(job.backendUrl, {
        method: 'POST',
        headers: job.backendHeaders,
        body: JSON.stringify(body),
        signal: job.controller.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: text || response.statusText }; }
    if (!response.ok || payload?.error) {
        const detail = payload?.error?.message || payload?.error || payload?.message || `${response.status} ${response.statusText}`;
        const error = new Error(`Detached API request failed: ${detail}`);
        error.status = response.status;
        throw error;
    }
    assertNotTruncated(payload);
    return completionText(payload);
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
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            let raw;
            try {
                raw = await backendRequest(job, request);
            } catch (error) {
                if (mandatoryRequest && isMandatoryThinkingError(error)) {
                    raw = await backendRequest(job, mandatoryRequest);
                } else if (uncontrolledRequest && isThinkingControlError(error)) {
                    raw = await backendRequest(job, uncontrolledRequest);
                } else if (fallbackRequest && shouldRetryWithoutSchema(error)) {
                    try {
                        raw = await backendRequest(job, fallbackRequest);
                    } catch (fallbackError) {
                        if (mandatoryFallbackRequest && isMandatoryThinkingError(fallbackError)) {
                            raw = await backendRequest(job, mandatoryFallbackRequest);
                        } else if (uncontrolledRequest && isThinkingControlError(fallbackError)) {
                            raw = await backendRequest(job, uncontrolledRequest);
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
            if (isRateLimitError(error)) throw new Error('Rate limited; detached processing paused without marking this section processed.', { cause: error });
            if (/output limit|finish_reason/i.test(error.message)) throw error;
        }
    }
    throw new Error(`Structured extraction failed twice: ${lastError?.message || 'unknown error'}`, { cause: lastError });
}

async function runTask(job, task) {
    if (job.cancelled) throw new Error('Detached processing was cancelled.');
    const world = await job.loadWorld();
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
        mergeExtraction(world, result, meta);
        try {
            await job.saveWorld(world);
        } catch (error) {
            if (error.status !== 409) throw error;
            const latest = await job.loadWorld();
            mergeExtraction(latest, result, meta);
            await job.saveWorld(latest);
        }
        job.chunks++;
        job.messages += task.messages.length;
        return;
    } catch (error) {
        if (!isRecoverableExtractionOutputError(error) || !Array.isArray(task.parts) || task.parts.length !== 2) throw error;
        job.splits++;
        job.total++;
        await runTask(job, task.parts[0]);
        await runTask(job, task.parts[1]);
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
        for (const task of job.tasks) await runTask(job, task);
        try {
            await runHierarchy(job);
        } catch (error) {
            if (job.cancelled) throw error;
            job.hierarchyError = error.message || String(error);
            console.warn('[continuity-memory] detached hierarchy was deferred; saved L1 remains intact:', error);
        }
        job.phase = 'complete';
        job.validation = job.hierarchyError
            ? `L1 complete; L2/L3 hierarchy deferred: ${job.hierarchyError}`
            : `Detached build complete: L1 ${job.chunks}, L2 ${job.l2}, L3 ${job.l3}.`;
        job.status = 'complete';
    } catch (error) {
        job.status = job.cancelled ? 'cancelled' : 'error';
        job.error = error.message || String(error);
        console.error('[continuity-memory] detached extraction failed:', error);
    } finally {
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

export function createDetachedJob(req, payload, storage, { fetchImpl = fetch } = {}) {
    const worldId = String(payload?.worldId || '');
    const chatKey = String(payload?.chatKey || '');
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks.filter(task => Array.isArray(task?.messages) && task.messages.length && task.request && typeof task.request === 'object') : [];
    if (!worldId || !chatKey || !tasks.length) throw Object.assign(new Error('Detached extraction requires a world, chat, and at least one task.'), { status: 400 });
    if (tasks.length > 1000 || tasks.some(task => task.messages.length > 64)) {
        throw Object.assign(new Error('Detached extraction job is too large.'), { status: 413 });
    }
    const activeKey = `${req.user.directories.root}|${worldId}|${chatKey}`;
    const existingId = activeByWorld.get(activeKey);
    if (existingId && jobs.has(existingId)) return { job: jobs.get(existingId), existing: true };
    const backend = backendContext(req);
    const job = {
        id: crypto.randomUUID(),
        worldId,
        chatKey,
        tasks,
        hierarchy: payload?.hierarchy && typeof payload.hierarchy === 'object' ? payload.hierarchy : null,
        reason: String(payload.reason || 'manual'),
        allowStateUpdates: payload.allowStateUpdates !== false,
        activeKey,
        backendUrl: backend.url,
        backendHeaders: backend.headers,
        fetchImpl,
        loadWorld: () => storage.loadWorld(worldId),
        saveWorld: world => storage.saveWorld(worldId, world),
        status: 'queued',
        createdAt: new Date().toISOString(),
        current: 0,
        total: tasks.length,
        from: tasks[0].messages[0]?.index ?? null,
        to: tasks.at(-1).messages.at(-1)?.index ?? null,
        chunks: 0,
        messages: 0,
        splits: 0,
        inputTokens: null,
        phase: 'l1',
        l2: 0,
        l3: 0,
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
