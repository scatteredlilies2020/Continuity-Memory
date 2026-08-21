import { characters, getRequestHeaders, saveChatConditional, this_chid } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { SECRET_KEYS, secret_state, writeSecret } from '/scripts/secrets.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '/scripts/popup.js';
import { api } from './api.js';
import { buildNextArc, buildNextEra, commitMemoryCorrection, continueQueue, deleteRollingStory, eraseAllMemory, getLatestL1UndoStatus, getProcessingCoverage, getTailRollbackStatus, loadBoundWorld, maybeAutoExtract, rebuildRollingStory, repairDivergedBranch, repairTailRollback, restartHierarchyFromL1, restartL1FromScratch, reviewMemoryCorrection, testExtractor, undoLatestL1 } from './engine.js?v=0.14.0-standalone.204';
import { freshResetResiduals, worldCounts } from './memory-model.js';
import { clearPortableSnapshot, embedWorldInChat, getPortableSnapshot } from './portable.js';
import { buildMemoryPrompt } from './retrieval.js?v=0.14.0-standalone.204';
import { clearRetrievalExpansionCache } from './semantic-retrieval.js';
import { sanitizeChatExport } from './chat-sanitizer.js';
import { MEMORY_VIEW_CATEGORIES, memoryViewerPage } from './memory-viewer.js';
import { formatCorrectionPreview } from './memory-correction.js';
import { resolveCorrectionResponseTokens } from './correction-policy.js';
import { createContinuationPackage, prepareContinuationWorld } from './continuation-handoff.js';
import { approveExtractionReview, regenerateExtractionReview, revertExtractionReviewDraft, selectExtractionReviewCandidate, updateExtractionReviewDraft } from './extraction-review.js';
import { alignWorldToChat, collectFingerprintMessages, collectMemoryEligibleMessages } from './message-digest.js?v=0.14.0-standalone.204';
import { resolveMissingWorldBinding } from './chat-ownership.js?v=0.14.0-standalone.204';
import { isRuntimeCancellation, runtime, onRuntimeChange, resumeRuntime, stopRuntime, stopRuntimeTask, updateRuntime } from './runtime.js?v=0.14.0-standalone.204';
import { completeL1MessageCount, resolveL1GroupSize, validateL1GroupSize } from './l1-policy.js';
import { resolveInjectionBudget } from './injection-budget.js';
import { bindCurrentChat, getBoundWorldId, getChatKey, getSettings, markWorldDeleted, resetConfigurationSettings, resetPromptSettings, saveSettings } from './settings.js?v=0.14.0-standalone.204';
import { embeddingProviderDescription, pauseEmbeddingIndexing, purgeEmbeddingIndex, rebuildEmbeddingIndex, resumeEmbeddingIndexing, scheduleEmbeddingIndexSync, stopEmbeddingIndexing } from './embedding-retrieval.js?v=0.14.0-standalone.204';
import { embeddingModelChoices, resolveEmbeddingProvider } from './embedding-provider.js?v=0.14.0-standalone.204';
import { embedPortableMemoryInChatExport, getPortableSnapshotFromChatExport, parseChatExport, removePortableMemoryFromChatExport } from './chat-export-portability.js';
import { forkWorldToBranch } from './branch-cache.js?v=0.14.0-standalone.204';
import { clampReviewFontSize, DEFAULT_REVIEW_FONT_SIZE, extractionReviewRecoveryAction, pinchedReviewFontSize, REVIEW_FONT_STEP, touchDistance } from './review-display.js?v=0.14.0-standalone.204';
import { retrievalSnapshotDiagnostics } from './retrieval-snapshot.js?v=0.14.0-standalone.204';
import { resolveStoryBudget } from './story-budget.js?v=0.14.0-standalone.204';
import { createRenderScheduler } from './render-scheduler.js';

let worlds = [];
let creatingChatMemory = null;
let pendingCorrection = null;
let viewerCategory = 'l1';
let viewerSearch = '';
let viewerPage = 0;
let viewerSignature = '';
let extractionReviewSession = null;
let reviewRecoveryListenersInstalled = false;
let nativeChatExportBridgeInstalled = false;
const DIRECT_PROFILE_ID = '__direct__';

function setControlValue(selector, value) {
    const element = document.querySelector(selector);
    if (!element) return;
    const next = String(value ?? '');
    if (element.value !== next) element.value = next;
}

function setElementText(selector, value) {
    const element = document.querySelector(selector);
    if (!element) return;
    const next = String(value ?? '');
    if (element.textContent !== next) element.textContent = next;
}

function setElementHtml(selector, value) {
    const element = document.querySelector(selector);
    if (!element) return;
    const next = String(value ?? '');
    if (element.innerHTML !== next) element.innerHTML = next;
}

function branchParentChatKey() {
    const parentChatId = String(getContext().chatMetadata?.main_chat || '').trim();
    return parentChatId ? exportChatKey(parentChatId) : '';
}

function verifyMemoryAlignment(world, { allowBranchReuse = false, sourceChatKey = '' } = {}) {
    const context = getContext();
    const branchAlignment = allowBranchReuse && sourceChatKey
        ? forkWorldToBranch(world, collectMemoryEligibleMessages(context.chat || []), getChatKey(), sourceChatKey)
        : null;
    const alignment = branchAlignment?.ok
        ? branchAlignment
        : alignWorldToChat(world, collectFingerprintMessages(context.chat || []), getChatKey());
    const { world: ignored, ...diagnostic } = alignment;
    updateRuntime({ importAlignment: diagnostic });
    if (!alignment.ok) throw new Error(alignment.message);
    return alignment;
}

function toast(type, message) {
    if (!getSettings().showNotifications) return;
    if (window.toastr?.[type]) window.toastr[type](message, 'Continuity Memory');
    else console[type === 'error' ? 'error' : 'log'](`[Continuity] ${message}`);
}

function extractionReviewTitle(review) {
    const sourceLayer = review.layer === 'L3' ? 'L2' : 'L1';
    return review.layer === 'L1'
        ? `Review L1 · messages ${review.from}–${review.to}`
        : `Review ${review.layer} · ${review.sourceCount} ${sourceLayer} record(s)`;
}

function extractionReviewStopMessage(review) {
    if (review.layer === 'L1') {
        return 'Generation stopped because the reviewed L1 candidate was discarded instead of saved. Its source messages remain pending and can be generated again later.';
    }
    const sourceLayer = review.layer === 'L3' ? 'L2' : 'L1';
    return `Generation stopped because the reviewed ${review.layer} candidate was discarded instead of saved. Its source ${sourceLayer} records remain available for another build.`;
}

function applyExtractionReviewFontSize(session, value, persist = true) {
    const size = clampReviewFontSize(value);
    session.fontSize = size;
    session.editor.style.fontSize = `${size}px`;
    session.fontSizeLabel.textContent = `${size}px`;
    session.fontSizeLabel.setAttribute('aria-label', `Review text size ${size} pixels. Reset to ${DEFAULT_REVIEW_FONT_SIZE} pixels.`);
    if (persist) {
        getSettings().reviewEditorFontSize = size;
        saveSettings();
    }
    return size;
}

function createReviewSizeButton(text, label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button continuity-review-size-button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', action);
    return button;
}

function installReviewPinchSizing(session) {
    let pinch = null;
    session.editor.addEventListener('touchstart', event => {
        if (event.touches.length !== 2) return;
        pinch = { distance: touchDistance(event.touches), size: session.fontSize, changed: false };
    }, { passive: true });
    session.editor.addEventListener('touchmove', event => {
        if (!pinch || event.touches.length !== 2) return;
        event.preventDefault();
        const size = pinchedReviewFontSize(pinch.size, pinch.distance, touchDistance(event.touches));
        if (size === session.fontSize) return;
        pinch.changed = true;
        applyExtractionReviewFontSize(session, size, false);
    }, { passive: false });
    const finishPinch = event => {
        if (!pinch || event.touches.length >= 2) return;
        const changed = pinch.changed;
        pinch = null;
        if (changed) applyExtractionReviewFontSize(session, session.fontSize, true);
    };
    session.editor.addEventListener('touchend', finishPinch, { passive: true });
    session.editor.addEventListener('touchcancel', finishPinch, { passive: true });
}

function reviewControl(session, className) {
    return session.popup.dlg.querySelector(`.${className}`);
}

function setReviewControlDisabled(session, className, disabled) {
    const control = reviewControl(session, className);
    if (!control) return;
    control.classList.toggle('disabled', Boolean(disabled));
    control.setAttribute('aria-disabled', String(Boolean(disabled)));
}

function refreshExtractionReviewControls(session, review = session.review) {
    if (!review || extractionReviewSession !== session) return;
    session.review = review;
    const busy = review.phase === 'regenerating';
    session.content.querySelector('.continuity-review-candidate').textContent = `Candidate ${review.candidateIndex + 1}/${review.candidateCount}`;
    session.content.querySelector('.continuity-review-phase').textContent = busy
        ? `Regenerating ${review.layer} from the same source…`
        : review.dirty ? 'Manual draft changed · only this candidate will be saved' : 'Unsaved AI-generated candidate';
    setReviewControlDisabled(session, 'continuity-review-previous', busy || review.candidateIndex <= 0);
    setReviewControlDisabled(session, 'continuity-review-next', busy || review.candidateIndex >= review.candidateCount - 1);
    setReviewControlDisabled(session, 'continuity-review-regenerate', busy || !review.canRegenerate);
    setReviewControlDisabled(session, 'continuity-review-edit', busy || session.editing);
    setReviewControlDisabled(session, 'continuity-review-revert', busy || !review.dirty);
    setReviewControlDisabled(session, 'continuity-review-discard', busy);
    setReviewControlDisabled(session, 'continuity-review-save', busy);
    session.editor.readOnly = busy || !session.editing;
    session.editor.classList.toggle('continuity-review-editor-editing', session.editing && !busy);
}

function applyExtractionReview(session, review) {
    if (!review || extractionReviewSession !== session || review.id !== session.reviewId) return;
    const key = `${review.id}:${review.revision}`;
    if (session.renderedKey !== key) {
        session.renderedKey = key;
        session.review = review;
        session.editor.value = review.json;
        session.editing = false;
        session.content.querySelector('.continuity-review-title').textContent = extractionReviewTitle(review);
    }
    refreshExtractionReviewControls(session, review);
}

async function navigateExtractionReview(session, offset) {
    if (extractionReviewSession !== session || session.review.phase === 'regenerating') return;
    const target = session.review.candidateIndex + offset;
    if (target < 0 || target >= session.review.candidateCount) return;
    try {
        const review = selectExtractionReviewCandidate(target, session.editor.value, session.reviewId);
        applyExtractionReview(session, review);
    } catch (error) {
        toast('error', error.message);
    }
}

async function regenerateReviewedMemory(session) {
    if (extractionReviewSession !== session || session.review.phase === 'regenerating') return;
    try {
        await regenerateExtractionReview(session.editor.value, session.reviewId);
    } catch (error) {
        if (extractionReviewSession === session) {
            refreshExtractionReviewControls(session, session.review);
            session.content.querySelector('.continuity-review-phase').textContent = `Regeneration failed: ${error.message}`;
        }
        toast('error', error.message);
    }
}

function enableExtractionReviewEditing(session) {
    if (extractionReviewSession !== session || session.review.phase === 'regenerating') return;
    session.editing = true;
    refreshExtractionReviewControls(session);
    session.editor.focus();
    session.editor.setSelectionRange(session.editor.value.length, session.editor.value.length);
}

function revertReviewedMemory(session) {
    if (extractionReviewSession !== session || session.review.phase === 'regenerating') return;
    try {
        const review = revertExtractionReviewDraft(session.reviewId);
        applyExtractionReview(session, review);
    } catch (error) {
        toast('error', error.message);
    }
}

function saveReviewedMemory(session) {
    if (extractionReviewSession !== session || session.review.phase === 'regenerating') return;
    try {
        const review = session.review;
        approveExtractionReview(session.editor.value, session.reviewId);
        toast('success', `Reviewed ${review.layer} saved. Other regenerated candidates were discarded.`);
    } catch (error) {
        session.content.querySelector('.continuity-review-phase').textContent = error.message;
        toast('error', error.message);
    }
}

async function discardReviewedMemory(session) {
    if (extractionReviewSession !== session || session.review.phase === 'regenerating') return;
    const review = session.review;
    const confirmed = await Popup.show.confirm(
        `Discard ${review.layer} and stop generation?`,
        'This candidate and all of its unsaved regeneration swipes will be discarded. Nothing from this review will be saved.',
        { okButton: 'Discard & Stop', cancelButton: 'Keep reviewing' },
    );
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE || extractionReviewSession !== session) return;
    const message = extractionReviewStopMessage(review);
    stopRuntime(message);
    await Popup.show.text('Continuity generation stopped', message, { okButton: 'OK' });
}

function closeExtractionReviewPopup(session) {
    if (!session || extractionReviewSession !== session) return;
    extractionReviewSession = null;
    session.allowClose = true;
    void session.popup.complete(POPUP_RESULT.AFFIRMATIVE);
}

function abandonStaleExtractionReviewPopup(session) {
    if (!session || extractionReviewSession !== session) return;
    extractionReviewSession = null;
    session.allowClose = true;
    session.popup?.dlg?.remove();
    const popups = Popup.util?.popups;
    const index = Array.isArray(popups) ? popups.indexOf(session.popup) : -1;
    if (index >= 0) popups.splice(index, 1);
}

function retireExtractionReviewPopup(session) {
    const dialog = session?.popup?.dlg;
    if (dialog?.isConnected && dialog.open) closeExtractionReviewPopup(session);
    else abandonStaleExtractionReviewPopup(session);
}

function openExtractionReviewPopup(review) {
    const content = document.createElement('div');
    content.className = 'continuity-review-modal';
    const heading = document.createElement('div');
    heading.className = 'continuity-review-heading';
    const title = document.createElement('b');
    title.className = 'continuity-review-title';
    const candidate = document.createElement('span');
    candidate.className = 'continuity-review-candidate';
    const headingActions = document.createElement('div');
    headingActions.className = 'continuity-review-heading-actions';
    const sizeControls = document.createElement('div');
    sizeControls.className = 'continuity-review-size-controls';
    const decreaseSize = createReviewSizeButton('A−', 'Decrease review text size', () => applyExtractionReviewFontSize(session, session.fontSize - REVIEW_FONT_STEP));
    const fontSizeLabel = createReviewSizeButton(`${DEFAULT_REVIEW_FONT_SIZE}px`, `Reset review text size to ${DEFAULT_REVIEW_FONT_SIZE} pixels`, () => applyExtractionReviewFontSize(session, DEFAULT_REVIEW_FONT_SIZE));
    fontSizeLabel.classList.add('continuity-review-size-label');
    const increaseSize = createReviewSizeButton('A+', 'Increase review text size', () => applyExtractionReviewFontSize(session, session.fontSize + REVIEW_FONT_STEP));
    sizeControls.append(decreaseSize, fontSizeLabel, increaseSize);
    headingActions.append(candidate, sizeControls);
    heading.append(title, headingActions);
    const phase = document.createElement('div');
    phase.className = 'continuity-review-phase';
    const editor = document.createElement('textarea');
    editor.className = 'text_pole continuity-review-editor';
    editor.wrap = 'soft';
    editor.spellcheck = false;
    editor.readOnly = true;
    content.append(heading, phase, editor);

    let session;
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        wide: true,
        large: true,
        allowVerticalScrolling: false,
        leftAlign: true,
        customButtons: [
            { text: '‹ Previous', classes: ['continuity-review-previous'], action: () => void navigateExtractionReview(session, -1) },
            { text: 'Next ›', classes: ['continuity-review-next'], action: () => void navigateExtractionReview(session, 1) },
            { text: 'Regenerate with AI', classes: ['continuity-review-regenerate'], action: () => void regenerateReviewedMemory(session) },
            { text: 'Edit manually', classes: ['continuity-review-edit'], action: () => enableExtractionReviewEditing(session) },
            { text: 'Revert edits', classes: ['continuity-review-revert'], action: () => revertReviewedMemory(session) },
            { text: 'Discard & Stop', classes: ['continuity-review-discard', 'redWarningBG'], action: () => void discardReviewedMemory(session) },
            { text: 'Save & Continue', classes: ['continuity-review-save', 'menu_button_default'], appendAtEnd: true, action: () => saveReviewedMemory(session) },
        ],
        onClosing: () => session.allowClose,
    });
    popup.dlg.classList.add('continuity-review-dialog');
    session = {
        popup,
        content,
        editor,
        review,
        reviewId: review.id,
        renderedKey: '',
        editing: false,
        allowClose: false,
        fontSize: DEFAULT_REVIEW_FONT_SIZE,
        fontSizeLabel,
    };
    extractionReviewSession = session;
    editor.addEventListener('input', () => {
        if (!session.editing || extractionReviewSession !== session) return;
        try {
            const updated = updateExtractionReviewDraft(editor.value, session.reviewId);
            session.review = updated;
            refreshExtractionReviewControls(session, updated);
        } catch (error) {
            toast('error', error.message);
        }
    });
    applyExtractionReviewFontSize(session, getSettings().reviewEditorFontSize, false);
    installReviewPinchSizing(session);
    applyExtractionReview(session, review);
    void popup.show().finally(() => {
        if (extractionReviewSession === session) extractionReviewSession = null;
    });
}

function syncExtractionReviewPopup(review) {
    const action = extractionReviewRecoveryAction(review, extractionReviewSession);
    if (action === 'none') return;
    if (action === 'close') return retireExtractionReviewPopup(extractionReviewSession);
    if (action === 'replace') {
        retireExtractionReviewPopup(extractionReviewSession);
        openExtractionReviewPopup(review);
        return;
    }
    if (action === 'reopen') {
        abandonStaleExtractionReviewPopup(extractionReviewSession);
        openExtractionReviewPopup(review);
        return;
    }
    if (action === 'open') {
        openExtractionReviewPopup(review);
        return;
    }
    applyExtractionReview(extractionReviewSession, review);
}

export function restorePendingExtractionReview({ focus = true } = {}) {
    const review = runtime.pendingExtractionReview;
    if (!review) return false;
    syncExtractionReviewPopup(review);
    const dialog = extractionReviewSession?.popup?.dlg;
    if (focus && dialog?.isConnected && dialog.open) dialog.focus({ preventScroll: true });
    return true;
}

function installReviewRecoveryListeners() {
    if (reviewRecoveryListenersInstalled) return;
    reviewRecoveryListenersInstalled = true;
    const restore = () => restorePendingExtractionReview();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) restore();
    });
    window.addEventListener('pageshow', restore);
    window.addEventListener('focus', restore);
}

function settingWarning(message) {
    if (window.toastr?.warning) window.toastr.warning(message, 'Continuity Memory');
    else console.warn(`[Continuity] ${message}`);
}

function exportChatKey(chatId, context = getContext()) {
    const owner = context.groupId ? `group:${context.groupId}` : `character:${context.characterId ?? 'unknown'}`;
    return `${owner}:chat:${chatId}`;
}

function downloadPortableChat(text, filename) {
    const blob = new Blob([text], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function exportNativeChatWithPortableMemory(target, filenameFull, chatId, chatKey, worldId, includePortableMemory) {
    const context = getContext();
    if (context.chatId === chatId) await saveChatConditional();
    const response = await fetch('/api/chats/export', {
        method: 'POST',
        body: JSON.stringify({
            is_group: Boolean(context.groupId),
            character_id: characters[this_chid]?.id,
            file: filenameFull,
            exportfilename: filenameFull,
            format: 'jsonl',
        }),
        headers: getRequestHeaders(),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || `Chat export failed (${response.status}).`);

    if (!includePortableMemory) {
        downloadPortableChat(removePortableMemoryFromChatExport(payload.result), filenameFull);
        toast('success', 'Chat exported without portable Continuity memory.');
        target.blur?.();
        return;
    }

    let world;
    try {
        world = (await api.getWorld(worldId)).world;
    } catch (error) {
        if (error.status !== 404) throw error;
        const embedded = getPortableSnapshotFromChatExport(payload.result);
        if (embedded?.world?.id === worldId) world = embedded.world;
        else throw new Error('This chat references Continuity memory that is missing from this SillyTavern user. Restore or import the memory before exporting the chat.');
    }

    const parsed = parseChatExport(payload.result);
    const alignment = alignWorldToChat(world, collectFingerprintMessages(parsed.messages), chatKey);
    if (!alignment.ok) throw new Error(`The chat was not exported with memory because its stored memory does not match: ${alignment.message}`);
    const portable = embedPortableMemoryInChatExport(payload.result, alignment.world);
    downloadPortableChat(portable, filenameFull);
    toast('success', 'Chat exported with its current Continuity memory included.');
    target.blur?.();
}

function installNativeChatExportBridge() {
    if (nativeChatExportBridgeInstalled) return;
    nativeChatExportBridgeInstalled = true;
    document.addEventListener('click', event => {
        const target = event.target instanceof Element
            ? event.target.closest('.exportRawChatButton[data-format="jsonl"]')
            : null;
        if (!target) return;
        const filenameFull = String(target.closest('.select_chat_block_wrapper')?.querySelector('.select_chat_block_filename')?.textContent || '').trim();
        const chatId = filenameFull.replace(/\.jsonl$/iu, '');
        if (!filenameFull || !chatId) return;
        const includePortableMemory = getSettings().embedMemoryInChat;
        const chatKey = exportChatKey(chatId);
        const worldId = getSettings().chatWorlds?.[chatKey];
        if (!worldId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        exportNativeChatWithPortableMemory(target, filenameFull, chatId, chatKey, worldId, includePortableMemory)
            .catch(error => toast('error', error.message));
    }, true);
}

function setSetting(id, key, transform = value => value) {
    $(id).on('change', function () {
        const value = transform($(this).is(':checkbox') ? $(this).prop('checked') : $(this).val());
        getSettings()[key] = value;
        saveSettings();
        renderRuntime();
        if (key === 'enabled' && value) void refreshWorlds().catch(error => toast('error', error.message));
    });
}

function initSectionToggle() {
    const panel = document.getElementById('continuity_settings');
    const button = document.getElementById('continuity_toggle_all_sections');
    if (!panel || !button) return;

    const sections = [...panel.querySelectorAll('details')];
    const render = () => {
        const allOpen = sections.length > 0 && sections.every(section => section.open);
        button.setAttribute('aria-pressed', String(allOpen));
        button.title = allOpen ? 'Collapse every section' : 'Open every section';
        button.querySelector('i')?.classList.toggle('fa-angles-up', allOpen);
        button.querySelector('i')?.classList.toggle('fa-angles-down', !allOpen);
        const label = button.querySelector('span');
        if (label) label.textContent = allOpen ? 'Collapse all' : 'Open all';
    };

    button.addEventListener('click', () => {
        const open = !sections.every(section => section.open);
        for (const section of sections) section.open = open;
        render();
    });
    for (const section of sections) section.addEventListener('toggle', render);
    render();
}

export async function refreshWorlds() {
    const response = await api.listWorlds();
    worlds = response.worlds || [];
    let selected = getBoundWorldId();
    if (selected && !worlds.some(world => world.id === selected)) {
        const portable = getPortableSnapshot();
        const portableEligible = portable
            && !(getSettings().deletedWorldIds || []).includes(portable.world.id);
        if (portableEligible) {
            const restored = await ensureCurrentChatMemory(false, true);
            if (restored) {
                selected = restored.id;
                if (!worlds.some(world => world.id === restored.id)) {
                    worlds.unshift({ id: restored.id, name: restored.name, updatedAt: restored.updatedAt });
                }
            } else {
                const reason = 'The imported portable memory could not be safely aligned with this chat.';
                updateRuntime({ world: null, status: 'waiting', lastError: reason, injectionStatus: reason });
                renderRuntime();
                return null;
            }
        } else {
            const recovery = await recoverStoredWorldForCurrentChat(selected);
            if (recovery.world) {
                selected = recovery.world.id;
                toast('info', 'Recovered this chat’s Continuity memory from verified message fingerprints.');
            } else {
                const reason = recovery.ambiguous
                    ? 'More than one stored memory matches this imported chat; Continuity refused to guess.'
                    : 'The memory bound to this chat is not available yet. A restore or import may still be in progress.';
                updateRuntime({ world: null, status: 'waiting', lastError: reason, injectionStatus: reason });
                renderRuntime();
                return null;
            }
        }
    }
    if (!selected && getChatKey() && getSettings().enabled) {
        const created = await ensureCurrentChatMemory(false);
        if (created) {
            selected = created.id;
            if (!worlds.some(item => item.id === created.id)) {
                worlds.unshift({ id: created.id, name: created.name, updatedAt: created.updatedAt });
            }
        } else {
            const recovery = await recoverStoredWorldForCurrentChat('');
            if (recovery.world) selected = recovery.world.id;
        }
    }
    let world = selected ? await loadBoundWorld() : null;
    world = await reconcileBoundWorldSource(world);
    if (getSettings().embedMemoryInChat && world) await embedWorldInChat(world);
    else if (!getSettings().embedMemoryInChat) await clearPortableSnapshot();
    renderRuntime();
    return world;
}

async function reconcileBoundWorldSource(world) {
    const chatKey = getChatKey();
    const sourceKeys = Object.keys(world?.sources || {});
    if (!world || !chatKey || !sourceKeys.length || (sourceKeys.length === 1 && world.sources?.[chatKey])) return world;

    const alignment = alignWorldToChat(world, collectFingerprintMessages(getContext().chat || []), chatKey);
    const { world: ignored, ...diagnostic } = alignment;
    updateRuntime({ importAlignment: diagnostic });
    if (!alignment.ok || !alignment.sourceChatKey) {
        throw new Error(`The bound memory belongs to a different chat or branch and was not attached: ${alignment.message}`);
    }

    const saved = (await api.saveWorld(alignment.world)).world;
    updateRuntime({ world: saved, lastError: '' });
    await embedWorldInChat(saved);
    toast('info', `Verified and updated this imported memory for the current chat (${alignment.matched} messages matched).`);
    return saved;
}

async function recoverStoredWorldForCurrentChat(missingBoundWorldId) {
    const context = getContext();
    const exact = resolveMissingWorldBinding(worlds, missingBoundWorldId || '__unbound__', {
        characterName: context.name2,
        chatId: context.chatId,
    }).world;
    const ordered = exact
        ? [exact, ...worlds.filter(world => world.id !== exact.id)]
        : worlds;
    const messages = collectFingerprintMessages(context.chat || []);
    const matches = [];
    for (const summary of ordered) {
        try {
            const stored = (await api.getWorld(summary.id)).world;
            const alignment = alignWorldToChat(stored, messages, getChatKey());
            if (alignment.ok && (alignment.matched > 0 || (alignment.code === 'empty' && exact?.id === summary.id))) {
                matches.push({ stored, alignment });
            }
        } catch (error) {
            if (error.status !== 404) console.warn('[Continuity] Could not inspect a recovery candidate.', error);
        }
    }
    if (matches.length !== 1) return { world: null, ambiguous: matches.length > 1 };

    const { stored, alignment } = matches[0];
    const boundElsewhere = Object.entries(getSettings().chatWorlds || {})
        .some(([chatKey, worldId]) => chatKey !== getChatKey() && worldId === stored.id);
    const saved = boundElsewhere
        ? (await api.importWorld(alignment.world)).world
        : alignment.changed || (alignment.sourceChatKey && alignment.sourceChatKey !== getChatKey())
            ? (await api.saveWorld(alignment.world)).world
            : stored;
    bindCurrentChat(saved.id);
    updateRuntime({ world: saved, lastError: '' });
    await embedWorldInChat(saved);
    return { world: saved, ambiguous: false };
}

export async function ensureCurrentChatMemory(createIfMissing = false, recoverStaleBinding = false) {
    if (getBoundWorldId() && !recoverStaleBinding) return runtime.world;
    if (!getChatKey()) return null;
    if (creatingChatMemory) {
        const pending = creatingChatMemory;
        const result = await pending;
        if (result || !createIfMissing) return result;
        if (creatingChatMemory === pending) creatingChatMemory = null;
        return await ensureCurrentChatMemory(true, recoverStaleBinding);
    }
    creatingChatMemory = (async () => {
        const context = getContext();
        const parentChatKey = branchParentChatKey();
        const portable = getPortableSnapshot();
        if (portable && !(getSettings().deletedWorldIds || []).includes(portable.world.id)) {
            let alignment;
            try {
                alignment = verifyMemoryAlignment(portable.world, {
                    allowBranchReuse: Boolean(parentChatKey),
                    sourceChatKey: parentChatKey,
                });
            } catch (error) {
                toast('error', `${error.message} The embedded memory was not attached.`);
                return null;
            }
            const existing = worlds.find(item => item.id === portable.world.id);
            const boundElsewhere = existing && Object.entries(getSettings().chatWorlds || {})
                .some(([chatKey, worldId]) => chatKey !== getChatKey() && worldId === existing.id);
            if (existing && !boundElsewhere) {
                const stored = (await api.getWorld(existing.id)).world;
                const storedAlignment = verifyMemoryAlignment(stored);
                const saved = storedAlignment.changed || (storedAlignment.sourceChatKey && storedAlignment.sourceChatKey !== getChatKey())
                    ? (await api.saveWorld(storedAlignment.world)).world
                    : storedAlignment.world;
                bindCurrentChat(saved.id);
                updateRuntime({ world: saved });
                if (getSettings().embedMemoryInChat) await embedWorldInChat(saved);
                else await clearPortableSnapshot();
                return saved;
            }
            const imported = await api.importWorld(alignment.world);
            bindCurrentChat(imported.world.id);
            updateRuntime({ world: imported.world });
            if (getSettings().embedMemoryInChat) await embedWorldInChat(imported.world);
            else await clearPortableSnapshot();
            toast('success', alignment.code === 'branch-prefix-reused'
                ? alignment.message
                : 'Restored this chat’s embedded Continuity memory.');
            return imported.world;
        }
        if (portable) await clearPortableSnapshot();
        const parentWorldId = parentChatKey ? getSettings().chatWorlds?.[parentChatKey] : '';
        if (parentWorldId && !(getSettings().deletedWorldIds || []).includes(parentWorldId)) {
            try {
                const parentWorld = (await api.getWorld(parentWorldId)).world;
                const alignment = verifyMemoryAlignment(parentWorld, {
                    allowBranchReuse: true,
                    sourceChatKey: parentChatKey,
                });
                const imported = await api.importWorld(alignment.world);
                bindCurrentChat(imported.world.id);
                updateRuntime({ world: imported.world });
                await embedWorldInChat(imported.world);
                toast('success', alignment.message);
                return imported.world;
            } catch (error) {
                console.warn('[Continuity] Could not reuse the parent branch’s verified L1 prefix.', error);
            }
        }
        if (!createIfMissing) return null;
        const response = await api.createWorld(`${context.name2 || 'Chat'} · ${context.chatId || 'Memory'}`);
        bindCurrentChat(response.world.id);
        updateRuntime({ world: response.world });
        await embedWorldInChat(response.world);
        return response.world;
    })();
    try { return await creatingChatMemory; }
    finally { creatingChatMemory = null; }
}

export function refreshModelProfiles() {
    const settings = getSettings();
    const extractionSelect = $('#continuity_model_profile').empty()
        .append($('<option>').val('').text('Current active SillyTavern model'))
        .append($('<option>').val(DIRECT_PROFILE_ID).text('Direct OpenAI-compatible API'));
    const retrievalSelect = $('#continuity_retrieval_profile').empty()
        .append($('<option>').val('').text('Same as extraction model'));
    const storySelect = $('#continuity_story_profile').empty()
        .append($('<option>').val('').text('Same as extraction model (default)'))
        .append($('<option>').val(DIRECT_PROFILE_ID).text('Direct OpenAI-compatible API'));
    const arcSelect = $('#continuity_arc_profile').empty()
        .append($('<option>').val('').text('Same as extraction model'))
        .append($('<option>').val(DIRECT_PROFILE_ID).text('Direct OpenAI-compatible API'));
    try {
        for (const profile of ConnectionManagerRequestService.getSupportedProfiles()) {
            const model = profile.model ? ` — ${profile.model}` : '';
            $('<option>').val(profile.id).text(`${profile.name}${model}`).appendTo(extractionSelect);
            $('<option>').val(profile.id).text(`${profile.name}${model}`).appendTo(retrievalSelect);
            $('<option>').val(profile.id).text(`${profile.name}${model}`).appendTo(storySelect);
            $('<option>').val(profile.id).text(`${profile.name}${model}`).appendTo(arcSelect);
        }
    } catch (error) {
        console.warn('[Continuity] Could not list connection profiles', error);
    }
    const extractionExists = [...extractionSelect[0].options].some(option => option.value === settings.memoryProfileId);
    if (!extractionExists && settings.memoryProfileId) {
        settings.memoryProfileId = '';
        saveSettings();
    }
    const retrievalExists = [...retrievalSelect[0].options].some(option => option.value === settings.retrievalProfileId);
    if (!retrievalExists && settings.retrievalProfileId) {
        settings.retrievalProfileId = '';
        saveSettings();
    }
    const storyExists = [...storySelect[0].options].some(option => option.value === settings.storyProfileId);
    if (!storyExists && settings.storyProfileId) {
        settings.storyProfileId = '';
        saveSettings();
    }
    const arcExists = [...arcSelect[0].options].some(option => option.value === settings.arcProfileId);
    if (!arcExists && settings.arcProfileId) {
        settings.arcProfileId = '';
        saveSettings();
    }
    extractionSelect.val(settings.memoryProfileId || '');
    retrievalSelect.val(settings.retrievalProfileId || '');
    storySelect.val(settings.storyProfileId || '');
    arcSelect.val(settings.arcProfileId || '');
}

async function saveDirectApiKey(kind) {
    const extraction = kind === 'extraction';
    const settings = getSettings();
    const provider = settings[extraction ? 'extractionDirectProvider' : 'summaryDirectProvider'] === 'openrouter' ? 'openrouter' : 'custom';
    const input = extraction ? '#continuity_extraction_direct_key' : '#continuity_summary_direct_key';
    const value = String($(input).val() || '').trim();
    if (!value) throw new Error(`Enter the ${extraction ? 'extraction' : 'summarizer'} API password first.`);
    const slot = provider === 'openrouter' ? SECRET_KEYS.OPENROUTER : SECRET_KEYS.CUSTOM;
    const id = await writeSecret(slot, value, provider === 'openrouter' ? 'Continuity shared OpenRouter key' : `Continuity ${extraction ? 'L1 extractor' : 'L2/L3 summarizer'}`);
    if (!id) throw new Error('SillyTavern could not save the direct API password.');
    if (provider === 'custom') settings[extraction ? 'extractionDirectSecretId' : 'summaryDirectSecretId'] = id;
    saveSettings();
    $(input).val('');
    renderRuntime();
}

async function fetchDirectModels(kind) {
    const extraction = kind === 'extraction';
    const keyInput = extraction ? '#continuity_extraction_direct_key' : '#continuity_summary_direct_key';
    if (String($(keyInput).val() || '').trim()) await saveDirectApiKey(kind);
    const settings = getSettings();
    const provider = settings[extraction ? 'extractionDirectProvider' : 'summaryDirectProvider'] === 'openrouter' ? 'openrouter' : 'custom';
    const urlInput = extraction ? '#continuity_extraction_direct_url' : '#continuity_summary_direct_url';
    const modelInput = extraction ? '#continuity_extraction_direct_model' : '#continuity_summary_direct_model';
    const selectId = extraction ? '#continuity_extraction_direct_model_select' : '#continuity_summary_direct_model_select';
    const statusId = extraction ? '#continuity_extraction_direct_models_status' : '#continuity_summary_direct_models_status';
    const url = String($(urlInput).val() || '').trim() || (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
    const secretId = provider === 'custom' ? settings[extraction ? 'extractionDirectSecretId' : 'summaryDirectSecretId'] : '';
    $(statusId).text('Fetching models…');
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: provider,
            ...(provider === 'openrouter' ? { api_url: url } : { custom_url: url, secret_id: secretId || undefined }),
        }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `Model discovery failed (${response.status} ${response.statusText}).`);
    const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const models = [...new Set(source.map(item => typeof item === 'string' ? item : item?.id || item?.name).map(String).map(item => item.trim()).filter(Boolean))].sort();
    const current = String($(modelInput).val() || '').trim();
    if (current && !models.includes(current)) models.unshift(current);
    if (!models.length) throw new Error('The endpoint returned no model IDs. Manual model entry remains available.');
    const select = $(selectId).empty();
    for (const model of models) $('<option>').val(model).text(model).appendTo(select);
    select.val(current && models.includes(current) ? current : models[0]).show();
    $(modelInput).val(select.val()).trigger('change');
    $(statusId).text(`${models.length} model option(s) loaded. You may still type a model ID manually.`);
    return models;
}

function formatRanges(ranges) {
    if (!ranges.length) return 'none';
    const shown = ranges.slice(0, 4).map(range => range.from === range.to ? `${range.from}` : `${range.from}–${range.to}`);
    return `${shown.join(', ')}${ranges.length > shown.length ? `, +${ranges.length - shown.length} more` : ''}`;
}

function updateTailLimitUI(settings) {
    const tokens = settings.rawTailMode !== 'turns';
    $('#continuity_tail_value')
        .attr('max', tokens ? 100000 : 100)
        .attr('step', tokens ? 1000 : 1);
    $('#continuity_tail_help').text(tokens
        ? 'Tokens only. 0 = dynamic: 25% of context, from 8k up to 25k.'
        : 'User/AI pairs only. 0 = dynamic: 8–30 turns based on context size.');
}

function updateInjectionPlacementUI(settings) {
    $('.continuity_in_chat_setting').toggle(settings.injectionPosition === 'at-depth');
}

function updateEmbeddingProviderUI(settings) {
    const openRouter = settings.embeddingProvider === 'openrouter';
    $('#continuity_embedding_provider_choice').val(openRouter ? 'openrouter' : 'proxy');
    $('#continuity_embedding_key_label').text(openRouter ? 'OpenRouter API key' : 'Proxy password / embedding API key');
    $('#continuity_embedding_api_key').attr('placeholder', openRouter ? 'Leave blank to keep the saved OpenRouter key' : 'Leave blank to keep the saved proxy password');
    $('.continuity-embedding-proxy-setting').toggle(!openRouter);
    $('.continuity-embedding-openrouter-setting').toggle(openRouter);
    $('#continuity_embedding_proxy_url').val(settings.embeddingProxyUrl);
    $('#continuity_embedding_openrouter_url').val(settings.embeddingOpenRouterUrl);
    setEmbeddingModelValue('#continuity_embedding_proxy_model', settings.embeddingProxyModel);
    setEmbeddingModelValue('#continuity_embedding_openrouter_model', settings.embeddingOpenRouterModel);
    const slot = openRouter ? SECRET_KEYS.OPENROUTER : SECRET_KEYS.VLLM;
    const stored = Array.isArray(secret_state[slot]) ? secret_state[slot].length > 0 : Boolean(secret_state[slot]);
    $('#continuity_embedding_key_status').text(stored ? 'A password/key is saved for this provider.' : 'No password/key is saved for this provider.');
}

function setEmbeddingModelValue(selector, model) {
    const value = String(model || '').trim();
    const select = $(selector);
    if (value && !select.find('option').toArray().some(option => option.value === value)) {
        $('<option>').val(value).text(value).appendTo(select);
    }
    select.val(value);
}

function embeddingSecretSlot() {
    return getSettings().embeddingProvider === 'openrouter' ? SECRET_KEYS.OPENROUTER : SECRET_KEYS.VLLM;
}

async function saveEmbeddingKey(showToast = true) {
    const value = String($('#continuity_embedding_api_key').val() || '').trim();
    if (!value) return false;
    const openRouter = getSettings().embeddingProvider === 'openrouter';
    const id = await writeSecret(embeddingSecretSlot(), value, `Continuity ${openRouter ? 'OpenRouter' : 'proxy'}`);
    if (!id) throw new Error('SillyTavern could not save the embedding API key.');
    $('#continuity_embedding_api_key').val('');
    renderRuntime();
    if (showToast) toast('success', 'Embedding API key saved securely.');
    return true;
}

function populateEmbeddingModels(selector, models, selected) {
    const select = $(selector).empty();
    for (const model of models) $('<option>').val(model).text(model).appendTo(select);
    setEmbeddingModelValue(selector, selected);
}

async function fetchEmbeddingModels() {
    await saveEmbeddingKey(false);
    const settings = getSettings();
    const openRouter = settings.embeddingProvider === 'openrouter';
    const provider = resolveEmbeddingProvider(settings);
    const response = await fetch('/api/backends/text-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ api_server: provider.body.apiUrl, api_type: openRouter ? 'openrouter' : 'vllm' }),
    });
    if (!response.ok) throw new Error(`Model discovery failed (${response.status} ${response.statusText}).`);
    const payload = await response.json();
    const current = openRouter ? settings.embeddingOpenRouterModel : settings.embeddingProxyModel;
    const models = embeddingModelChoices(payload, current);
    populateEmbeddingModels(openRouter ? '#continuity_embedding_openrouter_model' : '#continuity_embedding_proxy_model', models, current);
    $('#continuity_embedding_models_status').text(`${models.length} embedding model option(s) loaded into the model dropdown.`);
    return models;
}

function renderMemoryViewer(force = false) {
    const world = runtime.world;
    const coverage = getProcessingCoverage(world);
    const signature = `${world?.id || ''}:${world?.revision ?? ''}:${viewerCategory}:${viewerSearch}:${viewerPage}:${coverage.latestIndex}:${coverage.pending}`;
    if (!force && signature === viewerSignature) return;
    viewerSignature = signature;
    const result = memoryViewerPage(world, viewerCategory, viewerSearch, viewerPage, 30);
    viewerPage = result.page;
    $('#continuity_viewer_category').val(result.category);
    const checkpointStatus = result.category === 'scene' && coverage.pending
        ? ` · ${coverage.pending} newer or changed message(s) pending; this checkpoint is not injected as current state`
        : '';
    $('#continuity_viewer_status').text(world
        ? `${result.total} ${MEMORY_VIEW_CATEGORIES.find(item => item.key === result.category)?.label || 'memory'} record(s)${viewerSearch ? ' matching search' : ''} · page ${result.page + 1}/${result.pages}${checkpointStatus}`
        : 'No memory loaded.');
    $('#continuity_viewer_previous').prop('disabled', !world || result.page <= 0);
    $('#continuity_viewer_next').prop('disabled', !world || result.page >= result.pages - 1);
    const container = $('#continuity_memory_viewer').empty();
    if (!world || !result.items.length) {
        $('<div>').addClass('continuity-viewer-item').text(world ? 'Nothing in this category.' : 'Open a chat to browse its memory.').appendTo(container);
        return;
    }
    for (const item of result.items) {
        const card = $('<article>').addClass('continuity-viewer-item').appendTo(container);
        $('<h5>').text(item.title || 'Untitled memory').appendTo(card);
        for (const field of item.fields) {
            const row = $('<div>').addClass('continuity-viewer-field').appendTo(card);
            $('<b>').text(`${field.label}: `).appendTo(row);
            $('<span>').text(field.value).appendTo(row);
        }
        const meta = $('<div>').addClass('continuity-viewer-meta').appendTo(card);
        if (item.importance !== null) $('<span>').text(`Importance ${item.importance}/5`).appendTo(meta);
        for (const source of item.sources) $('<span>').text(source).appendTo(meta);
        if (!meta.children().length) meta.remove();
    }
}

export function renderRuntime(refreshSettings = true) {
    const settings = getSettings();
    if (refreshSettings) {
        $('#continuity_enabled').prop('checked', settings.enabled);
        $('#continuity_notifications').prop('checked', settings.showNotifications);
        $('#continuity_retrieval_mode').val(settings.retrievalMode);
        $('#continuity_story_so_far').prop('checked', settings.storySoFarEnabled);
        $('#continuity_story_so_far_tokens').val(settings.storySoFarTokens);
        $('.continuity-ai-retrieval-setting').toggle(settings.retrievalMode === 'ai-expanded');
        $('.continuity-text-retrieval-setting').toggle(settings.retrievalMode !== 'embedding-hybrid');
        $('.continuity-embedding-setting').toggle(settings.retrievalMode === 'embedding-hybrid');
        $('#continuity_retrieval_messages').val(settings.retrievalQueryMessages);
        $('#continuity_embedding_messages').val(settings.embeddingQueryMessages);
        $('#continuity_embedding_top_k').val(settings.embeddingTopK);
        $('#continuity_embedding_threshold').val(settings.embeddingThreshold);
        updateEmbeddingProviderUI(settings);
        $('#continuity_embedding_provider').text(`Provider: ${embeddingProviderDescription()}`);
    }
    const rollingStory = runtime.world?.storySoFar?.[getChatKey()];
    const resolvedStoryAllowance = resolveStoryBudget(settings.storySoFarTokens, getContext().maxContext);
    $('#continuity_story_recalculate').prop('disabled', runtime.processing || !runtime.world);
    $('#continuity_story_stop').prop('disabled', !(runtime.processing && runtime.status === 'rebuilding-story'));
    $('#continuity_story_delete').prop('disabled', runtime.processing || !rollingStory?.text);
    $('#continuity_story_status').text(rollingStory?.text
        ? `Stored through message ${Number(rollingStory.to ?? -1) + 1}; approximately ${Math.ceil(String(rollingStory.text).length / 4)} tokens before injection clipping. Current ${resolvedStoryAllowance.mode} allowance: ${resolvedStoryAllowance.tokens} tokens.`
        : `No rolling story is stored for this chat yet. Current ${resolvedStoryAllowance.mode} allowance: ${resolvedStoryAllowance.tokens} tokens.`);
    const embedding = runtime.embeddingIndex;
    const embeddingTotal = Math.max(0, Number(embedding?.total) || 0);
    const embeddingIndexed = Math.min(embeddingTotal, Math.max(0, Number(embedding?.indexed) || 0));
    const embeddingPercent = embeddingTotal ? Math.floor((embeddingIndexed / embeddingTotal) * 100) : 0;
    const embeddingStatus = !embedding
        ? 'The optional index has not been checked.'
        : embedding.status === 'ready'
            ? `Ready: ${embedding.total || 0} records (${embedding.added || 0} added, ${embedding.removed || 0} removed).`
            : embedding.status === 'checking'
                ? embedding.phase
                : embedding.status === 'incomplete'
                    ? `Index update available: ${embeddingIndexed}/${embeddingTotal} records are stored; ${embedding.missing || 0} are missing.`
            : embedding.status === 'syncing'
                ? `${embedding.phase || 'Indexing'}: ${embeddingIndexed}/${embeddingTotal} records (${embeddingPercent}%)${embedding.batches ? ` · batch ${embedding.batch || 0}/${embedding.batches}` : ''}.`
                : embedding.status === 'pausing'
                    ? `${embedding.phase || 'Pausing'}: ${embeddingIndexed}/${embeddingTotal} records completed.`
                    : embedding.status === 'paused' || embedding.status === 'stopped'
                        ? `${embedding.phase}: ${embeddingIndexed}/${embeddingTotal} records completed.`
                : embedding.status === 'empty'
                    ? 'The derived embedding index is empty.'
                    : `Index interrupted: ${embedding.error || 'unknown error'} Completed vectors were preserved; use Resume index to continue.`;
    $('#continuity_embedding_status').text(embeddingStatus);
    $('#continuity_embedding_progress')
        .attr('max', Math.max(1, embeddingTotal))
        .val(embeddingIndexed)
        .toggle(['checking', 'incomplete', 'syncing', 'pausing', 'paused', 'stopped', 'error'].includes(embedding?.status));
    const embeddingActive = ['syncing', 'pausing'].includes(embedding?.status);
    const embeddingCanResume = ['paused', 'stopped', 'error'].includes(embedding?.status);
    const embeddingBuildLabel = embedding?.status === 'incomplete' || embeddingCanResume ? 'Continue index' : embedding?.status === 'ready' ? 'Update index' : 'Build index';
    $('#continuity_embedding_build')
        .toggle(!embeddingActive && !embeddingCanResume)
        .html(`<i class="fa-solid fa-hammer"></i> ${embeddingBuildLabel}`);
    $('#continuity_embedding_pause')
        .toggle(embeddingActive || embeddingCanResume)
        .prop('disabled', embedding?.status === 'pausing')
        .html(embeddingCanResume ? '<i class="fa-solid fa-play"></i> Resume index' : '<i class="fa-solid fa-pause"></i> Pause index');
    $('#continuity_embedding_stop').toggle(embeddingActive);
    if (refreshSettings) {
        $('#continuity_embedding_auto_sync').prop('checked', settings.embeddingAutoSync);
        $('#continuity_auto').prop('checked', settings.autoExtract);
        $('#continuity_review_extractions').prop('checked', settings.reviewBeforeCommit);
        $('#continuity_jb_enabled').prop('checked', settings.jbEnabled);
    }
    const rollback = getTailRollbackStatus();
    $('#continuity_repair_rollback')
        .toggle(rollback.detected)
        .html(`<i class="fa-solid fa-clock-rotate-left"></i> Repair rollback${rollback.detected ? ` (${rollback.removedMessages})` : ''}`);
    const latestL1 = getLatestL1UndoStatus();
    $('#continuity_undo_latest_l1')
        .prop('disabled', runtime.processing || !latestL1.available || !latestL1.replayable)
        .attr('title', !latestL1.available
            ? 'There is no saved L1 memory to undo for this chat.'
            : !latestL1.replayable
                ? 'This older memory cannot safely replay retained L1 records. Rebuild it from scratch first.'
                : `Undo L1 messages ${latestL1.from}–${latestL1.to}; chat messages will remain.`);
    const extractionOpenRouter = settings.extractionDirectProvider === 'openrouter';
    const summaryOpenRouter = settings.summaryDirectProvider === 'openrouter';
    const sharedOpenRouterSaved = Array.isArray(secret_state[SECRET_KEYS.OPENROUTER]) ? secret_state[SECRET_KEYS.OPENROUTER].length > 0 : Boolean(secret_state[SECRET_KEYS.OPENROUTER]);
    if (refreshSettings) {
        $('#continuity_embed_chat').prop('checked', settings.embedMemoryInChat);
        $('#continuity_context_reduction').prop('checked', settings.contextReductionEnabled);
        $('#continuity_tail_mode').val(settings.rawTailMode);
        $('#continuity_tail_value').val(settings.rawTailValue);
        updateTailLimitUI(settings);
        $('#continuity_detail').val(settings.detail);
        $('#continuity_budget').val(settings.injectionBudgetTokens);
        $('#continuity_injection_position').val(settings.injectionPosition);
        $('#continuity_injection_depth').val(settings.injectionDepth);
        $('#continuity_injection_role').val(settings.injectionRole);
        updateInjectionPlacementUI(settings);
        $('#continuity_batch').val(settings.extractionBatchMessages);
        $('#continuity_chunk').val(settings.extractionChunkTokens);
        $('#continuity_correction_tokens').val(resolveCorrectionResponseTokens(settings.correctionResponseTokens));
        $('#continuity_hierarchy_mode').val(settings.hierarchyMode);
        $('#continuity_arc_group').val(settings.arcGroupSize);
        $('#continuity_era_start').val(settings.eraStartArcs);
        $('#continuity_era_group').val(settings.eraGroupSize);
        $('#continuity_thinking').val(settings.thinkingMode);
        $('#continuity_model_profile').val(settings.memoryProfileId || '');
        $('#continuity_retrieval_profile').val(settings.retrievalProfileId || '');
        $('#continuity_story_profile').val(settings.storyProfileId || '');
        $('#continuity_arc_profile').val(settings.arcProfileId || '');
        $('.continuity-ai-retrieval-setting').toggle(settings.retrievalMode === 'ai-expanded');
        $('.continuity-extraction-direct-setting').toggle(settings.memoryProfileId === DIRECT_PROFILE_ID);
        $('.continuity-summary-direct-setting').toggle(settings.arcProfileId === DIRECT_PROFILE_ID || settings.storyProfileId === DIRECT_PROFILE_ID);
        $('#continuity_extraction_direct_provider').val(extractionOpenRouter ? 'openrouter' : 'custom');
        $('#continuity_summary_direct_provider').val(summaryOpenRouter ? 'openrouter' : 'custom');
        $('#continuity_extraction_direct_url').val(extractionOpenRouter ? settings.extractionOpenRouterUrl : settings.extractionDirectUrl).attr('placeholder', extractionOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
        $('#continuity_extraction_direct_model').val(extractionOpenRouter ? settings.extractionOpenRouterModel : settings.extractionDirectModel);
        $('#continuity_summary_direct_url').val(summaryOpenRouter ? settings.summaryOpenRouterUrl : settings.summaryDirectUrl).attr('placeholder', summaryOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
        $('#continuity_summary_direct_model').val(summaryOpenRouter ? settings.summaryOpenRouterModel : settings.summaryDirectModel);
        $('#continuity_extraction_direct_key_status').text(extractionOpenRouter
            ? (sharedOpenRouterSaved ? 'The shared OpenRouter key is saved.' : 'No shared OpenRouter key saved.')
            : (settings.extractionDirectSecretId ? 'An extraction password is saved.' : 'No extraction password saved; keyless endpoints remain supported.'));
        $('#continuity_summary_direct_key_status').text(summaryOpenRouter
            ? (sharedOpenRouterSaved ? 'The shared OpenRouter key is saved.' : 'No shared OpenRouter key saved.')
            : (settings.summaryDirectSecretId ? 'A summarizer password is saved.' : 'No summarizer password saved; keyless endpoints remain supported.'));
        // These fields can contain tens of thousands of characters. Reassigning an
        // unchanged textarea value forces browsers to redo selection and layout work.
        setControlValue('#continuity_extraction_prompt', settings.extractionSystemPrompt);
        setControlValue('#continuity_jb_prompt', settings.jbPrompt);
        setControlValue('#continuity_extraction_template', settings.extractionTaskTemplate);
        setControlValue('#continuity_retrieval_prompt', settings.retrievalSystemPrompt);
        setControlValue('#continuity_retrieval_template', settings.retrievalQueryTemplate);
        setControlValue('#continuity_injection_prompt', settings.injectionInstruction);
        setControlValue('#continuity_arc_prompt', settings.arcSystemPrompt);
        setControlValue('#continuity_arc_template', settings.arcTaskTemplate);
        setControlValue('#continuity_era_prompt', settings.eraSystemPrompt);
        setControlValue('#continuity_era_template', settings.eraTaskTemplate);
    }
    $('#continuity_memory_name').text(runtime.world?.name || (getChatKey() ? 'No stored memory yet; it will be created when processing begins.' : 'Open a chat to begin.'));
    const attachment = runtime.world?.continuation;
    const attached = Boolean(attachment?.originWorldId);
    $('#continuity_attachment_status')
        .prop('hidden', !attached)
        .text(attached
            ? `ATTACHED CONTINUATION MEMORY · Source: “${attachment.originName || attachment.originWorldId}” · Source ID: ${attachment.originWorldId}. This chat is using a separate attached copy; destructive actions will not delete the source memory.`
            : '');
    $('#continuity_detach').prop('hidden', !attached);

    const queueText = runtime.queue.length ? ` · ${runtime.queue.length} queued` : '';
    $('#continuity_status').text(`${runtime.paused ? 'Paused' : runtime.status}${queueText}`);
    const progress = runtime.progress;
    $('#continuity_progress').text(progress
        ? `Processing chunk ${progress.current}/${progress.total} · messages ${progress.from}–${progress.to} · ~${progress.inputTokens || '?'} source tokens`
        : runtime.lastError ? `Last error: ${runtime.lastError}` : runtime.lastCompletedAt ? `Last completed: ${new Date(runtime.lastCompletedAt).toLocaleString()}` : 'Idle');
    const extractionReview = runtime.pendingExtractionReview;
    syncExtractionReviewPopup(extractionReview);
    $('#continuity_arc_status').text(runtime.arcError ? `Hierarchy deferred: ${runtime.arcError}` : runtime.arcStatus || 'L2 and L3 are derived non-destructively when eligible.');
    $('#continuity_retry_status').text(runtime.retryStatus || 'No manual build running.');
    const coverage = getProcessingCoverage();
    $('#continuity_coverage').text(coverage.total
        ? `${coverage.processed}/${coverage.total} messages processed · ${coverage.pending} pending (${coverage.buffered} protected buffer, ${coverage.changed} changed, ${coverage.outdated} need narrative upgrade) · ranges: ${formatRanges(coverage.pendingRanges)}`
        : 'No processable chat messages.');
    const reduction = runtime.contextReduction || {};
    const totalPromptTokens = reduction.totalPromptTokens == null ? null : Math.max(0, Math.round(Number(reduction.totalPromptTokens) || 0));
    $('#continuity_context_stats').text(String(reduction.mode || '').startsWith('active')
        ? `Last request: kept ${reduction.tailTurns} recent turn(s) / ~${reduction.tailTokens} tokens; excluded ${reduction.hiddenMessages} old message(s) / ~${reduction.hiddenTokens} tokens. ${reduction.fixedPromptTokens === null ? 'Learning card/lorebook overhead.' : `Other prompts: ~${reduction.fixedPromptTokens} tokens. ${totalPromptTokens === null ? 'Total sent: measuring.' : `Total sent: ~${totalPromptTokens} tokens (history + all prompts);`} safety reserve: ${reduction.safetyTokens} tokens.`}`
        : `Context reduction: ${reduction.mode || 'waiting'}.`);

    const counts = worldCounts(runtime.world);
    setElementHtml('#continuity_counts', runtime.world
        ? Object.entries(counts).map(([name, count]) => `<span class="continuity-count">${name}: ${count}</span>`).join('')
        : 'No chat memory loaded.');
    renderMemoryViewer();
    setElementText('#continuity_preview', runtime.lastInjection || runtime.injectionStatus || 'Checking memory injection…');
    setElementText(
        '#continuity_last_generation',
        runtime.lastGenerationRetrieval?.injection
            || 'No roleplay generation has been prepared since this chat was opened.',
    );
    setElementText(
        '#continuity_last_generation_status',
        runtime.lastGenerationRetrieval
            ? `Captured ${new Date(runtime.lastGenerationRetrieval.capturedAt).toLocaleString()} · ${runtime.lastGenerationRetrieval.injectionTokens} tokens actually prepared for generation.`
            : 'Waiting for the next roleplay generation.',
    );
    setElementText('#continuity_raw', runtime.lastRawResponse || 'No extraction yet.');
    let memoryProfile = null;
    if (settings.memoryProfileId) {
        if (settings.memoryProfileId === DIRECT_PROFILE_ID) {
            const openRouter = settings.extractionDirectProvider === 'openrouter';
            memoryProfile = { name: `Direct ${openRouter ? 'OpenRouter' : 'custom'} API`, model: openRouter ? settings.extractionOpenRouterModel : settings.extractionDirectModel };
        } else {
            try {
                const profile = ConnectionManagerRequestService.getProfile(settings.memoryProfileId);
                memoryProfile = { name: profile.name, model: profile.model, api: profile.api };
            } catch { memoryProfile = { missingProfileId: settings.memoryProfileId }; }
        }
    }
    const diagnostic = {
        engine: runtime.status,
        paused: runtime.paused,
        queue: runtime.queue.length,
        activeApi: getContext().mainApi || null,
        activeModel: (() => { try { return getContext().getChatCompletionModel?.() || null; } catch { return null; } })(),
        extractionConnection: memoryProfile || 'Current active SillyTavern model',
        thinkingMode: settings.thinkingMode,
        thinkingControl: runtime.thinkingControl || null,
        lastGenerationRetrieval: retrievalSnapshotDiagnostics(runtime.lastGenerationRetrieval),
        nextRetrievalPreview: retrievalSnapshotDiagnostics(runtime.nextRetrievalPreview),
        embeddingIndex: runtime.embeddingIndex || null,
        chatMemory: runtime.world?.name || null,
        memoryRevision: runtime.world?.revision ?? null,
        currentChatLastProcessed: runtime.world?.sources?.[getChatKey()]?.lastProcessedIndex ?? null,
        processingCoverage: {
            processed: coverage.processed,
            pending: coverage.pending,
            extractable: coverage.extractable,
            buffered: coverage.buffered,
            changed: coverage.changed,
            outdated: coverage.outdated,
            neverProcessed: coverage.neverProcessed,
            pendingRanges: coverage.pendingRanges,
        },
        lastImportAlignment: runtime.importAlignment || null,
        injectionTokens: runtime.lastInjectionTokens,
        injectionStatus: runtime.injectionStatus,
        injectionPlacement: {
            position: settings.injectionPosition,
            depth: settings.injectionPosition === 'at-depth' ? settings.injectionDepth : null,
            role: settings.injectionRole,
        },
        contextReduction: runtime.contextReduction,
        lastStarted: runtime.lastStartedAt,
        lastCompleted: runtime.lastCompletedAt,
        validation: runtime.lastValidation || null,
        error: runtime.lastError || null,
        storage: runtime.health,
    };
    setElementText('#continuity_diagnostics', JSON.stringify(diagnostic, null, 2));
}

const scheduleRuntimeRender = createRenderScheduler(() => renderRuntime(false));

async function exportWorld() {
    if (!runtime.world) throw new Error('Open a chat and prepare its memory first.');
    verifySnapshotAlignment(runtime.world, 'export');
    const blob = new Blob([`${JSON.stringify(runtime.world, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `continuity-${runtime.world.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function downloadJson(value, filename) {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function exportContinuationArc() {
    if (!runtime.world) throw new Error('Open a chat and prepare its memory first.');
    verifySnapshotAlignment(runtime.world, 'create a continuation arc');
    const value = createContinuationPackage(runtime.world);
    downloadJson(value, `continuity-continuation-${runtime.world.id}.json`);
    return value;
}

function verifySnapshotAlignment(world, action) {
    const alignment = alignWorldToChat(world, collectFingerprintMessages(getContext().chat || []), getChatKey());
    if (alignment.ok) return alignment;
    const detail = String(alignment.message || 'The memory does not match the open chat.').replace(/^Import blocked:\s*/i, '');
    throw new Error(`Cannot ${action}: memory is still updating or is stale. ${detail}`);
}

async function importWorld(file) {
    const parsed = JSON.parse(await file.text());
    const alignment = verifyMemoryAlignment(parsed);
    if (!window.confirm(`${alignment.message}\n\nImport and attach this memory to the open chat?`)) return null;
    const previousWorldId = getBoundWorldId();
    const previousAttached = previousWorldId && runtime.world?.id === previousWorldId && Boolean(runtime.world?.continuation);
    const previousSharedElsewhere = worldIsSharedElsewhere(previousWorldId);
    const response = await api.importWorld(alignment.world);
    bindCurrentChat(response.world.id);
    updateRuntime({ world: response.world });
    await embedWorldInChat(response.world);
    if (previousWorldId && previousWorldId !== response.world.id && !previousAttached && !previousSharedElsewhere) {
        try { await purgeEmbeddingIndex(previousWorldId); }
        catch (error) { console.warn('[Continuity] Could not remove the replaced memory’s derived embedding index.', error); }
        await api.deleteWorld(previousWorldId);
        markWorldDeleted(previousWorldId);
    }
    await refreshWorlds();
    toast('success', `Imported “${response.world.name}”. ${alignment.message}`);
    return response.world;
}

async function startContinuationArc(file) {
    const chatKey = getChatKey();
    if (!chatKey) throw new Error('Open the destination chat before starting a continuation arc.');
    if (runtime.processing || runtime.queue.length) throw new Error('Stop or finish current memory processing first.');
    const parsed = JSON.parse(await file.text());
    if (parsed?.source?.worldId && parsed.source.worldId === getBoundWorldId()) {
        throw new Error('This is still the source chat. Open or create the new destination chat, then select Start continuation arc there.');
    }
    const prepared = prepareContinuationWorld(parsed, { chatKey });
    const inherited = [
        prepared.entities, prepared.facts, prepared.states,
        prepared.relationships, prepared.events, prepared.threads, prepared.backgrounds,
    ].reduce((total, records) => total + (records?.length || 0), 0);
    const warning = getBoundWorldId()
        ? '\n\nThis destination chat already has Continuity memory. Starting the arc will replace that destination memory after importing the continuation.'
        : '';
    if (!window.confirm(`Start a new continuation arc from “${prepared.continuation.originName}”?\n\n${inherited} structured record(s), plus its L1/L2/L3 chronology, will be inherited. Old source messages will not be treated as messages in this new chat.${warning}`)) return null;

    const previousWorldId = getBoundWorldId();
    const previousAttached = previousWorldId && runtime.world?.id === previousWorldId && Boolean(runtime.world?.continuation);
    const previousSharedElsewhere = previousWorldId && Object.entries(getSettings().chatWorlds || {})
        .some(([boundChatKey, worldId]) => boundChatKey !== chatKey && worldId === previousWorldId);
    const response = await api.importWorld(prepared);
    bindCurrentChat(response.world.id);
    updateRuntime({ world: response.world, importAlignment: { code: 'continuation-baseline', matched: 0, pending: (getContext().chat || []).length } });
    await embedWorldInChat(response.world, { force: true });
    if (previousWorldId && previousWorldId !== response.world.id && !previousAttached && !previousSharedElsewhere) {
        try { await purgeEmbeddingIndex(previousWorldId); }
        catch (error) { console.warn('[Continuity] Could not remove the replaced destination memory’s derived embedding index.', error); }
        await api.deleteWorld(previousWorldId);
        markWorldDeleted(previousWorldId);
    }
    await refreshWorlds();
    toast('success', `Started a continuation arc from “${prepared.continuation.originName}”. New chat messages remain pending for normal extraction.`);
    return response.world;
}

async function cleanChatExport(file) {
    const result = sanitizeChatExport(await file.text(), file.name);
    const blob = new Blob([result.text], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const dot = file.name.lastIndexOf('.');
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const extension = dot > 0 ? file.name.slice(dot) : (result.format === 'jsonl' ? '.jsonl' : '.json');
    link.download = `${stem}.cleaned${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return result.removed;
}

function worldIsSharedElsewhere(worldId, chatKey = getChatKey()) {
    return Boolean(worldId && chatKey && Object.entries(getSettings().chatWorlds || {})
        .some(([boundChatKey, boundWorldId]) => boundChatKey !== chatKey && boundWorldId === worldId));
}

async function detachToEmptyMemory({ confirm = true } = {}) {
    const world = runtime.world;
    const chatKey = getChatKey();
    if (!world || !chatKey) throw new Error('Open a chat with attached memory first.');
    if (runtime.processing) throw new Error('Stop processing before detaching memory.');
    const attachment = world.continuation;
    const sharedElsewhere = worldIsSharedElsewhere(world.id, chatKey);
    if (!attachment && !sharedElsewhere) throw new Error('This chat is not using attached or shared memory.');
    const sourceName = attachment?.originName || attachment?.originWorldId || world.name;
    if (confirm && !window.confirm(`Detach “${sourceName}” from this chat? The attached stored memory and its source will not be changed or deleted. This chat will receive new, verified-empty memory.`)) return { cancelled: true };

    stopEmbeddingIndexing();
    const context = getContext();
    const replacement = (await api.createWorld(`${context.name2 || 'Chat'} · ${context.chatId || 'Memory'}`)).world;
    const residuals = freshResetResiduals(replacement);
    if (residuals.length) {
        try { await api.deleteWorld(replacement.id); }
        catch (error) { console.warn('[Continuity] Could not remove a non-empty replacement memory.', error); }
        throw new Error(`The detached replacement was not empty (${residuals.join(', ')}).`);
    }
    bindCurrentChat(replacement.id);
    await clearPortableSnapshot();
    updateRuntime({
        world: replacement,
        importAlignment: null,
        lastInjection: '',
        lastInjectionTokens: 0,
        lastGenerationRetrieval: null,
        nextRetrievalPreview: null,
        retryStatus: 'Attached memory was detached without modifying it. This chat now has verified-empty memory.',
    });
    if (getSettings().embedMemoryInChat) await embedWorldInChat(replacement, { force: true });
    await refreshWorlds();
    return { detached: true, retainedWorldId: world.id, world: replacement };
}

async function deleteScope() {
    const world = runtime.world;
    if (!world) throw new Error('Open a chat and prepare its memory first.');
    if (runtime.processing) throw new Error('Stop processing before deleting memory.');
    if (world.continuation || worldIsSharedElsewhere(world.id)) {
        const result = await detachToEmptyMemory();
        if (!result.cancelled) toast('success', 'Attached memory retained and detached. This chat now has verified-empty memory.');
        return result;
    }
    if (!window.confirm(`Erase every Continuity record in “${world.name}” and leave this chat with verified-empty memory? This is the same purge used by Erase everything & start over, without rebuilding afterward.`)) return { cancelled: true };
    stopEmbeddingIndexing();
    clearRetrievalExpansionCache();
    try { await purgeEmbeddingIndex(world.id); }
    catch (error) { console.warn('[Continuity] Could not remove the deleted memory’s derived embedding index.', error); }
    const result = await eraseAllMemory();
    if (!getSettings().embedMemoryInChat) await clearPortableSnapshot();
    await refreshWorlds();
    toast('success', 'All memory was erased and verified empty.');
    return result;
}

async function continueFailedL1() {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const coverage = getProcessingCoverage();
    if (!coverage.extractable) return { continued: 0, pendingMessages: 0, pendingTail: coverage.pending, bufferedMessages: coverage.buffered };
    const groupSize = resolveL1GroupSize(getSettings().extractionBatchMessages);
    const eligible = completeL1MessageCount(coverage.extractable, groupSize);
    const pendingTail = coverage.pending - eligible;
    if (!eligible) return { continued: 0, pendingMessages: 0, pendingTail, bufferedMessages: coverage.buffered };
    if (eligible > 50 && !window.confirm(`Continue ${eligible} eligible L1 messages? This may make several extraction requests.`)) return { cancelled: true, continued: 0 };
    if (!getSettings().enabled) throw new Error('Continuity is disabled. Enable it before building memory.');
    // Build Memory is an explicit request to process pending work, so it also
    // serves as Resume after Stop, Pause, or an automatic rate-limit pause.
    if (runtime.paused) resumeRuntime();
    const result = await maybeAutoExtract(true);
    if (!result) throw new Error('No pending L1 messages could be started. Open a populated chat and refresh Continuity.');
    if (result.cancelled) return { cancelled: true, continued: 0, pendingMessages: coverage.pending, pendingTail, bufferedMessages: coverage.buffered };
    return {
        ...result,
        continued: result.chunks || 1,
        pendingMessages: result.messages || 0,
        pendingTail,
        bufferedMessages: coverage.buffered,
    };
}

async function finishHierarchy(l1, clearRetrieval = false, rebuildVectors = false) {
    let arcs = Number(l1.arcs) || 0;
    let eras = Number(l1.eras) || 0;
    const epoch = runtime.generation;
    updateRuntime({ processing: true, status: 'building', retryStatus: 'L1 complete. Building eligible L2 and L3 records…' });
    try {
        while (true) {
            const arc = await buildNextArc(undefined, epoch);
            if (!arc) break;
            arcs++;
        }
        while (true) {
            const era = await buildNextEra(undefined, epoch);
            if (!era) break;
            eras++;
        }
        const cacheEntries = clearRetrieval ? clearRetrievalExpansionCache() : 0;
        let vectors = null;
        if (rebuildVectors && runtime.world?.id) {
            updateRuntime({ retryStatus: 'Fresh L1/L2/L3 complete. Rebuilding the vector index from scratch…' });
            if (getSettings().retrievalMode === 'embedding-hybrid') {
                vectors = await rebuildEmbeddingIndex(runtime.world);
            } else {
                await purgeEmbeddingIndex(runtime.world.id);
                vectors = { status: 'empty', total: 0 };
            }
        }
        updateRuntime({ status: 'idle', retryStatus: `Build complete: L1 ${l1.continued || l1.chunks || 0}, L2 ${arcs}, L3 ${eras}${l1.pendingTail ? `; ${l1.pendingTail} recent message(s) remain raw (${l1.bufferedMessages || 0} protected by the stability buffer)` : ''}${clearRetrieval ? `, retrieval cache ${cacheEntries} cleared` : ''}${rebuildVectors ? `, vectors ${vectors?.total || 0}` : ''}.` });
        return { ...l1, arcs, eras, cacheEntries, vectors };
    } catch (error) {
        if (runtime.paused && isRuntimeCancellation(error)) {
            updateRuntime({ status: 'paused', lastError: '', retryStatus: runtime.retryStatus || 'Processing paused safely.' });
            return { ...l1, cancelled: true, arcs, eras };
        }
        updateRuntime({ status: 'error', retryStatus: `Build stopped safely: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) continueQueue();
    }
}

async function buildMemory() {
    if (restorePendingExtractionReview()) return { cancelled: true, reviewPending: true };
    await ensureCurrentChatMemory(true);
    // A version upgrade makes every older L1 range divergent. Remove those
    // contributions before the first replacement chunk is prompted, so old
    // future ranges cannot leak into earlier rebuilt ranges or donate stale IDs.
    await repairDivergedBranch();
    const l1 = await continueFailedL1();
    if (l1.cancelled) return l1;
    return finishHierarchy(l1, false);
}

async function repairRollback() {
    if (restorePendingExtractionReview()) return { cancelled: true, reviewPending: true };
    const rollback = getTailRollbackStatus();
    if (!rollback.detected) return { cancelled: true };
    if (!window.confirm(`Repair memory after removing ${rollback.removedMessages} tail message(s)? Unaffected L1 extraction results will be replayed locally; only a partially cut range may call the model.`)) return { cancelled: true };
    const repaired = await repairTailRollback();
    return finishHierarchy({ continued: repaired.reextracted, ...repaired }, true);
}

async function undoLatestL1Memory() {
    const latest = getLatestL1UndoStatus();
    if (!latest.available) throw new Error('There is no saved L1 memory to undo for this chat.');
    if (!latest.replayable) throw new Error('This older memory cannot safely undo one L1 range. Rebuild it from scratch first.');
    const dependent = [
        latest.dependentL2 ? `${latest.dependentL2} dependent L2` : '',
        latest.dependentL3 ? `${latest.dependentL3} dependent L3` : '',
    ].filter(Boolean).join(' and ');
    if (!window.confirm(`Undo the latest L1 for messages ${latest.from}–${latest.to}?\n\nThe chat messages will stay, but this L1, facts, states, relationships, events, threads, and backgrounds established by it${dependent ? `, plus ${dependent}` : ''} will be removed. These messages become incomplete memory and will be rebuilt before the next roleplay reply.`)) return { cancelled: true };
    clearRetrievalExpansionCache();
    const result = await undoLatestL1();
    scheduleEmbeddingIndexSync(result.world, 0);
    renderMemoryViewer(true);
    return result;
}

async function restartBuild() {
    if (restorePendingExtractionReview()) return { cancelled: true, reviewPending: true };
    await ensureCurrentChatMemory(true);
    const messageCount = getContext().chat?.length || 0;
    const attached = Boolean(runtime.world?.continuation || worldIsSharedElsewhere(runtime.world?.id));
    const attachmentNotice = runtime.world?.continuation
        ? `\n\nATTACHED MEMORY: “${runtime.world.continuation.originName || runtime.world.continuation.originWorldId}” will be detached and retained unchanged. Only this chat’s messages will be rebuilt into a new owned memory.`
        : attached
            ? '\n\nSHARED MEMORY: the shared world will be detached and retained unchanged. Only this chat’s messages will be rebuilt into a new owned memory.'
            : '';
    if (!window.confirm(`Rebuild extracted memory from the beginning for all ${messageCount} chat messages? Delete All and Start Over use the same verified-empty purge; Start Over then rebuilds automatically. Reviewed corrections, L1/L2/L3, extraction records, retrieval cache, and vectors belonging to this chat are cleared.${attachmentNotice}`)) return { cancelled: true };
    stopEmbeddingIndexing();
    clearRetrievalExpansionCache();
    if (attached) {
        await detachToEmptyMemory({ confirm: false });
    } else {
        try { await purgeEmbeddingIndex(runtime.world?.id); }
        catch (error) { console.warn('[Continuity] Could not purge the old derived embedding index before Start Over.', error); }
    }
    const l1 = await restartL1FromScratch();
    return finishHierarchy(l1, true, true);
}

async function rebuildHierarchy() {
    if (restorePendingExtractionReview()) return { cancelled: true, reviewPending: true };
    await ensureCurrentChatMemory(true);
    const l1Count = runtime.world?.capsules?.length || 0;
    if (!l1Count) throw new Error('There are no L1 records to build L2/L3 from. Use Build or erase everything and start over.');
    if (!window.confirm(`Delete and regenerate L2 and L3 from the ${l1Count} existing L1 record(s)? L1, extracted base memory, and extraction records will remain untouched. L3 will be rebuilt only after the new L2 is complete.`)) return { cancelled: true };
    stopEmbeddingIndexing();
    clearRetrievalExpansionCache();
    try { await purgeEmbeddingIndex(runtime.world.id); }
    catch (error) { console.warn('[Continuity] Could not purge the old derived embedding index before rebuilding L2/L3.', error); }
    const reset = await restartHierarchyFromL1();
    return finishHierarchy(reset, true, true);
}

async function reviewCorrection() {
    const instruction = String($('#continuity_correction_input').val() || '').trim();
    pendingCorrection = null;
    $('#continuity_correction_preview_panel').prop('hidden', true);
    $('#continuity_correction_status').text('Reviewing matching stored memory…');
    const proposal = await reviewMemoryCorrection(instruction);
    pendingCorrection = proposal;
    $('#continuity_correction_preview').text(formatCorrectionPreview(proposal));
    $('#continuity_correction_preview_panel').prop('hidden', false);
    $('#continuity_correction_status').text(`${proposal.operations.length} proposed change(s). Nothing has been saved yet.`);
    return proposal;
}

async function applyReviewedCorrection() {
    if (!pendingCorrection) throw new Error('Review a correction before applying it.');
    const result = await commitMemoryCorrection(pendingCorrection);
    pendingCorrection = null;
    $('#continuity_correction_input').val('');
    $('#continuity_correction_preview').text('');
    $('#continuity_correction_preview_panel').prop('hidden', true);
    $('#continuity_correction_status').text(result.hierarchyError
        ? `Correction saved, but hierarchy rebuilding stopped: ${result.hierarchyError}`
        : `Applied ${result.changed} change(s); rebuilt ${result.arcs || 0} L2 and ${result.eras || 0} L3 record(s).`);
    clearRetrievalExpansionCache();
    scheduleEmbeddingIndexSync(result.world, 0);
    renderMemoryViewer(true);
    return result;
}

function cancelCorrection() {
    pendingCorrection = null;
    $('#continuity_correction_preview').text('');
    $('#continuity_correction_preview_panel').prop('hidden', true);
    $('#continuity_correction_status').text('Correction cancelled; nothing was changed.');
}

export function initUI() {
    const settings = getSettings();
    installNativeChatExportBridge();
    installReviewRecoveryListeners();
    initSectionToggle();
    $('#continuity_reset_defaults').on('click', async () => {
        if (!window.confirm('Reset all Continuity settings and prompts to their built-in defaults? Stored memory and chat bindings will not be changed.')) return;
        resetConfigurationSettings();
        if (getSettings().embedMemoryInChat && runtime.world) await embedWorldInChat(runtime.world);
        if (!getSettings().embedMemoryInChat) await clearPortableSnapshot();
        refreshModelProfiles();
        renderRuntime();
        toast('success', 'Continuity configuration reset. Stored memory was not changed.');
    });
    setSetting('#continuity_enabled', 'enabled', Boolean);
    setSetting('#continuity_notifications', 'showNotifications', Boolean);
    setSetting('#continuity_retrieval_mode', 'retrievalMode');
    setSetting('#continuity_story_so_far', 'storySoFarEnabled', Boolean);
    setSetting('#continuity_story_so_far_tokens', 'storySoFarTokens', value => Math.min(12000, Math.max(0, Number(value) || 0)));
    $('#continuity_story_recalculate').on('click', async () => {
        const existing = runtime.world?.storySoFar?.[getChatKey()]?.text;
        const messageCount = collectMemoryEligibleMessages(getContext().chat || []).length;
        if (!messageCount) return toast('error', 'This chat has no eligible raw messages to summarize.');
        if (!window.confirm(`${existing ? 'Recalculate' : 'Build'} Story so far from all ${messageCount} eligible raw chat messages? This calls the selected summarizer in batches but does not read or modify L1, L2, L3, facts, state, or retrieval records.`)) return;
        try {
            const result = await rebuildRollingStory();
            toast('success', `Story so far recalculated from ${result.messages} raw message(s).`);
        } catch (error) {
            if (!isRuntimeCancellation(error)) toast('error', error.message);
        }
    });
    $('#continuity_story_stop').on('click', () => {
        const stopped = stopRuntimeTask('rebuilding-story', 'Stopping Story so far; completed batches remain saved and the in-flight batch will be discarded.');
        if (stopped) toast('info', 'Stopping Story so far. The last completed batch was kept.');
    });
    $('#continuity_story_delete').on('click', async () => {
        if (!window.confirm('Delete only this chat’s Story so far? Structured recall, L1/L2/L3, facts, state, and chat messages will remain unchanged.')) return;
        try {
            await deleteRollingStory();
            toast('success', 'Story so far deleted; structured recall was unchanged.');
        } catch (error) {
            toast('error', error.message);
        }
    });
    $('#continuity_retrieval_mode').on('change', () => {
        if (getSettings().retrievalMode === 'embedding-hybrid' && runtime.world) scheduleEmbeddingIndexSync(runtime.world, 0);
    });
    setSetting('#continuity_retrieval_messages', 'retrievalQueryMessages', value => Math.min(50, Math.max(2, Number(value) || 6)));
    setSetting('#continuity_embedding_messages', 'embeddingQueryMessages', value => Math.min(12, Math.max(1, Number(value) || 4)));
    setSetting('#continuity_embedding_top_k', 'embeddingTopK', value => Math.min(200, Math.max(10, Number(value) || 100)));
    setSetting('#continuity_embedding_threshold', 'embeddingThreshold', value => Math.min(1, Math.max(0, Number(value) || 0)));
    setSetting('#continuity_embedding_provider_choice', 'embeddingProvider', value => value === 'openrouter' ? 'openrouter' : 'proxy');
    $('#continuity_embedding_provider_choice').on('change', () => $('#continuity_embedding_api_key').val(''));
    setSetting('#continuity_embedding_proxy_url', 'embeddingProxyUrl', value => String(value || '').trim());
    setSetting('#continuity_embedding_openrouter_url', 'embeddingOpenRouterUrl', value => String(value || '').trim());
    setSetting('#continuity_embedding_proxy_model', 'embeddingProxyModel', value => String(value || '').trim());
    setSetting('#continuity_embedding_openrouter_model', 'embeddingOpenRouterModel', value => String(value || '').trim());
    setSetting('#continuity_embedding_auto_sync', 'embeddingAutoSync', Boolean);
    $('#continuity_embedding_auto_sync').on('change', () => {
        if (getSettings().embeddingAutoSync && runtime.world) scheduleEmbeddingIndexSync(runtime.world, 0);
    });
    $('#continuity_embedding_provider_choice, #continuity_embedding_proxy_url, #continuity_embedding_openrouter_url, #continuity_embedding_proxy_model, #continuity_embedding_openrouter_model').on('change', () => {
        if (runtime.world) scheduleEmbeddingIndexSync(runtime.world, 0);
    });
    $('#continuity_embedding_save_key').on('click', () => {
        if (!String($('#continuity_embedding_api_key').val() || '').trim()) return toast('error', 'Enter an embedding API key first.');
        saveEmbeddingKey().then(() => {
            if (runtime.world) scheduleEmbeddingIndexSync(runtime.world, 0);
        }).catch(error => toast('error', error.message));
    });
    $('#continuity_embedding_fetch_models').on('click', () => {
        $('#continuity_embedding_models_status').text('Fetching embedding models…');
        fetchEmbeddingModels()
            .then(models => toast('success', `Fetched ${models.length} embedding model option(s).`))
            .catch(error => {
                $('#continuity_embedding_models_status').text(`Model discovery failed: ${error.message} Manual model entry remains available.`);
                toast('error', error.message);
            });
    });
    setSetting('#continuity_auto', 'autoExtract', Boolean);
    setSetting('#continuity_review_extractions', 'reviewBeforeCommit', Boolean);
    setSetting('#continuity_jb_enabled', 'jbEnabled', Boolean);
    $('#continuity_embed_chat').on('change', async function () {
        const enabled = $(this).prop('checked');
        getSettings().embedMemoryInChat = enabled;
        saveSettings();
        try {
            if (enabled) {
                const world = runtime.world
                    || (getBoundWorldId() ? await loadBoundWorld() : await ensureCurrentChatMemory(true));
                if (world) await embedWorldInChat(world, { force: true });
            } else {
                await clearPortableSnapshot();
            }
            toast('info', enabled ? 'Portable memory embedding is enabled for all chats.' : 'Embedding is off globally. This chat is clean; other chats are cleaned when opened.');
        } catch (error) {
            toast('error', `Could not save the chat-file embedding change: ${error.message}`);
        } finally {
            renderRuntime();
        }
    });
    setSetting('#continuity_context_reduction', 'contextReductionEnabled', Boolean);
    setSetting('#continuity_tail_mode', 'rawTailMode', value => value === 'turns' ? 'turns' : 'tokens');
    setSetting('#continuity_tail_value', 'rawTailValue', value => {
        const maximum = getSettings().rawTailMode === 'turns' ? 100 : 100000;
        return Math.min(maximum, Math.max(0, Number(value) || 0));
    });
    setSetting('#continuity_detail', 'detail');
    setSetting('#continuity_budget', 'injectionBudgetTokens', value => Math.min(100000, Math.max(0, Number(value) || 0)));
    setSetting('#continuity_injection_position', 'injectionPosition');
    setSetting('#continuity_injection_depth', 'injectionDepth', value => Math.min(100, Math.max(0, Number(value) || 0)));
    setSetting('#continuity_injection_role', 'injectionRole');
    $('#continuity_batch').on('change', function () {
        const result = validateL1GroupSize($(this).val());
        $(this).val(result.value);
        getSettings().extractionBatchMessages = result.value;
        saveSettings();
        renderRuntime();
        if (!result.valid) settingWarning(`Messages per L1 must be a whole number from 2 to 50. Adjusted to ${result.value}.`);
    });
    setSetting('#continuity_chunk', 'extractionChunkTokens', value => Math.min(50000, Math.max(0, Number(value) || 0)));
    setSetting('#continuity_correction_tokens', 'correctionResponseTokens', resolveCorrectionResponseTokens);
    setSetting('#continuity_hierarchy_mode', 'hierarchyMode', value => ['off', 'l2', 'l3'].includes(value) ? value : 'l3');
    setSetting('#continuity_arc_group', 'arcGroupSize', value => Math.min(200, Math.max(4, Number(value) || 24)));
    setSetting('#continuity_era_start', 'eraStartArcs', value => Math.min(100, Math.max(8, Number(value) || 12)));
    setSetting('#continuity_era_group', 'eraGroupSize', value => Math.min(16, Math.max(3, Number(value) || 6)));
    setSetting('#continuity_thinking', 'thinkingMode');
    setSetting('#continuity_model_profile', 'memoryProfileId');
    setSetting('#continuity_retrieval_profile', 'retrievalProfileId');
    setSetting('#continuity_story_profile', 'storyProfileId');
    setSetting('#continuity_arc_profile', 'arcProfileId');
    setSetting('#continuity_extraction_direct_provider', 'extractionDirectProvider', value => value === 'openrouter' ? 'openrouter' : 'custom');
    setSetting('#continuity_summary_direct_provider', 'summaryDirectProvider', value => value === 'openrouter' ? 'openrouter' : 'custom');
    $('#continuity_extraction_direct_provider').on('change', () => $('#continuity_extraction_direct_model_select').empty().hide() && $('#continuity_extraction_direct_models_status').text('Model list not fetched yet.'));
    $('#continuity_summary_direct_provider').on('change', () => $('#continuity_summary_direct_model_select').empty().hide() && $('#continuity_summary_direct_models_status').text('Model list not fetched yet.'));
    $('#continuity_extraction_direct_url, #continuity_extraction_direct_model, #continuity_summary_direct_url, #continuity_summary_direct_model').on('change', function () {
        const settings = getSettings();
        const extraction = this.id.includes('extraction');
        const model = this.id.endsWith('_model');
        const openRouter = settings[extraction ? 'extractionDirectProvider' : 'summaryDirectProvider'] === 'openrouter';
        const key = extraction
            ? openRouter ? model ? 'extractionOpenRouterModel' : 'extractionOpenRouterUrl' : model ? 'extractionDirectModel' : 'extractionDirectUrl'
            : openRouter ? model ? 'summaryOpenRouterModel' : 'summaryOpenRouterUrl' : model ? 'summaryDirectModel' : 'summaryDirectUrl';
        settings[key] = String($(this).val() || '').trim();
        saveSettings();
        renderRuntime();
    });
    $('#continuity_extraction_direct_save_key').on('click', () => saveDirectApiKey('extraction').then(() => toast('success', 'Extraction API password saved securely.')).catch(error => toast('error', error.message)));
    $('#continuity_summary_direct_save_key').on('click', () => saveDirectApiKey('summary').then(() => toast('success', 'Summarizer API password saved securely.')).catch(error => toast('error', error.message)));
    $('#continuity_extraction_direct_fetch_models').on('click', () => fetchDirectModels('extraction').then(models => toast('success', `Fetched ${models.length} extraction model(s).`)).catch(error => { $('#continuity_extraction_direct_models_status').text(error.message); toast('error', error.message); }));
    $('#continuity_summary_direct_fetch_models').on('click', () => fetchDirectModels('summary').then(models => toast('success', `Fetched ${models.length} summarizer model(s).`)).catch(error => { $('#continuity_summary_direct_models_status').text(error.message); toast('error', error.message); }));
    $('#continuity_extraction_direct_model_select').on('change', function () { $('#continuity_extraction_direct_model').val($(this).val()).trigger('change'); });
    $('#continuity_summary_direct_model_select').on('change', function () { $('#continuity_summary_direct_model').val($(this).val()).trigger('change'); });
    setSetting('#continuity_extraction_prompt', 'extractionSystemPrompt', String);
    setSetting('#continuity_jb_prompt', 'jbPrompt', String);
    setSetting('#continuity_extraction_template', 'extractionTaskTemplate', String);
    setSetting('#continuity_retrieval_prompt', 'retrievalSystemPrompt', String);
    setSetting('#continuity_retrieval_template', 'retrievalQueryTemplate', String);
    setSetting('#continuity_injection_prompt', 'injectionInstruction', String);
    setSetting('#continuity_arc_prompt', 'arcSystemPrompt', String);
    setSetting('#continuity_arc_template', 'arcTaskTemplate', String);
    setSetting('#continuity_era_prompt', 'eraSystemPrompt', String);
    setSetting('#continuity_era_template', 'eraTaskTemplate', String);

    $('#continuity_reset_prompts').on('click', () => {
        if (!window.confirm('Reset all Continuity prompt instructions to their built-in defaults?')) return;
        resetPromptSettings();
        renderRuntime();
        toast('success', 'Continuity prompts reset to defaults.');
    });

    $('#continuity_refresh').on('click', () => refreshWorlds().catch(error => toast('error', error.message)));
    $('#continuity_detach').on('click', () => detachToEmptyMemory()
        .then(result => !result.cancelled && toast('success', 'Attached memory retained unchanged and detached from this chat.'))
        .catch(error => toast('error', error.message)));
    $('#continuity_stop').on('click', () => { stopRuntime(); toast('info', 'Processing stopped and the queue was cleared.'); });
    $('#continuity_build').on('click', () => buildMemory()
        .then(result => !result.cancelled && toast(result.continued || result.arcs || result.eras ? 'success' : 'info', result.continued || result.arcs || result.eras ? 'Memory build completed.' : 'Memory is already up to date.'))
        .catch(error => toast('error', error.message)));
    $('#continuity_undo_latest_l1').on('click', () => undoLatestL1Memory()
        .then(result => !result.cancelled && toast('success', `Undid L1 messages ${result.from}–${result.to}${result.removedL2 || result.removedL3 ? `; removed ${result.removedL2} L2 and ${result.removedL3} L3` : ''}. The range will rebuild before the next reply.`))
        .catch(error => toast('error', error.message)));
    $('#continuity_repair_rollback').on('click', () => repairRollback()
        .then(result => !result.cancelled && toast('success', `Rollback repaired: removed memory from ${result.removedMessages || 0} deleted message(s).`))
        .catch(error => toast('error', error.message)));
    $('#continuity_restart_build').on('click', () => restartBuild()
        .then(result => !result.cancelled && toast('success', `Fresh build complete: ${result.messages || 0} messages${result.arcs !== undefined ? `, ${result.arcs} L2 records` : ''}.`))
        .catch(error => toast('error', error.message)));
    $('#continuity_rebuild_hierarchy').on('click', () => rebuildHierarchy()
        .then(result => !result.cancelled && toast('success', `Hierarchy rebuilt: ${result.arcs || 0} L2 and ${result.eras || 0} L3 records.`))
        .catch(error => toast('error', error.message)));
    $('#continuity_correction_review').on('click', () => reviewCorrection()
        .catch(error => { $('#continuity_correction_status').text(error.message); toast('error', error.message); }));
    $('#continuity_correction_apply').on('click', () => applyReviewedCorrection()
        .then(result => toast(result.hierarchyError ? 'warning' : 'success', result.hierarchyError
            ? `Correction saved; hierarchy rebuild needs attention: ${result.hierarchyError}`
            : `Corrected ${result.changed} stored memory record(s) and rebuilt affected hierarchy.`))
        .catch(error => { $('#continuity_correction_status').text(error.message); toast('error', error.message); }));
    $('#continuity_correction_cancel').on('click', cancelCorrection);
    $('#continuity_test_storage').on('click', async () => {
        try { updateRuntime({ health: await api.health(), lastError: '' }); toast('success', 'Storage is healthy.'); }
        catch (error) { updateRuntime({ health: null, lastError: error.message }); toast('error', error.message); }
    });
    $('#continuity_test_extractor').on('click', () => testExtractor().then(() => toast('success', 'The active API produced valid structured memory.')).catch(error => toast('error', error.message)));
    $('#continuity_embedding_build').on('click', () => {
        if (!runtime.world) return toast('error', 'Open a chat with Continuity memory first.');
        resumeEmbeddingIndexing(runtime.world)
            .then(result => toast('success', `Embedding index ready with ${result.total || 0} records.`))
            .catch(error => toast('error', error.message));
    });
    $('#continuity_embedding_rebuild').on('click', () => {
        if (!runtime.world) return toast('error', 'Open a chat with Continuity memory first.');
        rebuildEmbeddingIndex(runtime.world)
            .then(result => toast('success', `Embedding index rebuilt with ${result.total || 0} records.`))
            .catch(error => toast('error', error.message));
    });
    $('#continuity_embedding_pause').on('click', () => {
        if (!runtime.world) return toast('error', 'Open a chat with Continuity memory first.');
        if (['paused', 'stopped', 'error'].includes(runtime.embeddingIndex?.status)) {
            resumeEmbeddingIndexing(runtime.world).catch(error => toast('error', error.message));
        } else {
            pauseEmbeddingIndexing();
        }
        renderRuntime();
    });
    $('#continuity_embedding_stop').on('click', () => {
        stopEmbeddingIndexing();
        renderRuntime();
        toast('info', 'Vector indexing stopped; completed vectors were preserved.');
    });
    $('#continuity_embedding_delete').on('click', () => {
        if (!runtime.world) return toast('error', 'Open a chat with Continuity memory first.');
        if (!window.confirm('Delete this memory’s derived embedding index? Structured Continuity memory will not be changed.')) return;
        purgeEmbeddingIndex(runtime.world.id)
            .then(() => toast('success', 'Derived embedding index deleted.'))
            .catch(error => toast('error', error.message));
    });
    $('#continuity_export').on('click', () => exportWorld().catch(error => toast('error', error.message)));
    $('#continuity_import').on('change', function () { const file = this.files?.[0]; if (file) importWorld(file).catch(error => toast('error', error.message)); this.value = ''; });
    $('#continuity_export_continuation').on('click', () => exportContinuationArc().then(() => toast('success', 'Continuation-arc file downloaded. Open the destination chat and select Start continuation arc.')).catch(error => toast('error', error.message)));
    $('#continuity_import_continuation').on('change', function () { const file = this.files?.[0]; if (file) startContinuationArc(file).catch(error => toast('error', error.message)); this.value = ''; });
    $('#continuity_clean_chat').on('change', function () { const file = this.files?.[0]; if (file) cleanChatExport(file).then(count => toast('success', `Downloaded a clean chat copy with ${count} embedded Continuity block(s) removed.`)).catch(error => toast('error', error.message)); this.value = ''; });
    $('#continuity_viewer_category').on('change', function () { viewerCategory = String($(this).val() || 'l1'); viewerPage = 0; renderMemoryViewer(true); });
    $('#continuity_viewer_search').on('input', function () { viewerSearch = String($(this).val() || ''); viewerPage = 0; renderMemoryViewer(true); });
    $('#continuity_viewer_previous').on('click', () => { viewerPage = Math.max(0, viewerPage - 1); renderMemoryViewer(true); });
    $('#continuity_viewer_next').on('click', () => { viewerPage++; renderMemoryViewer(true); });
    $('#continuity_delete').on('click', () => deleteScope().catch(error => toast('error', error.message)));

    // Runtime updates often arrive in bursts while extraction or indexing is
    // progressing. One paint-aligned refresh preserves every final state while
    // preventing a burst from blocking SillyTavern's main browser thread.
    onRuntimeChange(scheduleRuntimeRender);
    refreshModelProfiles();
    renderRuntime();
    void refreshWorlds().catch(error => { updateRuntime({ lastError: `Storage unavailable: ${error.message}` }); });
    return {};
}

export function previewInjection() {
    const context = getContext();
    const recent = (context.chat || []).slice(-12);
    const settings = getSettings();
    const budget = resolveInjectionBudget(settings.injectionBudgetTokens, context.maxContext);
    const storyBudget = resolveStoryBudget(settings.storySoFarTokens, context.maxContext);
    const coverage = getProcessingCoverage(runtime.world);
    return buildMemoryPrompt(runtime.world, recent, budget.tokens, getChatKey(), [], settings.injectionInstruction, new Map(), {
        includeSceneCheckpoint: coverage.pending === 0,
        includeStorySoFar: settings.storySoFarEnabled,
        storySoFarTokens: storyBudget.tokens,
    });
}
