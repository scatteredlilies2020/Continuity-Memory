import { fingerprintMessage } from './message-digest.js?v=0.15.0-testing.30';
import { recentRetrievalQuery } from './retrieval-query.js?v=0.15.0-testing.30';

function querySignature(recentMessages) {
    const roles = recentMessages.map(message => message.is_user ? 'user' : 'assistant').join(',');
    return fingerprintMessage({ index: 0, name: 'recall-query', text: `${roles}\n${recentRetrievalQuery(recentMessages, 50)}` });
}

export function latestAvailableWorld(worldId, ...worlds) {
    if (!worldId) return null;
    return worlds.filter(world => world?.id === worldId)
        .reduce((latest, world) => !latest || Number(world.revision || 0) > Number(latest.revision || 0) ? world : latest, null);
}

// Prepared recall requires the same current query, unchanged sources, chat,
// memory revision, placement, and recall configuration.
export function injectionScope(settings, contextSize) {
    const keys = [
        'injectionBudgetTokens', 'injectionInstruction', 'injectionPosition', 'injectionDepth', 'injectionRole',
        'storySoFarEnabled', 'retrievalMode', 'retrievalQueryMessages', 'embeddingProvider',
        'embeddingProxyUrl', 'embeddingProxyModel', 'embeddingOpenRouterModel', 'embeddingTopK', 'embeddingThreshold',
    ];
    return JSON.stringify([contextSize, ...keys.map(key => settings[key])]);
}

export function prepareInjectionSnapshot({ chatKey, world, scope, sourceMessages, recentMessages = [], snapshot, bridgeMetadata = null, retrievalKey = null }) {
    return {
        chatKey, worldId: world.id, revision: world.revision, scope, snapshot, bridgeMetadata, retrievalKey,
        query: querySignature(recentMessages),
        sources: sourceMessages.map(message => ({ index: message.index, fingerprint: fingerprintMessage(message) })),
    };
}

export function readyInjectionSnapshot(prepared, { chatKey, world, scope, sourceMessages, recentMessages = [] }) {
    if (!prepared || !world || prepared.chatKey !== chatKey || prepared.worldId !== world.id
        || prepared.revision !== world.revision || prepared.scope !== scope
        || prepared.query !== querySignature(recentMessages)) return null;
    const current = new Map(sourceMessages.map(message => [message.index, message]));
    for (const source of prepared.sources) {
        const message = current.get(source.index);
        if (!message || fingerprintMessage(message) !== source.fingerprint) return null;
    }
    return prepared.snapshot;
}
