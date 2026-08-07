import { getRequestHeaders } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { SECRET_KEYS, secret_state, writeSecret } from '/scripts/secrets.js';
import { api } from './api.js';
import { buildNextArc, buildNextEra, commitMemoryCorrection, continueQueue, getProcessingCoverage, getTailRollbackStatus, loadBoundWorld, maybeAutoExtract, repairTailRollback, restartHierarchyFromL1, restartL1FromScratch, reviewMemoryCorrection, testExtractor } from './engine.js?v=0.14.0-standalone.56';
import { worldCounts } from './memory-model.js';
import { clearPortableSnapshot, embedWorldInChat, getPortableSnapshot } from './portable.js';
import { buildMemoryPrompt } from './retrieval.js';
import { clearRetrievalExpansionCache } from './semantic-retrieval.js';
import { sanitizeChatExport } from './chat-sanitizer.js';
import { MEMORY_VIEW_CATEGORIES, memoryViewerPage } from './memory-viewer.js';
import { formatCorrectionPreview } from './memory-correction.js';
import { resolveCorrectionResponseTokens } from './correction-policy.js';
import { alignWorldToChat, collectFingerprintMessages } from './fingerprint.js?v=0.14.0-standalone.56';
import { resolveMissingWorldBinding } from './chat-ownership.js?v=0.14.0-standalone.56';
import { runtime, onRuntimeChange, pauseRuntime, resumeRuntime, stopRuntime, updateRuntime } from './runtime.js?v=0.14.0-standalone.56';
import { completeL1MessageCount, resolveL1GroupSize, validateL1GroupSize } from './l1-policy.js';
import { resolveInjectionBudget } from './injection-budget.js';
import { bindCurrentChat, getBoundWorldId, getChatKey, getSettings, markWorldDeleted, resetConfigurationSettings, resetPromptSettings, saveSettings } from './settings.js?v=0.14.0-standalone.56';
import { embeddingProviderDescription, pauseEmbeddingIndexing, purgeEmbeddingIndex, rebuildEmbeddingIndex, resumeEmbeddingIndexing, scheduleEmbeddingIndexSync, stopEmbeddingIndexing } from './embedding-retrieval.js?v=0.14.0-standalone.56';
import { embeddingModelChoices, resolveEmbeddingProvider } from './embedding-provider.js?v=0.14.0-standalone.56';

let worlds = [];
let creatingChatMemory = null;
let pendingCorrection = null;
let viewerCategory = 'l1';
let viewerSearch = '';
let viewerPage = 0;
let viewerSignature = '';
const DIRECT_PROFILE_ID = '__direct__';

function verifyMemoryAlignment(world) {
    const alignment = alignWorldToChat(world, collectFingerprintMessages(getContext().chat || []), getChatKey());
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

function settingWarning(message) {
    if (window.toastr?.warning) window.toastr.warning(message, 'Continuity Memory');
    else console.warn(`[Continuity] ${message}`);
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
        const portable = getPortableSnapshot();
        if (portable && !(getSettings().deletedWorldIds || []).includes(portable.world.id)) {
            let alignment;
            try {
                alignment = verifyMemoryAlignment(portable.world);
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
            toast('success', 'Restored this chat’s embedded Continuity memory.');
            return imported.world;
        }
        if (portable) await clearPortableSnapshot();
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
    const arcSelect = $('#continuity_arc_profile').empty()
        .append($('<option>').val('').text('Same as extraction model'))
        .append($('<option>').val(DIRECT_PROFILE_ID).text('Direct OpenAI-compatible API'));
    try {
        for (const profile of ConnectionManagerRequestService.getSupportedProfiles()) {
            const model = profile.model ? ` — ${profile.model}` : '';
            $('<option>').val(profile.id).text(`${profile.name}${model}`).appendTo(extractionSelect);
            $('<option>').val(profile.id).text(`${profile.name}${model}`).appendTo(retrievalSelect);
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
    const arcExists = [...arcSelect[0].options].some(option => option.value === settings.arcProfileId);
    if (!arcExists && settings.arcProfileId) {
        settings.arcProfileId = '';
        saveSettings();
    }
    extractionSelect.val(settings.memoryProfileId || '');
    retrievalSelect.val(settings.retrievalProfileId || '');
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

export function renderRuntime() {
    const settings = getSettings();
    $('#continuity_enabled').prop('checked', settings.enabled);
    $('#continuity_notifications').prop('checked', settings.showNotifications);
    $('#continuity_retrieval_mode').val(settings.retrievalMode);
    $('.continuity-ai-retrieval-setting').toggle(settings.retrievalMode === 'ai-expanded');
    $('.continuity-text-retrieval-setting').toggle(settings.retrievalMode !== 'embedding-hybrid');
    $('.continuity-embedding-setting').toggle(settings.retrievalMode === 'embedding-hybrid');
    $('#continuity_retrieval_messages').val(settings.retrievalQueryMessages);
    $('#continuity_embedding_messages').val(settings.embeddingQueryMessages);
    $('#continuity_embedding_top_k').val(settings.embeddingTopK);
    $('#continuity_embedding_threshold').val(settings.embeddingThreshold);
    updateEmbeddingProviderUI(settings);
    $('#continuity_embedding_provider').text(`Provider: ${embeddingProviderDescription()}`);
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
    $('#continuity_embedding_auto_sync').prop('checked', settings.embeddingAutoSync);
    $('#continuity_auto').prop('checked', settings.autoExtract);
    $('#continuity_jb_enabled').prop('checked', settings.jbEnabled);
    const rollback = getTailRollbackStatus();
    $('#continuity_repair_rollback')
        .toggle(rollback.detected)
        .html(`<i class="fa-solid fa-clock-rotate-left"></i> Repair rollback${rollback.detected ? ` (${rollback.removedMessages})` : ''}`);
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
    $('#continuity_arc_profile').val(settings.arcProfileId || '');
    $('.continuity-ai-retrieval-setting').toggle(settings.retrievalMode === 'ai-expanded');
    $('.continuity-extraction-direct-setting').toggle(settings.memoryProfileId === DIRECT_PROFILE_ID);
    $('.continuity-summary-direct-setting').toggle(settings.arcProfileId === DIRECT_PROFILE_ID);
    const extractionOpenRouter = settings.extractionDirectProvider === 'openrouter';
    const summaryOpenRouter = settings.summaryDirectProvider === 'openrouter';
    $('#continuity_extraction_direct_provider').val(extractionOpenRouter ? 'openrouter' : 'custom');
    $('#continuity_summary_direct_provider').val(summaryOpenRouter ? 'openrouter' : 'custom');
    $('#continuity_extraction_direct_url').val(extractionOpenRouter ? settings.extractionOpenRouterUrl : settings.extractionDirectUrl).attr('placeholder', extractionOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
    $('#continuity_extraction_direct_model').val(extractionOpenRouter ? settings.extractionOpenRouterModel : settings.extractionDirectModel);
    $('#continuity_summary_direct_url').val(summaryOpenRouter ? settings.summaryOpenRouterUrl : settings.summaryDirectUrl).attr('placeholder', summaryOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
    $('#continuity_summary_direct_model').val(summaryOpenRouter ? settings.summaryOpenRouterModel : settings.summaryDirectModel);
    const sharedOpenRouterSaved = Array.isArray(secret_state[SECRET_KEYS.OPENROUTER]) ? secret_state[SECRET_KEYS.OPENROUTER].length > 0 : Boolean(secret_state[SECRET_KEYS.OPENROUTER]);
    $('#continuity_extraction_direct_key_status').text(extractionOpenRouter
        ? (sharedOpenRouterSaved ? 'The shared OpenRouter key is saved.' : 'No shared OpenRouter key saved.')
        : (settings.extractionDirectSecretId ? 'An extraction password is saved.' : 'No extraction password saved; keyless endpoints remain supported.'));
    $('#continuity_summary_direct_key_status').text(summaryOpenRouter
        ? (sharedOpenRouterSaved ? 'The shared OpenRouter key is saved.' : 'No shared OpenRouter key saved.')
        : (settings.summaryDirectSecretId ? 'A summarizer password is saved.' : 'No summarizer password saved; keyless endpoints remain supported.'));
    $('#continuity_extraction_prompt').val(settings.extractionSystemPrompt);
    $('#continuity_jb_prompt').val(settings.jbPrompt);
    $('#continuity_extraction_template').val(settings.extractionTaskTemplate);
    $('#continuity_retrieval_prompt').val(settings.retrievalSystemPrompt);
    $('#continuity_retrieval_template').val(settings.retrievalQueryTemplate);
    $('#continuity_injection_prompt').val(settings.injectionInstruction);
    $('#continuity_arc_prompt').val(settings.arcSystemPrompt);
    $('#continuity_arc_template').val(settings.arcTaskTemplate);
    $('#continuity_era_prompt').val(settings.eraSystemPrompt);
    $('#continuity_era_template').val(settings.eraTaskTemplate);
    $('#continuity_memory_name').text(runtime.world?.name || (getChatKey() ? 'No stored memory yet; it will be created when processing begins.' : 'Open a chat to begin.'));

    const queueText = runtime.queue.length ? ` · ${runtime.queue.length} queued` : '';
    $('#continuity_status').text(`${runtime.paused ? 'Paused' : runtime.status}${queueText}`);
    const progress = runtime.progress;
    $('#continuity_progress').text(progress
        ? `Processing chunk ${progress.current}/${progress.total} · messages ${progress.from}–${progress.to} · ~${progress.inputTokens || '?'} source tokens`
        : runtime.lastError ? `Last error: ${runtime.lastError}` : runtime.lastCompletedAt ? `Last completed: ${new Date(runtime.lastCompletedAt).toLocaleString()}` : 'Idle');
    $('#continuity_arc_status').text(runtime.arcError ? `Hierarchy deferred: ${runtime.arcError}` : runtime.arcStatus || 'L2 and L3 are derived non-destructively when eligible.');
    $('#continuity_retry_status').text(runtime.retryStatus || 'No manual build running.');
    const coverage = getProcessingCoverage();
    $('#continuity_coverage').text(coverage.total
        ? `${coverage.processed}/${coverage.total} messages processed · ${coverage.pending} pending (${coverage.changed} changed, ${coverage.outdated} need narrative upgrade) · ranges: ${formatRanges(coverage.pendingRanges)}`
        : 'No processable chat messages.');
    $('#continuity_pause').html(runtime.paused ? '<i class="fa-solid fa-play"></i> Resume' : '<i class="fa-solid fa-pause"></i> Pause');
    const reduction = runtime.contextReduction || {};
    const totalPromptTokens = reduction.totalPromptTokens == null ? null : Math.max(0, Math.round(Number(reduction.totalPromptTokens) || 0));
    $('#continuity_context_stats').text(String(reduction.mode || '').startsWith('active')
        ? `Last request: kept ${reduction.tailTurns} recent turn(s) / ~${reduction.tailTokens} tokens; excluded ${reduction.hiddenMessages} old message(s) / ~${reduction.hiddenTokens} tokens. ${reduction.fixedPromptTokens === null ? 'Learning card/lorebook overhead.' : `Other prompts: ~${reduction.fixedPromptTokens} tokens. ${totalPromptTokens === null ? 'Total sent: measuring.' : `Total sent: ~${totalPromptTokens} tokens (history + all prompts);`} safety reserve: ${reduction.safetyTokens} tokens.`}`
        : `Context reduction: ${reduction.mode || 'waiting'}.`);

    const counts = worldCounts(runtime.world);
    $('#continuity_counts').html(runtime.world
        ? Object.entries(counts).map(([name, count]) => `<span class="continuity-count">${name}: ${count}</span>`).join('')
        : 'No chat memory loaded.');
    renderMemoryViewer();
    $('#continuity_preview').text(runtime.lastInjection || runtime.injectionStatus || 'Checking memory injection…');
    $('#continuity_raw').text(runtime.lastRawResponse || 'No extraction yet.');
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
        retrievalAssist: runtime.retrievalAssist || { mode: settings.retrievalMode },
        embeddingIndex: runtime.embeddingIndex || null,
        chatMemory: runtime.world?.name || null,
        memoryRevision: runtime.world?.revision ?? null,
        currentChatLastProcessed: runtime.world?.sources?.[getChatKey()]?.lastProcessedIndex ?? null,
        processingCoverage: {
            processed: coverage.processed,
            pending: coverage.pending,
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
    $('#continuity_diagnostics').text(JSON.stringify(diagnostic, null, 2));
}

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
    const response = await api.importWorld(alignment.world);
    bindCurrentChat(response.world.id);
    updateRuntime({ world: response.world });
    await embedWorldInChat(response.world);
    if (previousWorldId && previousWorldId !== response.world.id) {
        try { await purgeEmbeddingIndex(previousWorldId); }
        catch (error) { console.warn('[Continuity] Could not remove the replaced memory’s derived embedding index.', error); }
        await api.deleteWorld(previousWorldId);
        markWorldDeleted(previousWorldId);
    }
    await refreshWorlds();
    toast('success', `Imported “${response.world.name}”. ${alignment.message}`);
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

async function deleteScope() {
    const world = runtime.world;
    if (!world) throw new Error('Open a chat and prepare its memory first.');
    if (runtime.processing) throw new Error('Stop processing before deleting memory.');
    if (!window.confirm(`Permanently delete all memory in “${world.name}”? This removes every L1/L2/L3 record, its stored world, and its embedded chat-file copy. This cannot be undone unless you exported the memory.`)) return;
    try { await purgeEmbeddingIndex(world.id); }
    catch (error) { console.warn('[Continuity] Could not remove the deleted memory’s derived embedding index.', error); }
    await api.deleteWorld(world.id);
    markWorldDeleted(world.id);
    await clearPortableSnapshot();
    updateRuntime({ world: null, lastInjection: '', lastInjectionTokens: 0 });
    await refreshWorlds();
    toast('success', 'All memory deleted without saving a copy. A new empty memory is ready.');
}

async function continueFailedL1() {
    if (runtime.processing) throw new Error('Wait for current processing to finish.');
    const coverage = getProcessingCoverage();
    if (!coverage.pending) return { continued: 0, pendingMessages: 0 };
    const groupSize = resolveL1GroupSize(getSettings().extractionBatchMessages);
    const eligible = completeL1MessageCount(coverage.pending, groupSize);
    const pendingTail = coverage.pending - eligible;
    if (!eligible) return { continued: 0, pendingMessages: 0, pendingTail };
    if (eligible > 50 && !window.confirm(`Continue ${eligible} eligible L1 messages? This may make several extraction requests.`)) return { cancelled: true, continued: 0 };
    if (!getSettings().enabled) throw new Error('Continuity is disabled. Enable it before building memory.');
    // Build Memory is an explicit request to process pending work, so it also
    // serves as Resume after Stop, Pause, or an automatic rate-limit pause.
    if (runtime.paused) resumeRuntime();
    const result = await maybeAutoExtract(true);
    if (!result) throw new Error('No pending L1 messages could be started. Open a populated chat and refresh Continuity.');
    return { continued: result.chunks || 1, pendingMessages: result.messages || 0, pendingTail };
}

async function finishHierarchy(l1, clearRetrieval = false, rebuildVectors = false) {
    let arcs = 0;
    let eras = 0;
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
        updateRuntime({ status: 'idle', retryStatus: `Build complete: L1 ${l1.continued || l1.chunks || 0}, L2 ${arcs}, L3 ${eras}${l1.pendingTail ? `; ${l1.pendingTail} recent message(s) remain raw` : ''}${clearRetrieval ? `, retrieval cache ${cacheEntries} cleared` : ''}${rebuildVectors ? `, vectors ${vectors?.total || 0}` : ''}.` });
        return { ...l1, arcs, eras, cacheEntries, vectors };
    } catch (error) {
        updateRuntime({ status: 'error', retryStatus: `Build stopped safely: ${error.message}` });
        throw error;
    } finally {
        updateRuntime({ processing: false });
        if (!runtime.paused) continueQueue();
    }
}

async function buildMemory() {
    await ensureCurrentChatMemory(true);
    const l1 = await continueFailedL1();
    if (l1.cancelled) return l1;
    return finishHierarchy(l1, false);
}

async function repairRollback() {
    const rollback = getTailRollbackStatus();
    if (!rollback.detected) return { cancelled: true };
    if (!window.confirm(`Repair memory after removing ${rollback.removedMessages} tail message(s)? Unaffected L1 extraction results will be replayed locally; only a partially cut range may call the model.`)) return { cancelled: true };
    const repaired = await repairTailRollback();
    return finishHierarchy({ continued: repaired.reextracted, ...repaired }, true);
}

async function restartBuild() {
    await ensureCurrentChatMemory(true);
    const messageCount = getContext().chat?.length || 0;
    if (!window.confirm(`Start over from a brand-new empty memory for all ${messageCount} chat messages? This immediately and permanently erases all current structured memory, L1/L2/L3, extraction records, retrieval cache, and vectors. Every fresh L1 chunk calls the model and is saved as it completes, so Build can resume missing ranges after a failure. No backup is saved.`)) return { cancelled: true };
    stopEmbeddingIndexing();
    clearRetrievalExpansionCache();
    try { await purgeEmbeddingIndex(runtime.world?.id); }
    catch (error) { console.warn('[Continuity] Could not purge the old derived embedding index before Start Over.', error); }
    const l1 = await restartL1FromScratch();
    return finishHierarchy(l1, true, true);
}

async function rebuildHierarchy() {
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
    setSetting('#continuity_budget', 'injectionBudgetTokens', value => Math.min(12000, Math.max(0, Number(value) || 0)));
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
    $('#continuity_pause').on('click', () => {
        if (runtime.paused) { resumeRuntime(); continueQueue(); }
        else pauseRuntime();
        renderRuntime();
    });
    $('#continuity_stop').on('click', () => { stopRuntime(); toast('info', 'Processing stopped and the queue was cleared.'); });
    $('#continuity_build').on('click', () => buildMemory()
        .then(result => !result.cancelled && toast(result.continued || result.arcs || result.eras ? 'success' : 'info', result.continued || result.arcs || result.eras ? 'Memory build completed.' : 'Memory is already up to date.'))
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
    $('#continuity_clean_chat').on('change', function () { const file = this.files?.[0]; if (file) cleanChatExport(file).then(count => toast('success', `Downloaded a clean chat copy with ${count} embedded Continuity block(s) removed.`)).catch(error => toast('error', error.message)); this.value = ''; });
    $('#continuity_viewer_category').on('change', function () { viewerCategory = String($(this).val() || 'l1'); viewerPage = 0; renderMemoryViewer(true); });
    $('#continuity_viewer_search').on('input', function () { viewerSearch = String($(this).val() || ''); viewerPage = 0; renderMemoryViewer(true); });
    $('#continuity_viewer_previous').on('click', () => { viewerPage = Math.max(0, viewerPage - 1); renderMemoryViewer(true); });
    $('#continuity_viewer_next').on('click', () => { viewerPage++; renderMemoryViewer(true); });
    $('#continuity_delete').on('click', () => deleteScope().catch(error => toast('error', error.message)));

    onRuntimeChange(renderRuntime);
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
    const coverage = getProcessingCoverage(runtime.world);
    return buildMemoryPrompt(runtime.world, recent, budget.tokens, getChatKey(), [], settings.injectionInstruction, new Map(), { includeSceneCheckpoint: coverage.pending === 0 });
}
