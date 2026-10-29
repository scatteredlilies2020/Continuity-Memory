import { eventSource, event_types, extension_prompt_roles, extension_prompt_types, isGenerating, setExtensionPrompt } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { promptManager } from '/scripts/openai.js';
import { api } from './api.js?v=0.15.0-testing.30&pending-recovery=1';
import { captureChatCompletionOverhead, captureTextCompletionOverhead, reduceChatContext } from './context-reducer.js?belief-wording=4&prepared-recall=1&pending-recovery=1';
import { applyExtractionRequestSettings, getProcessingCoverage, getTailRollbackStatus, loadBoundWorld, maintainChronicleHierarchy, maybeAutoExtract, repairDivergedBranch, syncChangedExtractions } from './engine.js?v=0.15.0-testing.30&belief-wording=4&pending-recovery=1&output-recovery=1';
import { buildMemoryPrompt, prepareRetrievalCorpus } from './retrieval.js?v=0.15.0-testing.30&belief-wording=4';
import { invalidateRuntimeWork, invalidateStoryWork, isRuntimeCancellation, onRuntimeChange, onRuntimeStop, resumeRuntime, runtime, updateRuntime } from './runtime.js?v=0.15.0-testing.30';
import { getBoundWorldId, getChatKey, getSettings, saveSettings } from './settings.js?v=0.15.0-testing.30&belief-wording=4&pending-recovery=1';
import { ensureCurrentChatMemory, initUI, refreshModelProfiles, renderRuntime, refreshWorlds, restorePendingExtractionReview } from './ui.js?v=0.15.0-testing.30&belief-wording=4&embedding-continuation=2&current-recall=1&bounded-recall=1&catchup-gate=1&pending-recovery=1&retrieval-json=1';
import { resolveInjectionPlacement } from './injection-placement.js';
import { clearPromptManagerInjection, configurePromptManagerInjection } from './prompt-manager-injection.js';
import { resolveInjectionBudget } from './injection-budget.js?pending-recovery=1';
import { injectionScope, latestAvailableWorld, prepareInjectionSnapshot, readyInjectionSnapshot } from './prepared-injection.js?current-recall=1&bounded-recall=1';
import { getPortableSnapshot } from './portable.js?belief-wording=4&pending-recovery=1';
import { resolveDeletedChatBinding, resolveRenamedChatBinding } from './chat-ownership.js?v=0.15.0-testing.30';
import { collectFingerprintMessages, collectMemoryEligibleMessages, findInvalidExtractionRanges } from './message-digest.js?v=0.15.0-testing.30';
import { ensureGenerationEmbeddingIndex, getCachedEmbeddingMemory, queryEmbeddingMemory, purgeEmbeddingIndex, scheduleEmbeddingIndexSync } from './embedding-retrieval.js?v=0.15.0-testing.30&belief-wording=4&embedding-continuation=2&current-recall=1&bounded-recall=1&catchup-gate=1&pending-recovery=1';
import { previewRetrieval } from './retrieval-preview.js?pending-recovery=1';
import { isTransientApiError } from './errors.js?v=0.15.0-testing.30';
import { asRoleplayBlockingError, isRoleplayBlockingError, roleplaySourceMessages, shouldGateRoleplayGeneration, sourceMutationPolicy } from './generation-policy.js?v=0.15.0-testing.30&output-recovery=1';
import { ensureGenerationMemory, waitForGenerationTask } from './generation-readiness.js?catchup-gate=1&output-recovery=1';
import { isDigestStabilityProtectedMessage, latestCompleteDigestMessageIndex } from './digest-policy.js';
import { shouldCapturePromptMeasurement } from './prompt-measurement-policy.js';
import { createRetrievalSnapshot, retrievalSnapshotPatch } from './retrieval-snapshot.js?v=0.15.0-testing.30';
import { createBackgroundScheduler } from './background-scheduler.js';
import { nextChroniclePromotion } from './chronicle.js';
import { buildPlanningEvidence, createContinuityContextBridge } from './context-bridge.js?v=0.15.0-testing.30';

import { resolveRetrievalAssist } from './retrieval-assist.js?bounded-recall=1&catchup-gate=1';
import { expandRetrievalTerms } from './semantic-retrieval.js?v=0.15.0-testing.30&belief-wording=4&bounded-recall=1&pending-recovery=1&retrieval-json=1';
import { getGenerationTiming, timeGenerationStep } from './generation-timing.js';

const PROMPT_KEY = 'continuity_memory_context';
const continuityContextBridge = createContinuityContextBridge(getContext);
globalThis.continuityMemoryBridge = continuityContextBridge.bridge;
let lastObservedWorldId = null;
let lastObservedWorldRevision = null;
let injectionRefreshRunning = false;
let injectionRefreshPending = false;
let mutationSync = null;
let divergenceRepairRequested = false;
let activeGenerationReadiness = null;
let pendingEmbeddingSync = null;
let injectionRefreshCancel = null;
let injectionRefreshRevision = 0;
let generationInjectionRunning = false;
let preparedInjection = null;
let generationRetrievalController = null;
let previewRetrievalController = null;
let automaticWorkChatKey = null;
let lastOpenedChatKey = null;

function cancelGenerationRetrieval() {
    const active = generationRetrievalController;
    generationRetrievalController?.abort(new DOMException('Story generation stopped or changed.', 'AbortError'));
    generationRetrievalController = null;
    generationInjectionRunning = false;
    if (active) updateRuntime({ roleplayGate: null });
}

function yieldToBrowser(maxWait = 100) {
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        // requestAnimationFrame may stop entirely in a background tab. Keep a
        // short timer fallback so a hidden SillyTavern tab cannot strand an
        // injection refresh forever.
        globalThis.setTimeout(finish, maxWait);
        if (typeof globalThis.requestAnimationFrame === 'function') {
            globalThis.requestAnimationFrame(() => globalThis.setTimeout(finish, 0));
        } else {
            globalThis.setTimeout(finish, 0);
        }
    });
}

function scheduleIdle(callback, timeout = 1500) {
    if (typeof globalThis.requestIdleCallback === 'function') {
        const id = globalThis.requestIdleCallback(callback, { timeout });
        return () => globalThis.cancelIdleCallback?.(id);
    }
    const id = globalThis.setTimeout(callback, Math.min(timeout, 250));
    return () => globalThis.clearTimeout(id);
}

function invalidateInjectionRefresh() {
    injectionRefreshRevision++;
    injectionRefreshCancel?.();
    injectionRefreshCancel = null;
    injectionRefreshPending = false;
    previewRetrievalController?.abort(new DOMException('Retrieval preview superseded.', 'AbortError'));
    previewRetrievalController = null;
}

function injectionRefreshIsCurrent(revision) {
    return revision === injectionRefreshRevision;
}

let backgroundRetryTimer = null;
let backgroundCancelled = false;

function waitForBackgroundRetry(delay, stopSequence) {
    return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        backgroundRetryTimer = globalThis.setTimeout(() => {
            backgroundRetryTimer = null;
            unsubscribe();
            resolve();
        }, delay);
        const inspect = state => {
            if (state.stopSequence === stopSequence) return;
            if (backgroundRetryTimer !== null) globalThis.clearTimeout(backgroundRetryTimer);
            backgroundRetryTimer = null;
            unsubscribe();
            const error = new Error('Automatic memory work was stopped safely.');
            error.code = 'CONTINUITY_BACKGROUND_CANCELLED';
            reject(error);
        };
        unsubscribe = onRuntimeChange(inspect);
        inspect(runtime);
    });
}

const backgroundMemoryWork = createBackgroundScheduler(async () => {
    const stopSequence = runtime.stopSequence;
    backgroundCancelled = false;
    let failures = 0;
    while (true) {
        if (backgroundCancelled || runtime.stopSequence !== stopSequence || runtime.paused && !failures) return;
        if (automaticWorkChatKey !== getChatKey()) return;
        try {
            const settings = getSettings();
            const processableMessages = collectMemoryEligibleMessages(getContext().chat || []).length;
            if (!getBoundWorldId() && processableMessages >= settings.extractionBatchMessages) {
                await ensureCurrentChatMemory(true);
            }
            // An extraction failure must not strand an already over-capacity Chronicle.
            const priorHierarchy = await maintainChronicleHierarchy();
            if (runtime.stopSequence !== stopSequence || runtime.paused) return;
            // Drain stable, complete Digest groups. The stability buffer remains
            // protected by maybeAutoExtract/selectAutomaticDigestMessages.
            const result = await maybeAutoExtract(false);
            if (runtime.stopSequence !== stopSequence || runtime.paused) return;
            // Chronicle capacity is an independent invariant. In particular,
            // switching Recursive mode on, reopening a chat, or a previously
            // deferred hierarchy request must heal even with no new Digest.
            const hierarchy = await maintainChronicleHierarchy();
            if (runtime.stopSequence !== stopSequence || runtime.paused) return;
            failures = 0;
            if (!result && !hierarchy && !priorHierarchy) return;
        } catch (error) {
            if (backgroundCancelled || isRuntimeCancellation(error) || error?.code === 'CONTINUITY_BACKGROUND_CANCELLED' || runtime.stopSequence !== stopSequence) return;
            if (!isTransientApiError(error)) {
                updateRuntime({ lastError: `Automatic memory update failed: ${error.message}` });
                return;
            }
            failures++;
            if (runtime.paused) resumeRuntime();
            const delay = Math.min(60000, 2000 * (2 ** Math.min(5, failures - 1)));
            updateRuntime({
                lastError: '',
                retryStatus: `Automatic memory update hit a temporary error; retrying in ${Math.round(delay / 1000)}s (attempt ${failures + 1})…`,
            });
            try {
                await waitForBackgroundRetry(delay, stopSequence);
            } catch (retryError) {
                if (retryError?.code === 'CONTINUITY_BACKGROUND_CANCELLED' || runtime.stopSequence !== stopSequence) return;
                throw retryError;
            }
        }
    }
});

onRuntimeStop(() => {
    backgroundCancelled = true;
    backgroundMemoryWork.cancel();
    if (backgroundRetryTimer !== null) globalThis.clearTimeout(backgroundRetryTimer);
    backgroundRetryTimer = null;
});

function showGenerationNotification(type, message, options = undefined) {
    if (!getSettings().showNotifications || !window.toastr?.[type]) return false;
    window.toastr[type](message, 'Continuity Memory', options);
    return true;
}

globalThis.continuityMemoryGenerateInterceptor = async (coreChat, contextSize, abort, type) => {
    const timing = type === 'quiet' ? null : getGenerationTiming();
    const settings = getSettings();
    if (!shouldGateRoleplayGeneration(settings, coreChat, type)) {
        if (!settings.enabled) {
            clearPromptManagerInjection(promptManager);
            setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0, false);
            return;
        }
        await reduceChatContext(coreChat, contextSize, abort, type, { cachedOnly: true });
        return;
    }
    // Ordinary turns use completed memory immediately. A large stable backlog
    // or incomplete embedding index is the explicit catch-up exception.
    cancelGenerationRetrieval();
    invalidateInjectionRefresh();
    generationInjectionRunning = true;
    const controller = new AbortController();
    generationRetrievalController = controller;
    const refreshRevision = injectionRefreshRevision;
    const placement = resolveInjectionPlacement(settings, extension_prompt_types, extension_prompt_roles);
    try {
        const context = getContext();
        const chatKey = getChatKey();
        const worldId = getBoundWorldId();
        const activeChat = roleplaySourceMessages(context.chat || [], type);
        const sourceMessages = collectMemoryEligibleMessages(activeChat);
        const recentLimit = Math.min(50, Math.max(2, Number(settings.retrievalQueryMessages) || 6));
        const recent = activeChat.filter(message => !message?.is_system).slice(-recentLimit);
        const currentWorld = () => latestAvailableWorld(worldId, runtime.world, getPortableSnapshot()?.world);
        let waitedForCatchUp = false;
        const showCatchUp = message => {
            if (!waitedForCatchUp) showGenerationNotification('info', message);
            waitedForCatchUp = true;
            updateRuntime({ roleplayGate: { active: true, message, startedAt: Date.now() },
                injectionStatus: message, retryStatus: message });
        };
        let world = currentWorld();
        if (world) {
            try {
                world = await timeGenerationStep('CM: memory backlog readiness', () => ensureGenerationMemory({
                    sourceMessages, batchSize: settings.extractionBatchMessages, currentWorld,
                    getCoverage: getProcessingCoverage, readState: () => runtime, subscribe: onRuntimeChange,
                    extract: messages => maybeAutoExtract(true, messages), signal: controller.signal,
                    onWait: policy => showCatchUp(`Reply waiting: ${policy.pending} stable messages await memory extraction (catch-up threshold: ${policy.hardLimit}).`),
                }), timing);
            } catch (error) {
                if (controller.signal.aborted) throw error;
                throw asRoleplayBlockingError(error, 'Memory catch-up failed;');
            }
        }
        let retrieval = null;
        let retrievalRetries = 0;
        while (world) {
            const retrievalRevision = world.revision;
            retrieval = await timeGenerationStep(`CM: ${settings.retrievalMode} lookup`, () => resolveRetrievalAssist({
                mode: settings.retrievalMode, phase: 'generation', world, messages: recent,
                query: queryEmbeddingMemory, expand: expandRetrievalTerms, signal: controller.signal,
            }), timing);
            controller.signal.throwIfAborted();
            if (retrieval.assist.code === 'CONTINUITY_EMBEDDING_INDEX_NOT_READY') {
                showCatchUp('Reply waiting for at least 90% of the selected embedding index to be ready.');
                try {
                    await timeGenerationStep('CM: embedding index catch-up',
                        () => ensureGenerationEmbeddingIndex(world, { signal: controller.signal }), timing);
                } catch (error) {
                    if (controller.signal.aborted) throw error;
                    throw asRoleplayBlockingError(error, 'Embedding catch-up failed;');
                }
                world = currentWorld();
                continue;
            }
            if (retrieval.assist.fallback) {
                const label = settings.retrievalMode === 'ai-expanded' ? 'AI retrieval' : 'Embedding retrieval';
                updateRuntime({ retrievalAssist: { ...retrieval.assist, mode: settings.retrievalMode, fallback: false, failed: true },
                    lastGenerationRetrieval: null });
                if (retrieval.assist.retryable && retrievalRetries < 1) {
                    retrievalRetries++;
                    showCatchUp(`${label} was delayed or temporarily unavailable; retrying the configured retrieval once.`);
                    await waitForGenerationTask(() => new Promise(resolve => globalThis.setTimeout(resolve, 1000)), controller.signal);
                    world = currentWorld();
                    continue;
                }
                throw asRoleplayBlockingError(new Error(`${label} could not complete: ${retrieval.assist.error || retrieval.assist.reason}. Local fallback was not used.`));
            }
            // Re-query a newly completed memory revision rather than applying
            // semantic ranks from an older index to the latest stored facts.
            const latest = currentWorld();
            world = latest || world;
            if (settings.retrievalMode === 'embedding-hybrid' && world.revision !== retrievalRevision) continue;
            break;
        }
        if (controller.signal.aborted || !injectionRefreshIsCurrent(refreshRevision)
            || chatKey !== getChatKey() || worldId !== getBoundWorldId()) {
            abort?.(true);
            return;
        }
        if (waitedForCatchUp) updateRuntime({ roleplayGate: null, retryStatus: 'Memory preparation is ready for this reply.' });
        const semanticRanks = retrieval?.ranks || new Map();
        const expandedTerms = retrieval?.terms || [];
        const retrievalKey = JSON.stringify([retrieval?.assist.mode, [...semanticRanks], expandedTerms]);
        const prepared = readyInjectionSnapshot(preparedInjection, {
            chatKey: getChatKey(), world, scope: injectionScope(settings, context.maxContext), sourceMessages, recentMessages: recent,
        });
        let snapshot = prepared?.injection && preparedInjection.retrievalKey === retrievalKey
            ? { ...prepared, assist: retrieval.assist } : null;
        const usedPrepared = Boolean(snapshot);
        let bridgeMetadata = snapshot ? preparedInjection.bridgeMetadata : null;
        if (!snapshot && world) {
            const budget = resolveInjectionBudget(settings.injectionBudgetTokens, context.maxContext);
            const coverage = getProcessingCoverage(world, sourceMessages);
            const invalidSourceRanges = findInvalidExtractionRanges(world, sourceMessages, getChatKey());
            const result = await timeGenerationStep('CM: current-turn memory selection', () => buildMemoryPrompt(
                world, recent, budget.tokens, chatKey, expandedTerms, settings.injectionInstruction, semanticRanks,
                { invalidSourceRanges, includeSceneCheckpoint: coverage.pending === 0, includeStorySoFar: settings.storySoFarEnabled },
            ), timing);
            snapshot = createRetrievalSnapshot({
                phase: 'generation', prompt: result.prompt, tokens: result.estimatedTokens, diagnostics: result.retrievalDiagnostics,
                budget, status: 'Latest completed memory selected for the current message.',
                assist: retrieval.assist,
            });
            bridgeMetadata = {
                coverage: { throughMessageIndex: coverage.latestIndex },
                planningEvidence: buildPlanningEvidence(world, getChatKey(), coverage, { invalidSourceRanges }),
            };
            preparedInjection = prepareInjectionSnapshot({
                chatKey: getChatKey(), world, scope: injectionScope(settings, context.maxContext),
                sourceMessages, recentMessages: recent, snapshot, bridgeMetadata, retrievalKey,
            });
        }
        const prompt = snapshot?.injection || '';
        const managerApplied = getContext().mainApi === 'openai'
            && configurePromptManagerInjection(promptManager, settings, prompt);
        if (!managerApplied) clearPromptManagerInjection(promptManager);
        setExtensionPrompt(PROMPT_KEY, managerApplied ? '' : prompt,
            managerApplied ? extension_prompt_types.NONE : placement.position,
            managerApplied ? 0 : placement.depth, false, placement.role);
        if (prompt) {
            await timeGenerationStep('CM: cached history reduction',
                () => reduceChatContext(coreChat, contextSize, abort, type, { cachedOnly: true }), timing);
        } else {
            // A stale snapshot must not remain available to other extensions.
            continuityContextBridge.publish('');
        }
        if (prompt && bridgeMetadata) continuityContextBridge.publish(prompt, bridgeMetadata);
        updateRuntime({
            ...(retrieval ? { retrievalAssist: retrieval.assist } : {}),
            lastGenerationRetrieval: snapshot ? { ...snapshot, phase: 'generation', prepared: usedPrepared } : null,
            lastInjection: prompt, lastInjectionTokens: snapshot?.injectionTokens || 0,
            injectionStatus: snapshot ? 'Latest completed memory applied to the current message.'
                : 'Memory is loading in the background; using raw chat for this reply.',
            roleplayGate: null,
        });
        scheduleInjectionRefresh();
    } catch (error) {
        if (controller.signal.aborted) {
            abort?.(true);
            return;
        }
        if (isRoleplayBlockingError(error)) {
            const message = `Reply cancelled during memory preparation: ${error.message}`;
            clearPromptManagerInjection(promptManager);
            setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
            continuityContextBridge.publish('');
            updateRuntime({ lastError: error.message, injectionStatus: message, retryStatus: message, roleplayGate: null });
            showGenerationNotification('error', message);
            abort?.(true);
            return;
        }
        // Ordinary preparation failures keep raw history available. The
        // explicit catch-up exceptions above must not fall through here.
        const message = `Continuity was unavailable for this reply; continuing without the latest memory: ${error.message}`;
        updateRuntime({ status: 'error', lastError: error.message, injectionStatus: message, retryStatus: message, roleplayGate: null });
        console.error('[Continuity] Roleplay readiness failed; continuing without fresh memory.', error);
        clearPromptManagerInjection(promptManager);
        setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
        continuityContextBridge.publish('');
        showGenerationNotification('error', message);
    } finally {
        if (generationRetrievalController === controller) {
            generationRetrievalController = null;
            generationInjectionRunning = false;
            updateRuntime({ roleplayGate: null });
        }
    }
};

async function prepareRoleplayGeneration(type) {
    const updates = [];
    const timing = null; // This preparation runs outside the visible reply.
    restorePendingExtractionReview();
    await timeGenerationStep('CM: load current memory', () => ensureCurrentChatMemory(true), timing);
    const activeChat = roleplaySourceMessages(getContext().chat || [], type);
    const sourceMessages = collectMemoryEligibleMessages(activeChat);
    // Repair is local and may defer while background extraction owns the
    // processing lock. Invalid ranges remain excluded fail-closed, so neither
    // extraction nor vector work needs to hold up the user's reply.
    const repair = await timeGenerationStep('CM: branch consistency check', () => repairDivergedBranch({ sourceMessages }), timing);
    if (repair.repaired) {
        if (repair.divergenceDetected) updates.push(`repaired changed memory from message ${repair.repairFrom} onward`);
        if (repair.stabilityRewound) updates.push('restored the two-message extraction buffer');
    }
    const coverage = getProcessingCoverage(runtime.world, sourceMessages);
    const retainedError = runtime.paused ? runtime.lastError : '';
    const retryStatus = coverage.pending
        ? `Roleplay released immediately with ${coverage.pending} recent message(s) still raw; Continuity will catch up after the reply.`
        : 'Continuity snapshot is ready; roleplay was not delayed.';
    updateRuntime(retainedError
        ? { status: runtime.paused ? 'paused' : 'error', lastError: retainedError, retryStatus }
        : { status: 'idle', lastError: '', retryStatus });
    const settings = getSettings();
    const recentLimit = Math.min(50, Math.max(2, Number(settings.retrievalQueryMessages) || 6));
    const notification = updates.length ? `Continuity updated before roleplay: ${updates.join('; ')}.` : '';
    return { sourceMessages, recentMessages: activeChat.filter(message => !message?.is_system).slice(-recentLimit), notification };
}

async function performInjectionRefresh(useRetrievalAssist, coverageMessages, recentMessages, promptOptions, refreshRevision) {
    const settings = getSettings();
    const chatKey = getChatKey();
    const worldId = getBoundWorldId();
    const timing = useRetrievalAssist ? getGenerationTiming() : null;
    const phase = useRetrievalAssist ? 'generation' : 'preview';
    const placement = resolveInjectionPlacement(settings, extension_prompt_types, extension_prompt_roles);
    const refreshIsCurrent = () => injectionRefreshIsCurrent(refreshRevision)
        && chatKey === getChatKey() && worldId === getBoundWorldId()
        && (useRetrievalAssist || !generationInjectionRunning && !isGenerating());
    if (!settings.enabled || !getBoundWorldId()) {
        if (!refreshIsCurrent()) return;
        setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
        const injectionStatus = !settings.enabled
            ? 'Continuity Memory is disabled.'
            : 'No stored memory yet; it will be created when extraction begins.';
        updateRuntime({ lastInjection: '', lastInjectionTokens: 0, injectionStatus });
        continuityContextBridge.publish('');
        return;
    }
    let world = runtime.world;
    if (!world || world.id !== getBoundWorldId()) {
        try {
            world = await loadBoundWorld();
        } catch (error) {
            if (error.status !== 404) throw error;
            const message = 'The memory bound to this chat is not available yet. A restore or import may still be in progress.';
            if (!refreshIsCurrent()) return;
            setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
            updateRuntime({ world: null, lastInjection: '', lastInjectionTokens: 0, injectionStatus: message, lastError: message });
            continuityContextBridge.publish('');
            return;
        }
    }
    // Preview refreshes can scan a multi-megabyte world and compile a large
    // prompt. Give SillyTavern one paint before doing that synchronous work;
    // generation refreshes still run immediately after their readiness checks.
    if (!useRetrievalAssist) await yieldToBrowser();
    if (!refreshIsCurrent()) return;
    const availableRecent = Array.isArray(recentMessages)
        ? recentMessages
        : (getContext().chat || []).filter(message => !message?.is_system);
    const queryMessageLimit = Math.min(50, Math.max(2, Number(settings.retrievalQueryMessages) || 6));
    const recent = availableRecent.slice(-queryMessageLimit);
    const controller = new AbortController();
    previewRetrievalController = controller;
    let retrieval;
    try {
        retrieval = useRetrievalAssist ? await timeGenerationStep(`CM: ${settings.retrievalMode} lookup`, async () => await resolveRetrievalAssist({
            mode: settings.retrievalMode, phase, world, messages: recent, query: queryEmbeddingMemory, expand: expandRetrievalTerms,
            signal: controller.signal,
        }), timing) : previewRetrieval({ mode: settings.retrievalMode, world, messages: recent, peekEmbedding: getCachedEmbeddingMemory });
    } finally {
        if (previewRetrievalController === controller) previewRetrievalController = null;
    }
    const { ranks: semanticRanks, terms: expandedTerms, assist: retrievalAssist } = retrieval;
    if (!refreshIsCurrent()) return;
    updateRuntime({ retrievalAssist });
    const budget = resolveInjectionBudget(settings.injectionBudgetTokens, getContext().maxContext);
    const sourceMessages = Array.isArray(coverageMessages)
        ? coverageMessages
        : collectMemoryEligibleMessages(getContext().chat || []);
    const coverage = getProcessingCoverage(world, sourceMessages);
    const invalidSourceRanges = findInvalidExtractionRanges(world, sourceMessages, getChatKey());
    await timeGenerationStep('CM: browser yield', () => yieldToBrowser(), timing);
    if (!refreshIsCurrent()) return;
    await timeGenerationStep('CM: retrieval corpus preparation', () => prepareRetrievalCorpus(world,
        () => timeGenerationStep('CM: browser yield', () => yieldToBrowser(), timing), refreshIsCurrent), timing);
    if (!refreshIsCurrent()) return;
    const memoryPromptOptions = { ...(promptOptions || {}) };
    delete memoryPromptOptions.localOnly;
    const { prompt, estimatedTokens, retrievalDiagnostics } = await timeGenerationStep('CM: memory selection and prompt assembly', () => buildMemoryPrompt(
        world,
        recent,
        budget.tokens,
        getChatKey(),
        expandedTerms,
        settings.injectionInstruction,
        semanticRanks,
        { ...memoryPromptOptions, invalidSourceRanges, includeSceneCheckpoint: coverage.pending === 0, includeStorySoFar: settings.storySoFarEnabled,
        },
    ), timing);
    if (!refreshIsCurrent()) return;
    const managerApplied = useRetrievalAssist && getContext().mainApi === 'openai'
        && configurePromptManagerInjection(promptManager, settings, prompt);
    setExtensionPrompt(
        PROMPT_KEY,
        managerApplied ? '' : prompt,
        managerApplied ? extension_prompt_types.NONE : placement.position,
        managerApplied ? 0 : placement.depth,
        false,
        placement.role,
    );
    const placementStatus = managerApplied ? 'Prompt Manager placement' : settings.injectionPosition === 'at-depth' ? `chat depth ${placement.depth}` : 'main-prompt placement';
    const injectionStatus = prompt
        ? `Ready to inject approximately ${estimatedTokens} tokens via ${placementStatus} (${budget.mode} recall target: ${budget.tokens} tokens${settings.storySoFarEnabled ? ' + complete active Chronicle frontier' : ''}).`
        : 'The selected memory has no injectable records yet.';
    const retrievalSnapshot = createRetrievalSnapshot({
        phase,
        assist: retrievalAssist,
        diagnostics: retrievalDiagnostics,
        prompt,
        tokens: estimatedTokens,
        budget,
        status: injectionStatus,
    });
    const bridgeMetadata = {
        coverage: { throughMessageIndex: coverage.latestIndex },
        planningEvidence: buildPlanningEvidence(world, getChatKey(), coverage, { invalidSourceRanges }),
    };
    preparedInjection = prepareInjectionSnapshot({
        chatKey, world, scope: injectionScope(settings, getContext().maxContext),
        sourceMessages, recentMessages: recent, snapshot: retrievalSnapshot, bridgeMetadata,
        retrievalKey: JSON.stringify([retrievalAssist.mode, [...semanticRanks], expandedTerms]),
    });
    updateRuntime({
        lastInjection: prompt,
        lastInjectionTokens: estimatedTokens,
        retrievalDiagnostics,
        injectionBudget: budget,
        injectionStatus,
        ...retrievalSnapshotPatch(retrievalSnapshot),
    });
    continuityContextBridge.publish(prompt, bridgeMetadata);
}

async function refreshInjection(useRetrievalAssist = false, coverageMessages = null, recentMessages = null, promptOptions = {}) {
    if (!useRetrievalAssist && generationInjectionRunning) {
        // The generation refresh owns the prompt until SillyTavern has built
        // the outgoing request. A preview will be requested again when the
        // generated message arrives.
        injectionRefreshPending = true;
        return false;
    }
    if (useRetrievalAssist) {
        generationInjectionRunning = true;
        invalidateInjectionRefresh();
    } else {
        injectionRefreshCancel?.();
        injectionRefreshCancel = null;
    }
    const refreshRevision = ++injectionRefreshRevision;
    try {
        await performInjectionRefresh(
            useRetrievalAssist,
            coverageMessages,
            recentMessages,
            promptOptions,
            refreshRevision,
        );
        return injectionRefreshIsCurrent(refreshRevision);
    } finally {
        if (useRetrievalAssist) {
            generationInjectionRunning = false;
            injectionRefreshPending = false;
        }
    }
}

function scheduleInjectionRefresh() {
    if (generationInjectionRunning || isGenerating()) {
        injectionRefreshPending = true;
        return;
    }
    injectionRefreshRevision++;
    injectionRefreshCancel?.();
    injectionRefreshCancel = null;
    if (injectionRefreshRunning) {
        injectionRefreshPending = true;
        return;
    }
    const run = async () => {
        injectionRefreshCancel = null;
        if (generationInjectionRunning || isGenerating()) {
            injectionRefreshPending = true;
            return;
        }
        injectionRefreshRunning = true;
        const preparationChatKey = getChatKey();
        try {
            // Preview saved memory without creating, repairing or extracting
            // anything merely because a card/chat was opened.
            const activeChat = roleplaySourceMessages(getContext().chat || [], 'normal');
            const readiness = {
                sourceMessages: collectMemoryEligibleMessages(activeChat),
                recentMessages: activeChat.filter(message => !message?.is_system)
                    .slice(-Math.max(2, Number(getSettings().retrievalQueryMessages) || 6)),
            };
            if (isGenerating() || generationInjectionRunning || getChatKey() !== preparationChatKey) return;
            const context = getContext();
            const previewChat = roleplaySourceMessages(context.chat || [], 'normal')
                .map((message, index) => ({ ...message, index }));
            await reduceChatContext(previewChat, context.maxContext, null, 'normal');
            if (isGenerating() || generationInjectionRunning || getChatKey() !== preparationChatKey) return;
            // Keep a self-contained prepared prompt: the next appended turn
            // can move the raw-tail boundary before this snapshot is reused.
            await refreshInjection(false, readiness.sourceMessages, readiness.recentMessages);
        } catch (error) {
            updateRuntime({ lastError: `Injection failed: ${error.message}` });
        } finally {
            activeGenerationReadiness = null;
            injectionRefreshRunning = false;
            updateRuntime({ roleplayGate: null });
            if (injectionRefreshPending) {
                injectionRefreshPending = false;
                scheduleInjectionRefresh();
            }
        }
    };
    injectionRefreshCancel = scheduleIdle(run);
}

function mutationTouchesProtectedTail(messageIndex) {
    const chat = getContext().chat || [];
    const allMessages = collectFingerprintMessages(chat);
    const eligibleMessages = collectMemoryEligibleMessages(chat);
    return isDigestStabilityProtectedMessage(allMessages, eligibleMessages, messageIndex);
}

function scheduleMutationSync(delay = 350, requireDivergenceRepair = false) {
    if (requireDivergenceRepair) divergenceRepairRequested = true;
    if (mutationSync) clearTimeout(mutationSync);
    mutationSync = setTimeout(async () => {
        mutationSync = null;
        if (activeGenerationReadiness) {
            scheduleMutationSync(1000);
            return;
        }
        if (runtime.processing) {
            scheduleMutationSync(1000, divergenceRepairRequested);
            return;
        }
        const repairRequested = divergenceRepairRequested;
        divergenceRepairRequested = false;
        try {
            // User-visible source mutations can change the meaning of every
            // later turn. Remove and replay the divergent suffix instead of
            // replacing only the extraction range containing the changed text.
            const rollback = getTailRollbackStatus();
            const result = repairRequested || rollback.detected
                ? await repairDivergedBranch({ sourceMutation: true })
                : await syncChangedExtractions();
            if (result?.deferred) {
                scheduleMutationSync(1000);
            } else {
                if (result?.repaired || result?.synced) await refreshInjection();
                // CHAT_CHANGED is also how an externally updated chat (for
                // example, a Syncthing replacement) becomes active. Its new
                // messages do not emit MESSAGE_RECEIVED in this browser, so
                // start the same safe background drain after source mutation
                // reconciliation has finished.
                backgroundMemoryWork.schedule(0);
            }
        } catch (error) {
            if (repairRequested) divergenceRepairRequested = true;
            updateRuntime({ lastError: `Live memory update failed: ${error.message}` });
        }
    }, delay);
}

async function onChatChanged() {
    const chatKey = getChatKey();
    if (chatKey !== lastOpenedChatKey) automaticWorkChatKey = null;
    lastOpenedChatKey = chatKey;
    cancelGenerationRetrieval();
    invalidateInjectionRefresh();
    if (runtime.processing || runtime.queue.length) {
        invalidateRuntimeWork('Chat changed; discarded memory work belonging to the previous chat.');
    }
    invalidateStoryWork('Chat changed; discarded Story work belonging to the previous chat.');
    const settings = getSettings();
    const placement = resolveInjectionPlacement(settings, extension_prompt_types, extension_prompt_roles);
    setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
    updateRuntime({
        world: null,
        chronicleBlocked: false,
        lastInjection: '',
        lastInjectionTokens: 0,
        injectionStatus: 'Loading this chat’s memory…',
        lastGenerationRetrieval: null,
        nextRetrievalPreview: null,
    });
    continuityContextBridge.publish('');
    await refreshWorlds();
    scheduleInjectionRefresh();
    if (automaticWorkChatKey === getChatKey()) scheduleMutationSync();
}

async function onChatDeleted(chatId, ownerKind) {
    const settings = getSettings();
    const result = resolveDeletedChatBinding(settings.chatWorlds, chatId, ownerKind);
    if (result.ambiguous) {
        throw new Error(`Could not identify which deleted ${ownerKind} chat owned its Continuity memory; no memory was deleted.`);
    }
    if (!result.binding) return;
    const { chatKey, worldId, sharedElsewhere } = result.binding;
    if (runtime.world?.id === worldId && (runtime.processing || runtime.queue.length)) {
        invalidateRuntimeWork('Chat was deleted; discarded its active and queued memory work.');
    }
    if (runtime.world?.id === worldId) invalidateStoryWork('Chat was deleted; discarded its active Story work.');
    let attached = runtime.world?.id === worldId && Boolean(runtime.world?.continuation);
    if (!attached && !sharedElsewhere) {
        try { attached = Boolean((await api.getWorld(worldId)).world?.continuation); }
        catch (error) { if (error.status !== 404) throw error; }
    }
    if (!sharedElsewhere && !attached) {
        try { await purgeEmbeddingIndex(worldId); }
        catch (error) { console.warn('[Continuity] Could not remove the deleted chat’s derived embedding index.', error); }
        try {
            await api.deleteWorld(worldId);
        } catch (error) {
            if (error.status !== 404) throw error;
        }
        settings.deletedWorldIds = [...new Set([...(settings.deletedWorldIds || []), worldId])].slice(-1000);
    }
    delete settings.chatWorlds[chatKey];
    saveSettings();
}

async function onChatRenamed(eventData) {
    const settings = getSettings();
    const result = resolveRenamedChatBinding(settings.chatWorlds, eventData);
    if (result.ambiguous) throw new Error('Could not identify which renamed chat owned its Continuity memory; the existing memory was left untouched.');
    if (!result.binding) return;
    const { oldChatKey, newChatKey, worldId } = result.binding;
    const provisionalWorldId = settings.chatWorlds[newChatKey];
    delete settings.chatWorlds[oldChatKey];
    settings.chatWorlds[newChatKey] = worldId;
    saveSettings();
    if (provisionalWorldId && provisionalWorldId !== worldId) {
        let provisionalAttached = runtime.world?.id === provisionalWorldId && Boolean(runtime.world?.continuation);
        try {
            if (!provisionalAttached) provisionalAttached = Boolean((await api.getWorld(provisionalWorldId)).world?.continuation);
        } catch (error) {
            if (error.status !== 404) throw error;
        }
        if (!provisionalAttached) {
            try { await purgeEmbeddingIndex(provisionalWorldId); }
            catch (error) { console.warn('[Continuity] Could not remove the provisional chat’s derived embedding index.', error); }
            try {
                await api.deleteWorld(provisionalWorldId);
            } catch (error) {
                if (error.status !== 404) throw error;
            }
            settings.deletedWorldIds = [...new Set([...(settings.deletedWorldIds || []), provisionalWorldId])].slice(-1000);
            saveSettings();
        }
    }
    if (getChatKey() === newChatKey) await onChatChanged();
}

async function init() {
    const templateResponse = await fetch(new URL('./settings.html?v=0.15.0-testing.31', import.meta.url));
    if (!templateResponse.ok) throw new Error(`Could not load settings template: ${templateResponse.status} ${templateResponse.statusText}`);
    const html = $(await templateResponse.text());
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('Extensions settings container was not found.');
    container.appendChild(html[0]);
    initUI({ scheduleMemoryMaintenance: () => {
        automaticWorkChatKey = getChatKey();
        lastOpenedChatKey = automaticWorkChatKey;
        backgroundMemoryWork.schedule(0);
    } });

    try {
        updateRuntime({ health: await api.health(), lastError: '' });
    } catch (error) {
        updateRuntime({ lastError: `Storage unavailable: ${error.message}` });
    }

    eventSource.on(event_types.CHAT_CHANGED, () => onChatChanged().catch(error => updateRuntime({ lastError: error.message })));
    if (event_types.CHAT_DELETED) {
        eventSource.on(event_types.CHAT_DELETED, chatId => onChatDeleted(chatId, 'character').catch(error => updateRuntime({ lastError: `Chat memory cleanup failed: ${error.message}` })));
    }
    if (event_types.GROUP_CHAT_DELETED) {
        eventSource.on(event_types.GROUP_CHAT_DELETED, chatId => onChatDeleted(chatId, 'group').catch(error => updateRuntime({ lastError: `Chat memory cleanup failed: ${error.message}` })));
    }
    if (event_types.CHAT_RENAMED) {
        eventSource.on(event_types.CHAT_RENAMED, eventData => onChatRenamed(eventData).catch(error => updateRuntime({ lastError: `Chat memory rename failed: ${error.message}` })));
    }
    eventSource.on(event_types.GENERATION_STARTED, (type, _params, dryRun) => {
        const roleplayGeneration = !dryRun && shouldGateRoleplayGeneration(getSettings(), getContext().chat || [], type);
        // Ordinary roleplay generations are refreshed later by the interceptor
        // with the complete user turn. Memory work resumes only after the
        // visible reply returns so it cannot compete with the RP provider.
        if (roleplayGeneration) {
            cancelGenerationRetrieval();
            invalidateInjectionRefresh();
            return;
        }
        if (!dryRun) scheduleInjectionRefresh();
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        cancelGenerationRetrieval();
        generationInjectionRunning = false;
        // Let the host finish releasing its generation flag before resuming.
        globalThis.setTimeout(scheduleInjectionRefresh, 0);
    });
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            cancelGenerationRetrieval();
            generationInjectionRunning = false;
            globalThis.setTimeout(scheduleInjectionRefresh, 0);
            // ST Stop belongs to the visible reply. Only CM's own controls
            // stop detached memory jobs; saved and pending work stay intact.
            if (!runtime.paused) backgroundMemoryWork.schedule(0);
        });
    }
    eventSource.on(event_types.MESSAGE_RECEIVED, (_index, type) => {
        scheduleInjectionRefresh();
        if (type === 'first_message' || !type && !(getContext().chat || []).some(message => message.is_user)) return;
        automaticWorkChatKey = getChatKey();
        lastOpenedChatKey = automaticWorkChatKey;
        if (runtime.paused) return;
        backgroundMemoryWork.schedule();
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, eventData => {
        if (!shouldCapturePromptMeasurement(eventData)) return;
        captureChatCompletionOverhead();
        clearPromptManagerInjection(promptManager);
    });
    for (const eventName of [event_types.MESSAGE_SWIPED, event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED].filter(Boolean)) {
        eventSource.on(eventName, messageIndex => {
            if (runtime.roleplayGate?.active) cancelGenerationRetrieval();
            // Changes inside the stability tail cannot overlap newly queued Digest
            // work, so let older safe extraction finish instead of wasting it.
            const policy = sourceMutationPolicy(mutationTouchesProtectedTail(messageIndex));
            if ((runtime.processing || runtime.queue.length) && policy.invalidateActiveWork) {
                invalidateRuntimeWork('A source message changed; discarded memory work based on its previous content.');
            }
            if (policy.repairSuffix) {
                invalidateStoryWork('A source message changed; discarded Story work based on its previous content.');
            }
            scheduleInjectionRefresh();
            if (policy.repairSuffix) scheduleMutationSync(350, true);
        });
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, () => {
        if (runtime.roleplayGate?.active) cancelGenerationRetrieval();
        if (runtime.processing || runtime.queue.length) {
            invalidateRuntimeWork('A source message was deleted; discarded memory work that could contain it.');
        }
        invalidateStoryWork('A source message was deleted; discarded Story work that could contain it.');
            scheduleInjectionRefresh();
            scheduleMutationSync(350, true);
        });
    }
    // InlineSummary replaces a visible message range directly and keeps its
    // originals only as restoration metadata. Continuity deliberately follows
    // the visible replacement summary, then rebuilds every dependent record
    // after it; hidden originals are never treated as additional chat turns.
    eventSource.on('ILS_SummaryAdded', () => {
        if (runtime.processing || runtime.queue.length) {
            invalidateRuntimeWork('InlineSummary replaced source messages; discarded memory work based on the previous visible chat.');
        }
        invalidateStoryWork('InlineSummary replaced source messages; discarded Story work based on the previous visible chat.');
        scheduleInjectionRefresh();
        scheduleMutationSync(350, true);
    });
    eventSource.on('ILS_RestoreOriginalsBegin', () => {
        if (runtime.processing || runtime.queue.length) {
            invalidateRuntimeWork('InlineSummary is restoring source messages; discarded memory work based on the replacement summary.');
        }
        invalidateStoryWork('InlineSummary is restoring source messages; discarded Story work based on the replacement summary.');
    });
    eventSource.on('ILS_RestoreOriginalsEnd', () => {
        scheduleInjectionRefresh();
        scheduleMutationSync(350, true);
    });
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, captureTextCompletionOverhead);
    if (event_types.CHAT_COMPLETION_SETTINGS_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, applyExtractionRequestSettings);
    }
    for (const eventName of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED, event_types.CONNECTION_PROFILE_DELETED].filter(Boolean)) {
        eventSource.on(eventName, refreshModelProfiles);
    }

    let wasProcessing = false;
    const schedulePendingChronicle = () => {
        const settings = getSettings();
        if (automaticWorkChatKey !== getChatKey() || !settings.enabled || !settings.autoExtract || settings.hierarchyMode === 'off' || runtime.paused
            || runtime.processing || runtime.queue.length || runtime.chronicleBlocked || activeGenerationReadiness || isGenerating()
            || runtime.world?.id !== getBoundWorldId()) return;
        if (nextChroniclePromotion(runtime.world, settings)) backgroundMemoryWork.schedule(0);
    };
    // Recover pending work after a busy pass, a disconnected tab, or a server
    // restart even when no new message event arrives to wake the scheduler.
    globalThis.setInterval(schedulePendingChronicle, 60000);
    onRuntimeChange(state => {
        const becameIdle = wasProcessing && !state.processing;
        wasProcessing = state.processing;
        const worldId = state.world?.id || null;
        const worldRevision = state.world?.revision ?? null;
        const worldChanged = worldId !== lastObservedWorldId || worldRevision !== lastObservedWorldRevision;
        if (!state.world) pendingEmbeddingSync = null;
        if (worldId !== lastObservedWorldId || worldRevision !== lastObservedWorldRevision) {
            const changedDuringSession = Boolean(worldId && worldId === lastObservedWorldId && lastObservedWorldRevision !== null);
            lastObservedWorldId = worldId;
            lastObservedWorldRevision = worldRevision;
            scheduleInjectionRefresh();
            if (state.world) {
                if (state.processing || activeGenerationReadiness) {
                    const alreadyRequiresBuild = pendingEmbeddingSync?.world?.id === worldId
                        && pendingEmbeddingSync.allowAutomaticBuild;
                    pendingEmbeddingSync = {
                        world: state.world,
                        allowAutomaticBuild: Boolean(changedDuringSession || alreadyRequiresBuild),
                    };
                } else if (automaticWorkChatKey === getChatKey()) scheduleEmbeddingIndexSync(state.world, 300, changedDuringSession);
            }
        }
        if (!state.processing && !activeGenerationReadiness && pendingEmbeddingSync && automaticWorkChatKey === getChatKey()) {
            const { world, allowAutomaticBuild } = pendingEmbeddingSync;
            pendingEmbeddingSync = null;
            scheduleEmbeddingIndexSync(world, 300, allowAutomaticBuild);
        }
        if (worldChanged) {
            // A replacement C0 or repaired source invalidates a previous block.
            state.chronicleBlocked = false;
            state.chronicleRetryAt = 0;
        }
        if (becameIdle || worldChanged) schedulePendingChronicle();
    });

    scheduleInjectionRefresh();
    // Freshly opened cards only read saved memory. Actual turns and explicit
    // memory actions enable automatic maintenance for this chat.
    renderRuntime();
    console.log('[Continuity] Extension loaded');
}

await init();
