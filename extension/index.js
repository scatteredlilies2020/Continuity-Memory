import { eventSource, event_types, extension_prompt_roles, extension_prompt_types, setExtensionPrompt } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { promptManager } from '/scripts/openai.js';
import { api } from './api.js?v=0.14.0-standalone.258';
import { captureChatCompletionOverhead, captureTextCompletionOverhead, reduceChatContext } from './context-reducer.js';
import { applyExtractionRequestSettings, buildNextArc, buildNextEra, continueQueue, getProcessingCoverage, getTailRollbackStatus, loadBoundWorld, maybeAutoExtract, repairDivergedBranch, syncChangedExtractions } from './engine.js?v=0.14.0-standalone.285';
import { buildMemoryPrompt, prepareRetrievalCorpus } from './retrieval.js?v=0.14.0-standalone.258';
import { expandRetrievalTerms } from './semantic-retrieval.js?v=0.14.0-standalone.274';
import { invalidateRuntimeWork, invalidateStoryWork, isRuntimeCancellation, onRuntimeChange, onRuntimeStop, resumeRuntime, runtime, stopRuntime, updateRuntime } from './runtime.js?v=0.14.0-standalone.258';
import { getBoundWorldId, getChatKey, getSettings, saveSettings } from './settings.js?v=0.14.0-standalone.274';
import { ensureCurrentChatMemory, initUI, refreshModelProfiles, renderRuntime, refreshWorlds, restorePendingExtractionReview } from './ui.js?v=0.14.0-standalone.287';
import { resolveInjectionPlacement } from './injection-placement.js';
import { clearPromptManagerInjection, configurePromptManagerInjection } from './prompt-manager-injection.js';
import { resolveInjectionBudget } from './injection-budget.js';
import { resolveDeletedChatBinding, resolveRenamedChatBinding } from './chat-ownership.js?v=0.14.0-standalone.258';
import { collectFingerprintMessages, collectMemoryEligibleMessages, findInvalidExtractionRanges } from './message-digest.js?v=0.14.0-standalone.258';
import { ensureEmbeddingCoverage, purgeEmbeddingIndex, queryEmbeddingMemory, scheduleEmbeddingIndexSync, stopEmbeddingIndexing } from './embedding-retrieval.js?v=0.14.0-standalone.287';
import { isTransientApiError } from './errors.js?v=0.14.0-standalone.273';
import { asRoleplayBlockingError, isRoleplayBlockingError, roleplayBacklogPolicy, roleplaySourceMessages, roleplayWaitNotification, shouldGateRoleplayGeneration, sourceMutationPolicy } from './generation-policy.js?v=0.14.0-standalone.282';
import { completeL1MessageCount, isL1StabilityProtectedMessage, latestCompleteL1MessageIndex, resolveL1GroupSize } from './l1-policy.js';
import { shouldCapturePromptMeasurement } from './prompt-measurement-policy.js';
import { createRetrievalSnapshot, retrievalSnapshotPatch } from './retrieval-snapshot.js?v=0.14.0-standalone.258';
import { resolveStoryBudget } from './story-budget.js?v=0.14.0-standalone.258';
import { createBackgroundScheduler } from './background-scheduler.js';

const PROMPT_KEY = 'continuity_memory_context';
let lastObservedWorldId = null;
let lastObservedWorldRevision = null;
let injectionRefreshRunning = false;
let injectionRefreshPending = false;
let mutationSync = null;
let divergenceRepairRequested = false;
let activeGenerationReadiness = null;
let generationEmbeddingCompletion = null;
let pendingEmbeddingSyncWorld = null;
let injectionRefreshCancel = null;
let injectionRefreshRevision = 0;
let generationInjectionRunning = false;

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

function resolveWithin(value, timeout = 3000) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error('Vector retrieval timed out; local retrieval remains available.')), timeout);
    });
    return Promise.race([value, deadline]).finally(() => {
        if (timer !== null) globalThis.clearTimeout(timer);
    });
}

const backgroundMemoryWork = createBackgroundScheduler(async () => {
    const stopSequence = runtime.stopSequence;
    backgroundCancelled = false;
    let failures = 0;
    while (true) {
        if (backgroundCancelled || runtime.stopSequence !== stopSequence || runtime.paused && !failures) return;
        try {
            const settings = getSettings();
            const processableMessages = collectMemoryEligibleMessages(getContext().chat || []).length;
            if (!getBoundWorldId() && processableMessages >= settings.extractionBatchMessages) {
                await ensureCurrentChatMemory(true);
            }
            // Drain stable, complete L1 groups. The stability buffer remains
            // protected by maybeAutoExtract/selectAutomaticL1Messages.
            const result = await maybeAutoExtract(false);
            if (runtime.stopSequence !== stopSequence || runtime.paused) return;
            failures = 0;
            if (!result) return;
        } catch (error) {
            if (backgroundCancelled || isRuntimeCancellation(error) || error?.code === 'CONTINUITY_BACKGROUND_CANCELLED' || runtime.stopSequence !== stopSequence) return;
            if (!isTransientApiError(error) || failures >= 4) {
                updateRuntime({ lastError: `Automatic memory update failed: ${error.message}` });
                return;
            }
            failures++;
            if (runtime.paused) resumeRuntime();
            const delay = Math.min(20000, 2000 * (2 ** (failures - 1)));
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
    const settings = getSettings();
    if (!shouldGateRoleplayGeneration(settings, coreChat, type)) {
        await reduceChatContext(coreChat, contextSize, abort, type);
        return;
    }
    restorePendingExtractionReview();
    try {
        if (!activeGenerationReadiness) {
            if (mutationSync) clearTimeout(mutationSync);
            mutationSync = null;
            pendingEmbeddingSyncWorld = null;
            activeGenerationReadiness = prepareRoleplayGeneration(type)
                .finally(() => {
                    activeGenerationReadiness = null;
                    updateRuntime({ roleplayGate: null });
                });
        }
        const readiness = await activeGenerationReadiness;
        const reduction = await reduceChatContext(coreChat, contextSize, abort, type);
        await refreshInjection(true, readiness.sourceMessages, readiness.recentMessages, {
            rawTailRange: reduction?.rawTailRange || null,
        });
        if (readiness.notification) showGenerationNotification('success', readiness.notification);
    } catch (error) {
        if (isRoleplayBlockingError(error)) {
            const message = `Continuity cancelled the pending reply safely: ${error.message}`;
            updateRuntime({ status: 'error', lastError: error.message, injectionStatus: message, retryStatus: message, roleplayGate: null });
            console.error('[Continuity] Pending roleplay could not reach its safe memory boundary.', error);
            showGenerationNotification('error', message, { timeOut: 0, extendedTimeOut: 0 });
            throw error;
        }
        // Memory is an enhancement, not a hard dependency for roleplay. A
        // storage/model failure must not cancel the user's generation; fall
        // back to SillyTavern's normal context reduction and raw chat.
        const message = `Continuity was unavailable for this reply; continuing without the latest memory: ${error.message}`;
        updateRuntime({ status: 'error', lastError: error.message, injectionStatus: message, retryStatus: message, roleplayGate: null });
        console.error('[Continuity] Roleplay readiness failed; continuing without fresh memory.', error);
        try {
            await reduceChatContext(coreChat, contextSize, abort, type);
        } catch (reductionError) {
            console.error('[Continuity] Raw context fallback also failed.', reductionError);
        }
        showGenerationNotification('error', message);
    }
};

function waitForPendingRetry(delay, stopSequence) {
    return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = globalThis.setTimeout(() => {
            unsubscribe();
            resolve();
        }, delay);
        const inspect = state => {
            if (state.stopSequence === stopSequence) return;
            globalThis.clearTimeout(timer);
            unsubscribe();
            reject(new Error('Continuity preparation was stopped. Saved memory progress was kept.'));
        };
        unsubscribe = onRuntimeChange(inspect);
        inspect(runtime);
    });
}

async function retryPendingReply(label, stopSequence, work) {
    let failures = 0;
    while (true) {
        assertRoleplayPreparationNotStopped(stopSequence);
        try {
            return await work();
        } catch (error) {
            assertRoleplayPreparationNotStopped(stopSequence);
            failures++;
            const delay = Math.min(20000, 2000 * (2 ** Math.min(4, failures - 1)));
            const seconds = Math.round(delay / 1000);
            const message = `Reply remains pending: ${label} failed (${error.message}). Restarting in ${seconds}s (attempt ${failures + 1})…`;
            updateRuntime({ status: 'preparing-roleplay', lastError: '', retryStatus: message, roleplayGate: { active: true, message, stopping: false, startedAt: runtime.roleplayGate?.startedAt || Date.now() } });
            await waitForPendingRetry(delay, stopSequence);
        }
    }
}

function continueEmbeddingAfterReplyRelease(world, stopSequence) {
    if (!world?.id) return;
    if (generationEmbeddingCompletion?.worldId === world.id) return;
    const completion = (async () => {
        let failures = 0;
        while (runtime.stopSequence === stopSequence) {
            try {
                const result = await ensureEmbeddingCoverage(world, 1, stopSequence);
                if (result?.status === 'ready' || Number(result?.coverage) >= 1) return;
                throw new Error(`Embedding index is ${result?.status || 'not ready'}.`);
            } catch (error) {
                if (runtime.stopSequence !== stopSequence) return;
                failures++;
                const delay = Math.min(20000, 2000 * (2 ** Math.min(4, failures - 1)));
                updateRuntime({
                    lastError: '',
                    retryStatus: `Reply released at safe embedding coverage; full indexing failed (${error.message}). Restarting in ${Math.round(delay / 1000)}s (attempt ${failures + 1})…`,
                });
                try {
                    await waitForPendingRetry(delay, stopSequence);
                } catch {
                    return;
                }
            }
        }
    })();
    generationEmbeddingCompletion = { worldId: world.id, completion };
    completion.finally(() => {
        if (generationEmbeddingCompletion?.completion === completion) generationEmbeddingCompletion = null;
    });
}

function assertRoleplayPreparationNotStopped(stopSequence) {
    if (stopSequence !== null && runtime.stopSequence !== stopSequence) {
        throw new Error('Continuity preparation was stopped. Memory remains pending, so the reply was not generated.');
    }
}

async function waitForActiveMemoryWork(stopSequence = null) {
    assertRoleplayPreparationNotStopped(stopSequence);
    if (runtime.paused) resumeRuntime();
    continueQueue();
    if (!runtime.processing && !runtime.queue.length) return;
    await new Promise((resolve, reject) => {
        let resumedPause = false;
        let unsubscribe = () => {};
        const inspect = state => {
            if (stopSequence !== null && state.stopSequence !== stopSequence) {
                unsubscribe();
                reject(new Error('Continuity preparation was stopped. Memory remains pending, so the reply was not generated.'));
                return;
            }
            if (state.paused && !resumedPause) {
                resumedPause = true;
                resumeRuntime();
                continueQueue();
                return;
            }
            if (state.processing || state.queue.length) return;
            unsubscribe();
            if (state.status === 'error') reject(new Error(state.lastError || 'Existing memory processing failed.'));
            else resolve();
        };
        unsubscribe = onRuntimeChange(inspect);
        inspect(runtime);
    });
}

async function completeL1ForGeneration(sourceMessages, stopSequence) {
    await waitForActiveMemoryWork(stopSequence);
    while (true) {
        assertRoleplayPreparationNotStopped(stopSequence);
        const coverage = getProcessingCoverage(runtime.world, sourceMessages);
        if (!coverage.extractable) return coverage;
        const groupSize = resolveL1GroupSize(getSettings().extractionBatchMessages);
        if (!completeL1MessageCount(coverage.extractable, groupSize)) return coverage;
        if (runtime.paused) resumeRuntime();
        updateRuntime({ status: 'preparing-roleplay', retryStatus: `Roleplay is waiting while Continuity processes ${coverage.extractable} stable pending message(s)…` });
        const result = await maybeAutoExtract(true, sourceMessages);
        assertRoleplayPreparationNotStopped(stopSequence);
        if (!result) throw new Error(`${coverage.extractable} stable memory message(s) remain pending and could not be started.`);
        const updated = getProcessingCoverage(runtime.world, sourceMessages);
        if (updated.extractable >= coverage.extractable) throw new Error(`Memory processing made no progress; ${updated.extractable} stable message(s) remain pending.`);
    }
}

async function completeRequiredL1ForGeneration(sourceMessages, stopSequence) {
    await waitForActiveMemoryWork(stopSequence);
    while (true) {
        assertRoleplayPreparationNotStopped(stopSequence);
        const coverage = getProcessingCoverage(runtime.world, sourceMessages);
        if (!coverage.required) return coverage;
        if (!coverage.requiredExtractable) {
            throw new Error(`${coverage.required} required memory message(s) are not currently safe to rebuild. Roleplay remains blocked so it cannot continue with missing memory.`);
        }
        if (runtime.paused) resumeRuntime();
        updateRuntime({ status: 'preparing-roleplay', retryStatus: `Roleplay is waiting while Continuity rebuilds ${coverage.required} deliberately undone memory message(s)…` });
        const result = await maybeAutoExtract(true, sourceMessages, { requiredOnly: true });
        assertRoleplayPreparationNotStopped(stopSequence);
        if (!result) throw new Error(`${coverage.required} required memory message(s) remain pending and could not be started.`);
        const updated = getProcessingCoverage(runtime.world, sourceMessages);
        if (updated.required >= coverage.required) throw new Error(`Required memory processing made no progress; ${updated.required} message(s) remain incomplete.`);
    }
}

async function completeHierarchyForGeneration(stopSequence) {
    const runLayer = async (builder, label) => {
        let count = 0;
        while (true) {
            assertRoleplayPreparationNotStopped(stopSequence);
            if (runtime.paused) resumeRuntime();
            const epoch = runtime.generation;
            try {
                const record = await builder(undefined, epoch);
                if (!record) return count;
                count++;
                updateRuntime({ retryStatus: `Roleplay is waiting while Continuity completes ${label}…` });
            } catch (error) {
                assertRoleplayPreparationNotStopped(stopSequence);
                if (runtime.paused || /processing stopped/i.test(error.message)) {
                    resumeRuntime();
                    continue;
                }
                throw error;
            }
        }
    };
    updateRuntime({ processing: true, status: 'preparing-roleplay', retryStatus: 'L1 is ready. Completing eligible L2 and L3 before roleplay…' });
    try {
        const arcs = await runLayer(buildNextArc, 'L2');
        const eras = await runLayer(buildNextEra, 'L3');
        return { arcs, eras };
    } finally {
        updateRuntime({ processing: false, progress: null });
    }
}

async function prepareRoleplayGeneration(type) {
    const updates = [];
    await ensureCurrentChatMemory(true);
    const waitingChat = roleplaySourceMessages(getContext().chat || [], type).filter(message => !message?.is_system);
    const waitingMessages = collectMemoryEligibleMessages(waitingChat);
    const waitingCoverage = getProcessingCoverage(runtime.world, waitingMessages);
    const groupSize = resolveL1GroupSize(getSettings().extractionBatchMessages);
    const waitingBacklog = roleplayBacklogPolicy(waitingCoverage.extractable, groupSize, waitingCoverage.required);
    const activeWorkAtStart = runtime.processing || runtime.queue.length > 0;
    // At two full pending L1 batches, keep this reply pending until memory catches up.
    const blocksRoleplay = waitingBacklog.shouldCatchUp;
    const waitingNotification = blocksRoleplay
        ? roleplayWaitNotification(runtime, waitingBacklog.blocking)
        : '';
    const stopSequence = runtime.stopSequence;
    if (waitingNotification) {
        updateRuntime({ roleplayGate: { active: true, message: waitingNotification, stopping: false, startedAt: Date.now() } });
        showGenerationNotification('info', waitingNotification, { timeOut: 12000, extendedTimeOut: 4000 });
    }
    const revisionBeforeWaiting = Number(runtime.world?.revision ?? -1);
    if (blocksRoleplay) {
        try {
            await retryPendingReply('memory processing', stopSequence, () => waitForActiveMemoryWork(stopSequence));
        } catch (error) {
            throw asRoleplayBlockingError(error, 'Memory catch-up failed;');
        }
    }
    const activeChat = roleplaySourceMessages(getContext().chat || [], type).filter(message => !message?.is_system);
    const sourceMessages = collectMemoryEligibleMessages(activeChat);
    // This repair must precede every injection and every catch-up attempt.
    // It removes stale saved contributions after edits, swipes, and deletes;
    // refreshInjection also excludes any still-invalid source ranges fail-closed.
    let repair;
    try {
        repair = await repairDivergedBranch({ sourceMessages });
    } catch (error) {
        if (waitingBacklog.shouldCatchUp) throw asRoleplayBlockingError(error, 'The pending reply could not validate changed memory;');
        throw error;
    }
    if (repair.repaired) {
        if (repair.divergenceDetected) updates.push(`repaired changed memory from message ${repair.repairFrom} onward`);
        if (repair.stabilityRewound) updates.push('restored the two-message extraction buffer');
    }
    const initialCoverage = getProcessingCoverage(runtime.world, sourceMessages);
    const initialBacklog = roleplayBacklogPolicy(initialCoverage.extractable, groupSize, initialCoverage.required);
    let hierarchy = { arcs: 0, eras: 0 };
    if (initialBacklog.shouldCatchUp) {
        if (!runtime.roleplayGate) {
            updateRuntime({
                roleplayGate: {
                    active: true,
                    message: `Reply pending while Continuity processes ${initialBacklog.blocking} memory message(s)…`,
                    stopping: false,
                    startedAt: Date.now(),
                },
            });
        }
        try {
            await retryPendingReply('memory catch-up', stopSequence, async () => {
                if (initialCoverage.required) await completeRequiredL1ForGeneration(sourceMessages, stopSequence);
                await completeL1ForGeneration(sourceMessages, stopSequence);
                hierarchy = await completeHierarchyForGeneration(stopSequence);
            });
        } catch (error) {
            throw asRoleplayBlockingError(error, 'The pending reply could not finish memory catch-up;');
        }
    }
    if (getSettings().retrievalMode === 'embedding-hybrid' && runtime.world?.id) {
        const message = 'Reply pending while Continuity prepares at least 99% of the selected embedding index…';
        if (!runtime.roleplayGate) {
            updateRuntime({
                status: 'preparing-roleplay',
                retryStatus: message,
                roleplayGate: { active: true, message, stopping: false, startedAt: Date.now() },
            });
        }
        try {
            await retryPendingReply(
                'embedding coverage',
                stopSequence,
                () => ensureEmbeddingCoverage(runtime.world, undefined, stopSequence),
            );
            // Reaching the safe generation threshold releases the reply, but
            // the selected index must keep building to 100%. If a later batch
            // fails, restart it in the background until the user explicitly
            // stops generation or presses Continuity's Stop processing.
            continueEmbeddingAfterReplyRelease(runtime.world, stopSequence);
        } catch (error) {
            throw asRoleplayBlockingError(error, 'The pending reply could not reach the required 99% embedding coverage;');
        }
    }
    assertRoleplayPreparationNotStopped(stopSequence);
    const coverage = getProcessingCoverage(runtime.world, sourceMessages);
    const remainingBacklog = roleplayBacklogPolicy(coverage.extractable, groupSize, coverage.required);
    if (remainingBacklog.shouldCatchUp) {
        throw asRoleplayBlockingError(
            new Error(`${remainingBacklog.blocking} memory message(s) remain beyond the safe pending boundary.`),
            'The pending reply was cancelled safely;',
        );
    }
    const processedMessages = Math.max(0, initialCoverage.pending - coverage.pending);
    if (processedMessages) updates.push(`processed ${processedMessages} message(s) into L1`);
    if (hierarchy.arcs) updates.push(`created ${hierarchy.arcs} L2 record(s)`);
    if (hierarchy.eras) updates.push(`created ${hierarchy.eras} L3 record(s)`);
    if (activeWorkAtStart && Number(runtime.world?.revision ?? -1) !== revisionBeforeWaiting && !updates.length) {
        updates.push('completed pending memory work');
    }
    const retainedError = runtime.paused ? runtime.lastError : '';
    const retryStatus = coverage.pending
        ? `Continuity is ready with ${coverage.pending} recent message(s) raw (${coverage.buffered} protected by the stability buffer); background L1 may trail safely up to ${remainingBacklog.hardLimit - 1} additional stable messages.`
        : 'Continuity is fully ready. Starting roleplay generation…';
    updateRuntime(retainedError
        ? { status: runtime.paused ? 'paused' : 'error', lastError: retainedError, retryStatus }
        : { status: 'idle', lastError: '', retryStatus });
    const settings = getSettings();
    const recentLimit = Math.max(Number(settings.retrievalQueryMessages) || 6, Number(settings.embeddingQueryMessages) || 4);
    const notification = updates.length ? `Continuity updated before roleplay: ${updates.join('; ')}.` : '';
    return { sourceMessages, recentMessages: activeChat.slice(-recentLimit), notification };
}

async function performInjectionRefresh(useRetrievalAssist, coverageMessages, recentMessages, promptOptions, refreshRevision) {
    const settings = getSettings();
    const phase = useRetrievalAssist ? 'generation' : 'preview';
    const placement = resolveInjectionPlacement(settings, extension_prompt_types, extension_prompt_roles);
    const refreshIsCurrent = () => injectionRefreshIsCurrent(refreshRevision);
    if (!settings.enabled || !getBoundWorldId()) {
        if (!refreshIsCurrent()) return;
        setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
        const injectionStatus = !settings.enabled
            ? 'Continuity Memory is disabled.'
            : 'No stored memory yet; it will be created when extraction begins.';
        updateRuntime({ lastInjection: '', lastInjectionTokens: 0, injectionStatus });
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
        : (getContext().chat || []).filter(message => !message?.is_system).slice(-Math.max(
            Number(settings.retrievalQueryMessages) || 6,
            Number(settings.embeddingQueryMessages) || 4,
        ));
    const queryMessageLimit = settings.retrievalMode === 'embedding-hybrid'
        ? Math.min(12, Math.max(1, Number(settings.embeddingQueryMessages) || 4))
        : Math.min(50, Math.max(2, Number(settings.retrievalQueryMessages) || 6));
    const recent = availableRecent.slice(-queryMessageLimit);
    let expandedTerms = [];
    let semanticRanks = new Map();
    let retrievalAssist = { mode: settings.retrievalMode, phase, executed: false, terms: [], fallback: false };
    if (settings.retrievalMode === 'ai-expanded' && useRetrievalAssist) {
        try {
            expandedTerms = await expandRetrievalTerms(recent);
            if (!refreshIsCurrent()) return;
            retrievalAssist = {
                mode: 'ai-expanded',
                phase,
                executed: true,
                terms: expandedTerms,
                fallback: false,
                error: null,
            };
            updateRuntime({ retrievalAssist });
        } catch (error) {
            if (!refreshIsCurrent()) return;
            const message = `AI-expanded retrieval is selected but failed: ${error.message}`;
            console.error('[Continuity] AI retrieval expansion failed; local matching was not substituted.', error);
            setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
            retrievalAssist = {
                mode: 'ai-expanded',
                phase,
                executed: false,
                terms: [],
                fallback: false,
                error: error.message,
            };
            updateRuntime({
                lastInjection: '',
                lastInjectionTokens: 0,
                injectionStatus: `${message} No local memory was injected.`,
                lastError: message,
                retrievalAssist,
            });
            if (useRetrievalAssist) throw new Error(message, { cause: error });
            return;
        }
    } else if (settings.retrievalMode === 'ai-expanded') {
        // Opening or changing a chat should never spend an AI request merely
        // to populate the settings preview. Actual roleplay generation runs
        // the authoritative AI-expanded retrieval immediately above.
        retrievalAssist = { mode: 'ai-expanded', phase, executed: false, terms: [], fallback: false };
        updateRuntime({ retrievalAssist });
    } else if (useRetrievalAssist && settings.retrievalMode === 'embedding-hybrid') {
        try {
            // Vector indexing is maintained in the background. Query the
            // currently stored near-complete index immediately; a slow vector
            // service must not strand SillyTavern generation.
            semanticRanks = await resolveWithin(queryEmbeddingMemory(world, recent));
            if (!refreshIsCurrent()) return;
            retrievalAssist = { mode: 'embedding-hybrid', phase, executed: true, hits: semanticRanks.size, fallback: false };
            updateRuntime({ retrievalAssist });
        } catch (error) {
            if (!refreshIsCurrent()) return;
            console.warn('[Continuity] Embedding retrieval failed; using local matching.', error);
            showGenerationNotification(
                'warning',
                'Embedding retrieval was unavailable or slow, so this reply is using local memory matching. Vector work will continue in the background.',
            );
            retrievalAssist = { mode: 'local', phase, executed: true, terms: [], fallback: true, error: error.message };
            updateRuntime({ retrievalAssist });
        }
    } else if (settings.retrievalMode === 'embedding-hybrid') {
        retrievalAssist = { mode: 'embedding-hybrid', phase, executed: false, hits: 0, fallback: false };
        updateRuntime({ retrievalAssist });
    } else if (settings.retrievalMode === 'local') {
        retrievalAssist = { mode: 'local', phase, executed: true, terms: [], fallback: false };
        updateRuntime({ retrievalAssist });
    }
    const budget = resolveInjectionBudget(settings.injectionBudgetTokens, getContext().maxContext);
    const storyBudget = resolveStoryBudget(settings.storySoFarTokens, getContext().maxContext);
    const sourceMessages = Array.isArray(coverageMessages)
        ? coverageMessages
        : collectMemoryEligibleMessages(getContext().chat || []);
    const coverage = getProcessingCoverage(world, sourceMessages);
    const invalidSourceRanges = findInvalidExtractionRanges(world, sourceMessages, getChatKey());
    await yieldToBrowser();
    if (!refreshIsCurrent()) return;
    await prepareRetrievalCorpus(world, yieldToBrowser, refreshIsCurrent);
    if (!refreshIsCurrent()) return;
    const { prompt, estimatedTokens, retrievalDiagnostics } = buildMemoryPrompt(
        world,
        recent,
        budget.tokens,
        getChatKey(),
        expandedTerms,
        settings.injectionInstruction,
        semanticRanks,
        { ...promptOptions, invalidSourceRanges, includeSceneCheckpoint: coverage.pending === 0, includeStorySoFar: settings.storySoFarEnabled, storySoFarTokens: storyBudget.tokens },
    );
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
        ? `Ready to inject approximately ${estimatedTokens} tokens via ${placementStatus} (${budget.mode} recall allowance: ${budget.tokens} tokens${settings.storySoFarEnabled ? ` + ${storyBudget.mode} story allowance: ${storyBudget.tokens} tokens` : ''}).`
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
    updateRuntime({
        lastInjection: prompt,
        lastInjectionTokens: estimatedTokens,
        retrievalDiagnostics,
        injectionBudget: budget,
        injectionStatus,
        ...retrievalSnapshotPatch(retrievalSnapshot),
    });
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
    if (generationInjectionRunning) {
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
        injectionRefreshRunning = true;
        try {
            await refreshInjection();
        } catch (error) {
            updateRuntime({ lastError: `Injection failed: ${error.message}` });
        } finally {
            injectionRefreshRunning = false;
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
    return isL1StabilityProtectedMessage(allMessages, eligibleMessages, messageIndex);
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
            if (result?.deferred) scheduleMutationSync(1000);
            else if (result?.repaired || result?.synced) await refreshInjection();
        } catch (error) {
            if (repairRequested) divergenceRepairRequested = true;
            updateRuntime({ lastError: `Live memory update failed: ${error.message}` });
        }
    }, delay);
}

async function onChatChanged() {
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
        lastInjection: '',
        lastInjectionTokens: 0,
        injectionStatus: 'Loading this chat’s memory…',
        lastGenerationRetrieval: null,
        nextRetrievalPreview: null,
    });
    await refreshWorlds();
    scheduleInjectionRefresh();
    scheduleMutationSync();
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
    const templateResponse = await fetch(new URL('./settings.html?v=0.14.0-standalone.282', import.meta.url));
    if (!templateResponse.ok) throw new Error(`Could not load settings template: ${templateResponse.status} ${templateResponse.statusText}`);
    const html = $(await templateResponse.text());
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('Extensions settings container was not found.');
    container.appendChild(html[0]);
    initUI();

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
    eventSource.on(event_types.GENERATION_STARTED, async (type, _params, dryRun) => {
        // Start safe background catch-up as soon as the user asks for a
        // message. It runs independently while the model generates.
        if (!dryRun) backgroundMemoryWork.schedule(0);
        // Ordinary roleplay generations are refreshed later by the interceptor
        // with the complete user turn. Do not issue an early request against
        // stale chat text or overwrite its authoritative retrieval diagnostics.
        if (!dryRun && shouldGateRoleplayGeneration(getSettings(), getContext().chat || [], type)) return;
        try { await refreshInjection(false); }
        catch (error) { updateRuntime({ lastError: `Could not prepare memory: ${error.message}` }); }
    });
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            if (!activeGenerationReadiness && !generationEmbeddingCompletion) return;
            stopEmbeddingIndexing();
            stopRuntime('Pending reply stopped by the user. Saved memory and completed vectors were kept.');
        });
    }
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        scheduleInjectionRefresh();
        backgroundMemoryWork.schedule();
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, eventData => {
        if (!shouldCapturePromptMeasurement(eventData)) return;
        captureChatCompletionOverhead();
        clearPromptManagerInjection(promptManager);
    });
    for (const eventName of [event_types.MESSAGE_SWIPED, event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED].filter(Boolean)) {
        eventSource.on(eventName, messageIndex => {
            // Changes inside the stability tail cannot overlap newly queued L1
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

    onRuntimeChange(state => {
        const worldId = state.world?.id || null;
        const worldRevision = state.world?.revision ?? null;
        if (!state.world) pendingEmbeddingSyncWorld = null;
        if (worldId !== lastObservedWorldId || worldRevision !== lastObservedWorldRevision) {
            const changedDuringSession = Boolean(worldId && worldId === lastObservedWorldId && lastObservedWorldRevision !== null);
            lastObservedWorldId = worldId;
            lastObservedWorldRevision = worldRevision;
            scheduleInjectionRefresh();
            if (state.world && !activeGenerationReadiness) {
                if (state.processing) pendingEmbeddingSyncWorld = state.world;
                else scheduleEmbeddingIndexSync(state.world, 300, changedDuringSession);
            }
        }
        if (!state.processing && !activeGenerationReadiness && pendingEmbeddingSyncWorld) {
            const world = pendingEmbeddingSyncWorld;
            pendingEmbeddingSyncWorld = null;
            scheduleEmbeddingIndexSync(world, 300, true);
        }
    });

    scheduleInjectionRefresh();
    scheduleMutationSync();
    renderRuntime();
    console.log('[Continuity] Extension loaded');
}

await init();
