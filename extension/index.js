import { eventSource, event_types, extension_prompt_roles, extension_prompt_types, setExtensionPrompt } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { promptManager } from '/scripts/openai.js';
import { api } from './api.js?v=0.14.0-standalone.50';
import { captureChatCompletionOverhead, captureTextCompletionOverhead, reduceChatContext } from './context-reducer.js';
import { applyExtractionRequestSettings, buildNextArc, buildNextEra, continueQueue, getProcessingCoverage, getTailRollbackStatus, loadBoundWorld, maybeAutoExtract, repairDivergedBranch, syncChangedExtractions } from './engine.js';
import { buildMemoryPrompt } from './retrieval.js';
import { expandRetrievalTerms } from './semantic-retrieval.js?v=0.14.0-standalone.50';
import { onRuntimeChange, resumeRuntime, runtime, updateRuntime } from './runtime.js';
import { getBoundWorldId, getChatKey, getSettings, saveSettings } from './settings.js';
import { ensureCurrentChatMemory, initUI, refreshModelProfiles, renderRuntime, refreshWorlds } from './ui.js?v=0.14.0-standalone.50';
import { resolveInjectionPlacement } from './injection-placement.js';
import { clearPromptManagerInjection, configurePromptManagerInjection } from './prompt-manager-injection.js';
import { resolveInjectionBudget } from './injection-budget.js';
import { resolveDeletedChatBinding, resolveRenamedChatBinding } from './chat-ownership.js?v=0.14.0-standalone.50';
import { collectFingerprintMessages, findInvalidExtractionRanges } from './fingerprint.js';
import { purgeEmbeddingIndex, queryEmbeddingMemory, resumeEmbeddingIndexing, scheduleEmbeddingIndexSync } from './embedding-retrieval.js?v=0.14.0-standalone.50';
import { roleplaySourceMessages, roleplayWaitNotification, shouldGateRoleplayGeneration } from './generation-policy.js';
import { completeL1MessageCount, resolveL1GroupSize } from './l1-policy.js';

const PROMPT_KEY = 'continuity_memory_context';
let lastObservedWorldId = null;
let lastObservedWorldRevision = null;
let injectionRefresh = null;
let mutationSync = null;
let divergenceRepairRequested = false;
let activeGenerationReadiness = null;
let pendingEmbeddingSyncWorld = null;

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
    try {
        if (!activeGenerationReadiness) {
            if (mutationSync) clearTimeout(mutationSync);
            mutationSync = null;
            pendingEmbeddingSyncWorld = null;
            activeGenerationReadiness = prepareRoleplayGeneration(type)
                .finally(() => { activeGenerationReadiness = null; });
        }
        const readiness = await activeGenerationReadiness;
        const reduction = await reduceChatContext(coreChat, contextSize, abort, type);
        await refreshInjection(true, true, readiness.sourceMessages, readiness.recentMessages, {
            rawTailRange: reduction?.rawTailRange || null,
        });
        if (readiness.notification) showGenerationNotification('success', readiness.notification);
    } catch (error) {
        abort(true);
        const message = `Roleplay generation stopped until Continuity is ready: ${error.message}`;
        updateRuntime({ status: 'error', lastError: error.message, injectionStatus: message, retryStatus: message });
        console.error('[Continuity] Roleplay readiness gate stopped generation.', error);
        showGenerationNotification('error', message);
    }
};

async function waitForActiveMemoryWork() {
    if (runtime.paused) resumeRuntime();
    continueQueue();
    if (!runtime.processing && !runtime.queue.length) return;
    await new Promise((resolve, reject) => {
        let resumedPause = false;
        let unsubscribe = () => {};
        const inspect = state => {
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

async function completeL1ForGeneration(sourceMessages) {
    await waitForActiveMemoryWork();
    while (true) {
        const coverage = getProcessingCoverage(runtime.world, sourceMessages);
        if (!coverage.pending) return coverage;
        const groupSize = resolveL1GroupSize(getSettings().extractionBatchMessages);
        if (!completeL1MessageCount(coverage.pending, groupSize)) return coverage;
        if (runtime.paused) resumeRuntime();
        updateRuntime({ status: 'preparing-roleplay', retryStatus: `Roleplay is waiting while Continuity processes ${coverage.pending} pending message(s)…` });
        const result = await maybeAutoExtract(true, sourceMessages);
        if (!result) throw new Error(`${coverage.pending} memory message(s) remain pending and could not be started.`);
        const updated = getProcessingCoverage(runtime.world, sourceMessages);
        if (updated.pending >= coverage.pending) throw new Error(`Memory processing made no progress; ${updated.pending} message(s) remain pending.`);
    }
}

async function completeHierarchyForGeneration() {
    const runLayer = async (builder, label) => {
        let count = 0;
        while (true) {
            if (runtime.paused) resumeRuntime();
            const epoch = runtime.generation;
            try {
                const record = await builder(undefined, epoch);
                if (!record) return count;
                count++;
                updateRuntime({ retryStatus: `Roleplay is waiting while Continuity completes ${label}…` });
            } catch (error) {
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

async function completeVectorsForGeneration() {
    if (getSettings().retrievalMode !== 'embedding-hybrid') return null;
    if (!runtime.world?.id) throw new Error('The selected memory is unavailable for vector indexing.');
    updateRuntime({ status: 'preparing-roleplay', retryStatus: 'Memory is ready. Completing the selected vector index before roleplay…' });
    while (true) {
        const result = await resumeEmbeddingIndexing(runtime.world);
        if (result?.status === 'ready') return result;
        if (!['paused', 'stopped'].includes(result?.status)) throw new Error(`Vector index is ${result?.status || 'not ready'}.`);
    }
}

async function prepareRoleplayGeneration(type) {
    const updates = [];
    await ensureCurrentChatMemory(true);
    const waitingChat = roleplaySourceMessages(getContext().chat || [], type).filter(message => !message?.is_system);
    const waitingMessages = collectFingerprintMessages(waitingChat);
    const waitingCoverage = getProcessingCoverage(runtime.world, waitingMessages);
    const eligibleAtStart = completeL1MessageCount(waitingCoverage.pending, getSettings().extractionBatchMessages);
    const waitingNotification = roleplayWaitNotification(runtime, eligibleAtStart);
    if (waitingNotification) showGenerationNotification('info', waitingNotification, { timeOut: 12000, extendedTimeOut: 4000 });
    const revisionBeforeWaiting = Number(runtime.world?.revision ?? -1);
    const existingWork = runtime.processing || runtime.queue.length || runtime.paused;
    await waitForActiveMemoryWork();
    const activeChat = roleplaySourceMessages(getContext().chat || [], type).filter(message => !message?.is_system);
    const sourceMessages = collectFingerprintMessages(activeChat);
    const repair = await repairDivergedBranch({ sourceMessages });
    if (repair.repaired) updates.push(`repaired changed memory from message ${repair.repairFrom} onward`);
    const initialCoverage = getProcessingCoverage(runtime.world, sourceMessages);
    await completeL1ForGeneration(sourceMessages);
    const hierarchy = await completeHierarchyForGeneration();
    const coverage = getProcessingCoverage(runtime.world, sourceMessages);
    const eligiblePending = completeL1MessageCount(coverage.pending, getSettings().extractionBatchMessages);
    if (eligiblePending) throw new Error(`${eligiblePending} eligible memory message(s) are still pending.`);
    const vectors = await completeVectorsForGeneration();
    const processedMessages = Math.max(0, initialCoverage.pending - coverage.pending);
    if (processedMessages) updates.push(`processed ${processedMessages} message(s) into L1`);
    if (hierarchy.arcs) updates.push(`created ${hierarchy.arcs} L2 record(s)`);
    if (hierarchy.eras) updates.push(`created ${hierarchy.eras} L3 record(s)`);
    const vectorAdded = Math.max(0, Number(vectors?.added) || 0);
    const vectorRemoved = Math.max(0, Number(vectors?.removed) || 0);
    if (vectorAdded || vectorRemoved) updates.push(`updated vectors (+${vectorAdded}, -${vectorRemoved})`);
    if (existingWork && Number(runtime.world?.revision ?? -1) !== revisionBeforeWaiting && !updates.length) {
        updates.push('completed pending memory work');
    }
    updateRuntime({
        status: 'idle',
        lastError: '',
        retryStatus: coverage.pending
            ? `Continuity is ready. ${coverage.pending} recent message(s) remain raw until the next complete L1 group.`
            : 'Continuity is fully ready. Starting roleplay generation…',
    });
    const settings = getSettings();
    const recentLimit = Math.max(Number(settings.retrievalQueryMessages) || 6, Number(settings.embeddingQueryMessages) || 4);
    const notification = updates.length ? `Continuity updated before roleplay: ${updates.join('; ')}.` : '';
    return { sourceMessages, recentMessages: activeChat.slice(-recentLimit), notification };
}

async function refreshInjection(useRetrievalAssist = false, strictEmbedding = false, coverageMessages = null, recentMessages = null, promptOptions = {}) {
    const settings = getSettings();
    const placement = resolveInjectionPlacement(settings, extension_prompt_types, extension_prompt_roles);
    if (!settings.enabled || !getBoundWorldId()) {
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
            setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
            updateRuntime({ world: null, lastInjection: '', lastInjectionTokens: 0, injectionStatus: message, lastError: message });
            return;
        }
    }
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
    if (useRetrievalAssist && settings.retrievalMode === 'ai-expanded') {
        try {
            expandedTerms = await expandRetrievalTerms(recent);
            updateRuntime({ retrievalAssist: { mode: 'ai-expanded', terms: expandedTerms, fallback: false } });
        } catch (error) {
            console.warn('[Continuity] AI retrieval expansion failed; using local matching.', error);
            updateRuntime({ retrievalAssist: { mode: 'local', terms: [], fallback: true, error: error.message } });
        }
    } else if (useRetrievalAssist && settings.retrievalMode === 'embedding-hybrid') {
        try {
            semanticRanks = await queryEmbeddingMemory(world, recent);
            updateRuntime({ retrievalAssist: { mode: 'embedding-hybrid', hits: semanticRanks.size, fallback: false } });
        } catch (error) {
            if (strictEmbedding) throw new Error(`Selected vector retrieval is not ready: ${error.message}`, { cause: error });
            console.warn('[Continuity] Embedding retrieval failed; using local matching.', error);
            updateRuntime({ retrievalAssist: { mode: 'local', terms: [], fallback: true, error: error.message } });
        }
    } else if (settings.retrievalMode === 'local') {
        updateRuntime({ retrievalAssist: { mode: 'local', terms: [], fallback: false } });
    }
    const budget = resolveInjectionBudget(settings.injectionBudgetTokens, getContext().maxContext);
    const sourceMessages = Array.isArray(coverageMessages)
        ? coverageMessages
        : collectFingerprintMessages(getContext().chat || []);
    const coverage = getProcessingCoverage(world, sourceMessages);
    const invalidSourceRanges = findInvalidExtractionRanges(world, sourceMessages, getChatKey());
    const { prompt, estimatedTokens } = buildMemoryPrompt(
        world,
        recent,
        budget.tokens,
        getChatKey(),
        expandedTerms,
        settings.injectionInstruction,
        semanticRanks,
        { ...promptOptions, invalidSourceRanges, includeSceneCheckpoint: coverage.pending === 0 },
    );
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
    updateRuntime({ lastInjection: prompt, lastInjectionTokens: estimatedTokens, injectionBudget: budget, injectionStatus: prompt ? `Ready to inject approximately ${estimatedTokens} tokens via ${placementStatus} (${budget.mode} budget: ${budget.tokens} tokens).` : 'The selected memory has no injectable records yet.' });
}

function scheduleInjectionRefresh() {
    if (injectionRefresh) clearTimeout(injectionRefresh);
    injectionRefresh = setTimeout(() => {
        injectionRefresh = null;
        refreshInjection().catch(error => updateRuntime({ lastError: `Injection failed: ${error.message}` }));
    }, 100);
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
        const repairRequested = divergenceRepairRequested;
        divergenceRepairRequested = false;
        try {
            // A deletion shifts later message indexes, so exact-range replacement
            // is unsafe. Remove the divergent suffix first; ordinary edits and
            // swipes retain the cheaper exact extraction replacement path.
            const rollback = getTailRollbackStatus();
            const result = repairRequested || rollback.detected
                ? await repairDivergedBranch()
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
    const settings = getSettings();
    const placement = resolveInjectionPlacement(settings, extension_prompt_types, extension_prompt_roles);
    setExtensionPrompt(PROMPT_KEY, '', placement.position, placement.depth, false, placement.role);
    updateRuntime({ world: null, lastInjection: '', lastInjectionTokens: 0, injectionStatus: 'Loading this chat’s memory…' });
    await refreshWorlds();
    await refreshInjection();
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
    if (!sharedElsewhere) {
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
    if (getChatKey() === newChatKey) await onChatChanged();
}

async function init() {
    const templateResponse = await fetch(new URL('./settings.html', import.meta.url));
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
    eventSource.on(event_types.GENERATION_STARTED, async () => {
        try { await refreshInjection(false); }
        catch (error) { updateRuntime({ lastError: `Could not prepare memory: ${error.message}` }); }
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        scheduleInjectionRefresh();
        setTimeout(async () => {
            try {
                const settings = getSettings();
                const processableMessages = collectFingerprintMessages(getContext().chat || []).length;
                if (!getBoundWorldId() && processableMessages >= settings.extractionBatchMessages) {
                    await ensureCurrentChatMemory(true);
                }
                await maybeAutoExtract(false);
            } catch (error) {
                updateRuntime({ lastError: `Automatic extraction failed: ${error.message}` });
            }
        }, 250);
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, eventData => {
        captureChatCompletionOverhead();
        if (!eventData?.dryRun) clearPromptManagerInjection(promptManager);
    });
    for (const eventName of [event_types.MESSAGE_SWIPED, event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED].filter(Boolean)) {
        eventSource.on(eventName, () => {
            scheduleInjectionRefresh();
            scheduleMutationSync();
        });
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            scheduleInjectionRefresh();
            scheduleMutationSync(350, true);
        });
    }
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

    await refreshInjection();
    scheduleMutationSync();
    renderRuntime();
    console.log('[Continuity] Extension loaded');
}

await init();
