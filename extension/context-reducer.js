import { getTokenCountAsync } from '/scripts/tokenizers.js';
import { getContext } from '/scripts/st-context.js';
import { EXTRACTION_VERSION } from './coverage.js';
import { promptManager } from '/scripts/openai.js';
import { loadBoundWorld } from './engine.js?v=0.14.0-standalone.279';
import { fingerprintMessage } from './message-digest.js?v=0.14.0-standalone.258';
import { runtime, updateRuntime } from './runtime.js?v=0.14.0-standalone.258';
import { getBoundWorldId, getChatKey, getSettings } from './settings.js?v=0.14.0-standalone.258';
import { tailPolicy } from './tail-policy.js';
import { canReduceContext } from './reduction-policy.js';
import { mapContextMessages } from './context-message-map.js';

const tokenCache = new Map();
const fixedPromptTokensByChat = new Map();
let pendingTextMeasurement = null;

function messageRange(messages) {
    const indexes = (messages || []).map(message => Number(message?.index)).filter(Number.isFinite);
    return indexes.length ? { from: Math.min(...indexes), to: Math.max(...indexes) } : null;
}

async function countMessage(identity) {
    const fingerprint = fingerprintMessage(identity);
    if (tokenCache.has(fingerprint)) return tokenCache.get(fingerprint);
    const count = Math.max(1, Number(await getTokenCountAsync(`${identity.name}: ${identity.text}`, 0)) || 1);
    tokenCache.set(fingerprint, count);
    if (tokenCache.size > 5000) tokenCache.delete(tokenCache.keys().next().value);
    return count;
}

export async function reduceChatContext(coreChat, contextSize, _abort, type) {
    const settings = getSettings();
    if (!canReduceContext(settings, coreChat, type)) {
        return { rawTailRange: messageRange(coreChat) };
    }

    try {
        const worldId = getBoundWorldId();
        const chatKey = getChatKey();
        if (!worldId || !chatKey) return { rawTailRange: messageRange(coreChat) };
        let world = runtime.world?.id === worldId ? runtime.world : await loadBoundWorld();
        const processed = new Map((world?.sources?.[chatKey]?.processedMessages || [])
            .filter(item => Number(item.version) === EXTRACTION_VERSION)
            .map(item => [Number(item.index), item.fingerprint]));
        if (!processed.size) {
            updateRuntime({ contextReduction: { mode: 'waiting-for-extraction', hiddenMessages: 0, hiddenTokens: 0, tailMessages: coreChat.length, tailTurns: Math.ceil(coreChat.length / 2), tailTokens: 0 } });
            return { rawTailRange: messageRange(coreChat) };
        }

        const mapped = mapContextMessages(coreChat, getContext().chat || []);
        const mappedByPosition = new Map(mapped.map(item => [item.position, item]));
        const comparable = mapped.filter(item => item.promptIdentity?.text);
        const counts = await Promise.all(comparable.map(item => countMessage(item.promptIdentity)));
        const countByPosition = new Map(comparable.map((item, index) => [item.position, counts[index]]));
        const size = Number(contextSize) || Number(getContext().maxContext) || 50000;
        const budgetInfo = tailPolicy(settings, size, fixedPromptTokensByChat.get(chatKey));
        const budget = budgetInfo.budget;
        const tailPositions = new Set();
        let tailTokens = 0;
        let tailMessages = 0;
        for (let cursor = comparable.length - 1; cursor >= 0; cursor--) {
            const item = comparable[cursor];
            const count = Math.max(1, Number(counts[cursor]) || 1);
            if (tailMessages >= budgetInfo.maxMessages) break;
            if (tailMessages >= budgetInfo.minimumMessages && tailTokens + count > budget) break;
            tailPositions.add(item.position);
            tailTokens += count;
            tailMessages++;
        }

        const kept = [];
        let hiddenMessages = 0;
        let hiddenTokens = 0;
        for (let position = 0; position < coreChat.length; position++) {
            const message = coreChat[position];
            const mappedMessage = mappedByPosition.get(position);
            const promptIdentity = mappedMessage?.promptIdentity;
            const sourceIdentity = mappedMessage?.sourceIdentity;
            if (!promptIdentity || !sourceIdentity || tailPositions.has(position)) {
                kept.push(message);
                continue;
            }
            const fingerprint = fingerprintMessage(sourceIdentity);
            if (processed.get(sourceIdentity.index) !== fingerprint) {
                kept.push(message);
                continue;
            }
            hiddenTokens += Math.max(1, Number(countByPosition.get(position)) || 1);
            hiddenMessages++;
        }

        coreChat.splice(0, coreChat.length, ...kept);
        pendingTextMeasurement = {
            chatKey,
            conversationTokens: Math.max(0, counts.reduce((sum, count) => sum + count, 0) - hiddenTokens),
        };
        updateRuntime({ contextReduction: {
            mode: budgetInfo.measured ? 'active-measured' : 'active-learning',
            hiddenMessages,
            hiddenTokens,
            tailMessages,
            tailTurns: Math.ceil(tailMessages / 2),
            tailTokens,
            tailBudget: budget,
            fixedPromptTokens: budgetInfo.fixedPromptTokens,
            safetyTokens: budgetInfo.safetyTokens,
        } });
        const rawTailIndexes = comparable
            .filter(item => tailPositions.has(item.position))
            .map(item => item.sourceIdentity?.index)
            .filter(Number.isFinite);
        return { rawTailRange: rawTailIndexes.length ? { from: Math.min(...rawTailIndexes), to: Math.max(...rawTailIndexes) } : null };
    } catch (error) {
        console.error('[Continuity] Context reduction failed; sending original chat.', error);
        updateRuntime({
            contextReduction: { mode: 'failed-open', hiddenMessages: 0, hiddenTokens: 0, tailMessages: coreChat.length, tailTurns: Math.ceil(coreChat.length / 2), tailTokens: 0 },
            lastError: `Context reduction failed safely: ${error.message}`,
        });
        return { rawTailRange: messageRange(coreChat) };
    }
}

export function captureChatCompletionOverhead() {
    const chatKey = getChatKey();
    if (!chatKey) return;
    const counts = promptManager?.tokenHandler?.counts;
    if (!counts || typeof counts !== 'object') return;
    const total = Object.values(counts).map(Number).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
    const conversation = Math.max(0, Number(counts.chatHistory ?? counts.conversation) || 0);
    if (!total || total < conversation) return;
    const fixedPromptTokens = Math.max(0, Math.round(total - conversation));
    fixedPromptTokensByChat.set(chatKey, fixedPromptTokens);
    updateRuntime({ contextReduction: { ...runtime.contextReduction, fixedPromptTokens, totalPromptTokens: Math.round(total) } });
}

export async function captureTextCompletionOverhead(eventData) {
    if (!pendingTextMeasurement || eventData?.dryRun || typeof eventData?.prompt !== 'string') return;
    const currentKey = getChatKey();
    if (!currentKey || currentKey !== pendingTextMeasurement.chatKey) return;
    const total = await getTokenCountAsync(eventData.prompt, 0);
    const fixedPromptTokens = Math.max(0, Math.round(total - pendingTextMeasurement.conversationTokens));
    fixedPromptTokensByChat.set(currentKey, fixedPromptTokens);
    pendingTextMeasurement = null;
    updateRuntime({ contextReduction: { ...runtime.contextReduction, fixedPromptTokens, totalPromptTokens: Math.round(total) } });
}
