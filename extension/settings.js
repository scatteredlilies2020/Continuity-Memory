import { saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { getContext } from '/scripts/st-context.js';
import { CANONICAL_EPISTEMIC_MEMORY_RULES, CANONICAL_RECORD_RULES, CONTINUITY_COVERAGE_RULES, DURABLE_MEMORY_RULES, EPISTEMIC_MEMORY_RULES, HIERARCHY_ATTRIBUTION_RULE, IDENTITY_RESOLUTION_RULES, LEGACY_EPISTEMIC_MEMORY_RULES, LEGACY_HIERARCHY_ATTRIBUTION_RULE, PRE_KNOWLEDGE_GAP_EPISTEMIC_MEMORY_RULES, PRE_KNOWLEDGE_GAP_HIERARCHY_ATTRIBUTION_RULE, PRE_KNOWLEDGE_GAP_INJECTION_INSTRUCTION, PROMPT_DEFAULTS, RELATIONAL_ADDRESS_RULE, TARGET_ID_SAFETY_RULE } from './prompts.js?v=0.14.0-standalone.110';
import { DEFAULT_L1_GROUP_SIZE } from './l1-policy.js';
import { DEFAULT_CORRECTION_RESPONSE_TOKENS } from './correction-policy.js';
import { applyReviewBeforeCommitDefault, DEFAULT_REVIEW_BEFORE_COMMIT } from './review-policy.js?v=0.14.0-standalone.110';

export const EXTENSION_NAME = 'continuityMemory';

const DEFAULTS = Object.freeze({
    enabled: true,
    showNotifications: true,
    retrievalMode: 'ai-expanded',
    retrievalQueryMessages: 6,
    embeddingQueryMessages: 4,
    embeddingTopK: 100,
    embeddingThreshold: 0.2,
    embeddingProvider: 'proxy',
    embeddingProxyUrl: '',
    embeddingProxyModel: 'text-embedding-3-small',
    embeddingOpenRouterUrl: '',
    embeddingOpenRouterModel: 'openai/text-embedding-3-large',
    embeddingAutoSync: true,
    autoExtract: true,
    reviewBeforeCommit: DEFAULT_REVIEW_BEFORE_COMMIT,
    reviewEditorFontSize: 14,
    jbEnabled: false,
    embedMemoryInChat: true,
    detail: 'balanced',
    injectionBudgetTokens: 0,
    injectionPosition: 'before-chat-history',
    injectionDepth: 4,
    injectionRole: 'user',
    extractionBatchMessages: DEFAULT_L1_GROUP_SIZE,
    extractionChunkTokens: 0,
    correctionResponseTokens: DEFAULT_CORRECTION_RESPONSE_TOKENS,
    memoryProfileId: '',
    retrievalProfileId: '',
    arcProfileId: '',
    extractionDirectUrl: '',
    extractionDirectModel: '',
    extractionDirectSecretId: '',
    extractionDirectProvider: 'custom',
    extractionOpenRouterUrl: '',
    extractionOpenRouterModel: 'openai/gpt-4.1-mini',
    summaryDirectUrl: '',
    summaryDirectModel: '',
    summaryDirectSecretId: '',
    summaryDirectProvider: 'custom',
    summaryOpenRouterUrl: '',
    summaryOpenRouterModel: 'openai/gpt-4.1-mini',
    hierarchyMode: 'l3',
    arcGroupSize: 24,
    eraStartArcs: 12,
    eraGroupSize: 6,
    thinkingMode: 'off',
    contextReductionEnabled: true,
    rawTailMode: 'tokens',
    rawTailValue: 0,
    ...PROMPT_DEFAULTS,
    chatWorlds: {},
    deletedWorldIds: [],
});

const TOKEN_EFFICIENT_LEGACY_DEFAULTS = Object.freeze({
    extractionSystemPrompt: '39312ecc',
    extractionTaskTemplate: '0873e1f3',
    retrievalSystemPrompt: 'b78f11b4',
    injectionInstruction: 'fb79e92a',
    arcSystemPrompt: '054e60fd',
    arcTaskTemplate: 'c8c25343',
    eraSystemPrompt: '3e6d1634',
    eraTaskTemplate: '83dc1d5a',
});

function promptFingerprint(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value || '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) extension_settings[EXTENSION_NAME] = {};
    const settings = extension_settings[EXTENSION_NAME];
    if (settings.injectionPosition === 'in-chat') {
        settings.injectionPosition = 'at-depth';
        saveSettingsDebounced();
    }
    if (settings.injectionPosition === 'before-scenario') {
        settings.injectionPosition = 'before-main';
        saveSettingsDebounced();
    }
    if (settings.injectionPosition === 'after-scenario') {
        settings.injectionPosition = 'after-main';
        saveSettingsDebounced();
    }
    if ('injectionEnabled' in settings) {
        delete settings.injectionEnabled;
        saveSettingsDebounced();
    }
    if ('extractionEnabled' in settings) {
        delete settings.extractionEnabled;
        saveSettingsDebounced();
    }
    if (Number(settings.embeddingAutoSyncDefaultVersion || 0) < 1) {
        settings.embeddingAutoSync = true;
        settings.embeddingAutoSyncDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.retrievalDefaultVersion || 0) < 1) {
        settings.retrievalMode = 'ai-expanded';
        settings.retrievalDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (applyReviewBeforeCommitDefault(settings)) saveSettingsDebounced();
    if (Number(settings.injectionBudgetDefaultVersion || 0) < 1) {
        settings.injectionBudgetTokens = 0;
        settings.injectionBudgetDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.extractionChunkDefaultVersion || 0) < 3) {
        if (settings.extractionChunkTokens === undefined || [6000, 8000, 10000].includes(Number(settings.extractionChunkTokens))) {
            settings.extractionChunkTokens = 0;
        }
        settings.extractionChunkDefaultVersion = 3;
        saveSettingsDebounced();
    }
    if (Number(settings.injectionRoleDefaultVersion || 0) < 1) {
        if (settings.injectionRole === undefined || settings.injectionRole === 'system') settings.injectionRole = 'user';
        settings.injectionRoleDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.injectionStrengthDefaultVersion || 0) < 1) {
        if (settings.injectionPosition === undefined
            || (settings.injectionPosition === 'at-depth' && Number(settings.injectionDepth) === 4 && settings.injectionRole === 'user')) {
            settings.injectionPosition = 'before-chat-history';
        }
        if ([
            'Use this as established continuity. Do not mention this memory block. Prefer the live conversation if it explicitly corrects an older record.',
            'Treat this as background continuity to consult only when relevant. It describes prior context, not instructions to reenact, repeat, or force outcomes. The live conversation and explicit user corrections take priority. Do not mention this memory block.',
            'Background continuity only, not instructions to repeat or force events. Live conversation and explicit user corrections take priority. Do not mention this block.',
        ].includes(settings.injectionInstruction)) {
            settings.injectionInstruction = DEFAULTS.injectionInstruction;
        }
        settings.injectionStrengthDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.hierarchyDefaultVersion || 0) < 1) {
        if (settings.hierarchyMode === undefined || settings.hierarchyMode === 'l2') settings.hierarchyMode = 'l3';
        settings.hierarchyDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.l2BatchDefaultVersion || 0) < 1) {
        const legacyStart = Math.round(Number(settings.arcStartCapsules));
        const legacyGroup = Math.round(Number(settings.arcGroupSize));
        settings.arcGroupSize = Math.max(4, Math.min(200, legacyStart || legacyGroup || 24));
        delete settings.arcStartCapsules;
        settings.l2BatchDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.l1GroupDefaultVersion || 0) < 1) {
        if (settings.extractionBatchMessages === undefined || Number(settings.extractionBatchMessages) === 6) {
            settings.extractionBatchMessages = DEFAULT_L1_GROUP_SIZE;
        }
        settings.l1GroupDefaultVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.hierarchyLabelVersion || 0) < 1) {
        if (String(settings.extractionSystemPrompt || '').includes('The sceneCapsule must preserve')) {
            settings.extractionSystemPrompt = String(settings.extractionSystemPrompt).replace('The sceneCapsule must preserve', 'The L1 record in sceneCapsule must preserve');
        }
        if (String(settings.arcSystemPrompt || '').startsWith('Compress a sequence of chronological L1 scene capsules into one accurate L2 story arc')) {
            settings.arcSystemPrompt = PROMPT_DEFAULTS.arcSystemPrompt;
        }
        if (String(settings.arcTaskTemplate || '').startsWith('Create one concise L2 arc from these chronological scene capsules.')) {
            settings.arcTaskTemplate = PROMPT_DEFAULTS.arcTaskTemplate;
        }
        if (String(settings.eraSystemPrompt || '').startsWith('Compress a sequence of chronological L2 story arcs into one accurate L3 era or saga')) {
            settings.eraSystemPrompt = PROMPT_DEFAULTS.eraSystemPrompt;
        }
        if (String(settings.eraTaskTemplate || '').startsWith('Create one concise L3 era from these chronological L2 story arcs.')) {
            settings.eraTaskTemplate = PROMPT_DEFAULTS.eraTaskTemplate;
        }
        settings.hierarchyLabelVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.scenarioNeutralPromptVersion || 0) < 2) {
        const extractionPrompt = String(settings.extractionSystemPrompt || '');
        const legacyExtraction = extractionPrompt.startsWith('You maintain long-term continuity for an open-ended roleplay sandbox.')
            && extractionPrompt.includes('Importance is 1 (minor) through 5 (foundational).');
        const genreBiasedExtraction = extractionPrompt.startsWith('You maintain long-term continuity for an open-ended roleplay or simulation sandbox.')
            && extractionPrompt.includes('countries, governments, factions, organizations, military units');
        if (legacyExtraction || genreBiasedExtraction) {
            settings.extractionSystemPrompt = PROMPT_DEFAULTS.extractionSystemPrompt;
        }
        const retrievalPrompt = String(settings.retrievalSystemPrompt || '');
        if (retrievalPrompt.startsWith('Expand a roleplay memory-search query.')) {
            settings.retrievalSystemPrompt = PROMPT_DEFAULTS.retrievalSystemPrompt;
        }
        const arcPrompt = String(settings.arcSystemPrompt || '');
        if (arcPrompt.startsWith('Compress a sequence of chronological L1 records into one accurate L2 record for long-term roleplay continuity.')
            || arcPrompt.includes('personal, political, diplomatic, military, or strategic movement')) {
            settings.arcSystemPrompt = PROMPT_DEFAULTS.arcSystemPrompt;
        }
        const eraPrompt = String(settings.eraSystemPrompt || '');
        if (eraPrompt.startsWith('Compress a sequence of chronological L2 records into one accurate L3 record for very long roleplay continuity.')
            || eraPrompt.includes('lasting personal, political, diplomatic, military, or strategic changes')) {
            settings.eraSystemPrompt = PROMPT_DEFAULTS.eraSystemPrompt;
        }
        settings.scenarioNeutralPromptVersion = 2;
        saveSettingsDebounced();
    }
    if (Number(settings.promptPunctuationVersion || 0) < 1) {
        if (typeof settings.extractionSystemPrompt === 'string') {
            settings.extractionSystemPrompt = settings.extractionSystemPrompt.replace(
                'Track whatever can carry continuity in this scenario—identity,',
                'Track whatever can carry continuity in this scenario, including identity,',
            );
        }
        settings.promptPunctuationVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.durableMemoryPromptVersion || 0) < 1) {
        const prompt = String(settings.extractionSystemPrompt || '');
        const startMarker = 'Use state for replaceable values or conditions';
        const endMarker = 'Avoid duplicating the same idea in many fields.';
        const start = prompt.indexOf(startMarker);
        const end = prompt.indexOf(endMarker, start);
        if (start >= 0 && end >= start && !prompt.includes('Entity descriptions are durable, tense-neutral identity summaries')) {
            settings.extractionSystemPrompt = `${prompt.slice(0, start)}${DURABLE_MEMORY_RULES}${prompt.slice(end + endMarker.length)}`;
        }
        settings.durableMemoryPromptVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.identityResolutionPromptVersion || 0) < 1) {
        const prompt = String(settings.extractionSystemPrompt || '');
        const marker = 'Entity descriptions are durable, tense-neutral identity summaries, not snapshots.';
        if (prompt.includes(marker) && !prompt.includes('Use identityResolutions only when')) {
            settings.extractionSystemPrompt = prompt.replace(marker, `${marker}\n${IDENTITY_RESOLUTION_RULES}`);
        }
        settings.identityResolutionPromptVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.canonicalRecordPromptVersion || 0) < 1) {
        const prompt = String(settings.extractionSystemPrompt || '');
        const marker = 'Use identityResolutions only when the supplied narrative establishes';
        if (prompt.includes(marker) && !prompt.includes('Canonical memory context contains relevant existing mutable records')) {
            const ruleEnd = 'Leave identityResolutions empty when the excerpt establishes no identity.';
            settings.extractionSystemPrompt = prompt.includes(ruleEnd)
                ? prompt.replace(ruleEnd, `${ruleEnd}\n${CANONICAL_RECORD_RULES}`)
                : `${prompt}\n${CANONICAL_RECORD_RULES}`;
        }
        settings.canonicalRecordPromptVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.targetIdSafetyPromptVersion || 0) < 2) {
        const legacyRule = 'For facts using targetId, preserve the canonical predicate and category. A different predicate and category requires a new fact with empty targetId.';
        let prompt = String(settings.extractionSystemPrompt || '');
        if (prompt.includes(legacyRule)) prompt = prompt.replaceAll(legacyRule, TARGET_ID_SAFETY_RULE);
        if (prompt && !prompt.includes(TARGET_ID_SAFETY_RULE)) {
            const marker = 'Omit an existing record when the excerpt only repeats it unchanged.';
            prompt = prompt.includes(marker)
                ? prompt.replace(marker, `${TARGET_ID_SAFETY_RULE} ${marker}`)
                : `${prompt}\n${TARGET_ID_SAFETY_RULE}`;
        }
        settings.extractionSystemPrompt = prompt || PROMPT_DEFAULTS.extractionSystemPrompt;
        settings.targetIdSafetyPromptVersion = 2;
        saveSettingsDebounced();
    }
    if (Number(settings.continuityCoveragePromptVersion || 0) < 1) {
        let prompt = String(settings.extractionSystemPrompt || '');
        if (prompt.includes('use at most 6 one-sentence beats')) {
            prompt = prompt.replace('use at most 6 one-sentence beats', 'use at most 10 one-sentence beats');
        }
        if (prompt && !prompt.includes('Coverage and retrieval are separate concerns.')) {
            const marker = 'Assign importance by likely future continuity value';
            prompt = prompt.includes(marker)
                ? prompt.replace(marker, `${CONTINUITY_COVERAGE_RULES}\n${marker}`)
                : `${prompt}\n${CONTINUITY_COVERAGE_RULES}`;
        }
        settings.extractionSystemPrompt = prompt || PROMPT_DEFAULTS.extractionSystemPrompt;
        settings.continuityCoveragePromptVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.compactBackgroundPromptVersion || 0) < 1) {
        let prompt = String(settings.extractionSystemPrompt || PROMPT_DEFAULTS.extractionSystemPrompt);
        if (!prompt.includes('output exactly one compact backgrounds record')) {
            const startMarker = 'Coverage and retrieval are separate concerns.';
            const endMarker = 'Assign importance by likely future continuity value';
            const start = prompt.indexOf(startMarker);
            const end = prompt.indexOf(endMarker, Math.max(0, start));
            prompt = start >= 0 && end > start
                ? `${prompt.slice(0, start)}${CONTINUITY_COVERAGE_RULES}\n${prompt.slice(end)}`
                : prompt.includes(endMarker)
                    ? prompt.replace(endMarker, `${CONTINUITY_COVERAGE_RULES}\n${endMarker}`)
                    : `${prompt}\n${CONTINUITY_COVERAGE_RULES}`;
        }
        settings.extractionSystemPrompt = prompt;
        settings.compactBackgroundPromptVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.tokenEfficientPromptVersion || 0) < 1) {
        for (const [key, legacyFingerprint] of Object.entries(TOKEN_EFFICIENT_LEGACY_DEFAULTS)) {
            if (promptFingerprint(settings[key]) === legacyFingerprint) settings[key] = PROMPT_DEFAULTS[key];
        }
        settings.tokenEfficientPromptVersion = 1;
        saveSettingsDebounced();
    }
    if (Number(settings.relationalAddressPromptVersion || 0) < 8) {
        let prompt = String(settings.extractionSystemPrompt || PROMPT_DEFAULTS.extractionSystemPrompt);
        if (!prompt.includes(RELATIONAL_ADDRESS_RULE)) {
            const previousRules = [
                'Store honorifics, titles, nicknames, callsigns, or first-name use as one fact per speaker-addressee pair. A form must be a direct, name-like vocative—not a sentence, clause, description, or nearby dialogue fragment. Ordinary "you" requires explicit social meaning (disrespect or name refusal). Require exact wording; omit absence, silence, indirect replies, and claims that no address is established. One meaningful shift is enough. Attribute quoted lines to explicit speakers; a message author is not automatically the speaker of every line it narrates. Self-directed facts require explicit self-use of the form; never infer self-address from another speaker. Subject: canonical speaker; predicate: "calls ACTUAL_CANONICAL_NAME." Never output placeholder text or brackets. Value: list all exact current forms and meaningful former forms only; keep coexisting forms together. Update relationships only if a shift signals changed familiarity, distance, respect, or hierarchy. Ignore one-offs.',
                'Store honorifics, titles, nicknames, callsigns, or first-name use as one fact per speaker-addressee pair. A form must be explicit as an address or used as a direct vocative, never merely descriptive ("a/the X" or "is an X"). Ordinary "you" requires explicit social meaning (disrespect or name refusal). Require exact wording; omit absence, silence, indirect replies, and claims that no address is established. One meaningful shift is enough. Attribute quoted lines to explicit speakers; a message author is not automatically the speaker of every line it narrates. Self-directed facts require explicit self-use of the form; never infer self-address from another speaker. Subject: canonical speaker; predicate: "calls ACTUAL_CANONICAL_NAME." Never output placeholder text or brackets. Value: list all exact current forms and meaningful former forms only; keep coexisting forms together. Update relationships only if a shift signals changed familiarity, distance, respect, or hierarchy. Ignore one-offs.',
                'Store socially meaningful address wording (honorifics, titles, nicknames, callsigns, or first-name use) as one fact per speaker-addressee pair. Require exact wording used or explicitly established; omit absence, silence, indirect replies, and claims that no address is established. One meaningful shift is enough. Subject: canonical speaker. Predicate: "calls ACTUAL_CANONICAL_NAME." Never output placeholder text or brackets. Value: list all exact current forms and meaningful former forms only; keep coexisting forms together, without commentary. Update relationships only if a shift signals changed familiarity, distance, respect, or hierarchy. Ignore ordinary one-offs.',
                'Store socially meaningful address wording (honorifics, titles, nicknames, callsigns, or first-name use) as one fact per speaker-addressee pair. Require exact wording used or explicitly established; omit absence, silence, indirect replies, and claims that no address is established. One meaningful shift is enough. Subject: canonical speaker. Predicate: "calls [canonical addressee]." Value: list all exact current forms and meaningful former forms only; keep coexisting forms together, without commentary. Update relationships only if a shift signals changed familiarity, distance, respect, or hierarchy. Ignore ordinary one-offs.',
                'Store socially meaningful address wording (honorifics, titles, nicknames, callsigns, or first-name use) as one fact per speaker-addressee pair. Require exact wording used or explicitly established; omit absence, silence, indirect replies, and claims that no address is established. One meaningful shift is enough. Subject: canonical speaker. Predicate: "calls [canonical addressee]." Value: exact current and meaningful former forms only, without commentary. Update relationships only if a shift signals changed familiarity, distance, respect, or hierarchy. Ignore ordinary one-offs.',
                'Store distinctive forms of address, including honorifics, titles, nicknames, and first-name use, in the speaker-to-addressee relationship when repeated, explicitly noticed, or socially meaningful. Preserve exact forms and meaningful shifts as familiarity or distance changes; ignore ordinary one-off usage.',
                'Preserve recurring forms of address, including culturally meaningful honorifics, titles, and nicknames, in the relationship dynamic when they subtly signal familiarity, respect, hierarchy, distance, or change; ignore incidental usage.',
            ];
            const previousRule = previousRules.find(rule => prompt.includes(rule));
            const marker = 'Relationships hold meaningful connections or dependencies.';
            prompt = previousRule
                ? prompt.replace(previousRule, RELATIONAL_ADDRESS_RULE)
                : prompt.includes(marker)
                ? prompt.replace(marker, `${marker} ${RELATIONAL_ADDRESS_RULE}`)
                : `${prompt}\n${RELATIONAL_ADDRESS_RULE}`;
        }
        settings.extractionSystemPrompt = prompt;
        const previousInjection = 'Use this as relevant background continuity. Live conversation and explicit user corrections take priority. Do not mention this block.';
        if (settings.injectionInstruction === previousInjection) {
            settings.injectionInstruction = PROMPT_DEFAULTS.injectionInstruction;
        }
        settings.relationalAddressPromptVersion = 8;
        saveSettingsDebounced();
    }
    if (Number(settings.epistemicPromptVersion || 0) < 4) {
        let extractionPrompt = String(settings.extractionSystemPrompt || PROMPT_DEFAULTS.extractionSystemPrompt);
        if (extractionPrompt.includes(EPISTEMIC_MEMORY_RULES)) {
            // Already current, including on a new installation.
        } else if (extractionPrompt.includes(LEGACY_EPISTEMIC_MEMORY_RULES)) {
            extractionPrompt = extractionPrompt.replace(LEGACY_EPISTEMIC_MEMORY_RULES, EPISTEMIC_MEMORY_RULES);
        } else if (extractionPrompt.includes(CANONICAL_EPISTEMIC_MEMORY_RULES)) {
            extractionPrompt = extractionPrompt.replace(CANONICAL_EPISTEMIC_MEMORY_RULES, EPISTEMIC_MEMORY_RULES);
        } else if (extractionPrompt.includes(PRE_KNOWLEDGE_GAP_EPISTEMIC_MEMORY_RULES)) {
            extractionPrompt = extractionPrompt.replace(PRE_KNOWLEDGE_GAP_EPISTEMIC_MEMORY_RULES, EPISTEMIC_MEMORY_RULES);
        } else if (!extractionPrompt.includes(EPISTEMIC_MEMORY_RULES)) {
            extractionPrompt = `${extractionPrompt}\n${EPISTEMIC_MEMORY_RULES}`;
        }
        settings.extractionSystemPrompt = extractionPrompt;
        for (const key of ['arcSystemPrompt', 'eraSystemPrompt']) {
            let prompt = String(settings[key] || PROMPT_DEFAULTS[key]);
            if (prompt.includes(HIERARCHY_ATTRIBUTION_RULE)) {
                // Already current, including on a new installation.
            } else if (prompt.includes(LEGACY_HIERARCHY_ATTRIBUTION_RULE)) {
                prompt = prompt.replace(LEGACY_HIERARCHY_ATTRIBUTION_RULE, HIERARCHY_ATTRIBUTION_RULE);
            } else if (prompt.includes(PRE_KNOWLEDGE_GAP_HIERARCHY_ATTRIBUTION_RULE)) {
                prompt = prompt.replace(PRE_KNOWLEDGE_GAP_HIERARCHY_ATTRIBUTION_RULE, HIERARCHY_ATTRIBUTION_RULE);
            } else if (!prompt.includes(HIERARCHY_ATTRIBUTION_RULE)) {
                prompt = `${prompt}\n${HIERARCHY_ATTRIBUTION_RULE}`;
            }
            settings[key] = prompt;
        }
        if (settings.injectionInstruction === PRE_KNOWLEDGE_GAP_INJECTION_INSTRUCTION) {
            settings.injectionInstruction = PROMPT_DEFAULTS.injectionInstruction;
        }
        settings.epistemicPromptVersion = 4;
        saveSettingsDebounced();
    }
    if (settings.rawTailMode === undefined) {
        const oldTurns = Math.max(0, Number(settings.rawTailTurns) || 0);
        const oldTokens = Math.max(0, Number(settings.rawTailTokens) || 0);
        settings.rawTailMode = oldTurns > 0 && oldTokens === 0 ? 'turns' : 'tokens';
        settings.rawTailValue = settings.rawTailMode === 'turns' ? oldTurns : oldTokens;
        delete settings.rawTailTurns;
        delete settings.rawTailTokens;
    }
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (settings[key] === undefined) {
            settings[key] = value && typeof value === 'object' ? structuredClone(value) : value;
        }
    }
    return settings;
}

export function resetPromptSettings() {
    Object.assign(getSettings(), PROMPT_DEFAULTS);
    saveSettings();
}

export function resetConfigurationSettings() {
    const settings = getSettings();
    const chatWorlds = settings.chatWorlds;
    const deletedWorldIds = settings.deletedWorldIds;
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (key === 'chatWorlds' || key === 'deletedWorldIds') continue;
        settings[key] = value && typeof value === 'object' ? structuredClone(value) : value;
    }
    settings.chatWorlds = chatWorlds;
    settings.deletedWorldIds = deletedWorldIds;
    saveSettings();
}

export function saveSettings() {
    saveSettingsDebounced();
}

export function getChatKey() {
    const context = getContext();
    if (!context.chatId) return null;
    const owner = context.groupId ? `group:${context.groupId}` : `character:${context.characterId ?? 'unknown'}`;
    return `${owner}:chat:${context.chatId}`;
}

export function getBoundWorldId() {
    const key = getChatKey();
    return key ? getSettings().chatWorlds[key] || '' : '';
}

export function bindCurrentChat(worldId) {
    const key = getChatKey();
    if (!key) throw new Error('Open a chat before selecting a world.');
    if (worldId) getSettings().chatWorlds[key] = worldId;
    else delete getSettings().chatWorlds[key];
    saveSettings();
}

export function markWorldDeleted(worldId) {
    const settings = getSettings();
    for (const [chatKey, boundId] of Object.entries(settings.chatWorlds)) {
        if (boundId === worldId) delete settings.chatWorlds[chatKey];
    }
    settings.deletedWorldIds = [...new Set([...(settings.deletedWorldIds || []), worldId])].slice(-1000);
    saveSettings();
}
