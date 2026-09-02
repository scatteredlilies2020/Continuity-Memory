import { getContext } from '/scripts/st-context.js';
import { getSettings } from './settings.js?v=0.15.0-testing.9';
import { createPortableSnapshot, PORTABLE_SCHEMA_VERSION, portableSnapshotIsNewer, portableSnapshotMatches } from './portable-state.js?v=0.15.0-testing.9';
import { canSafelySaveChatMetadata } from './chat-metadata-save-guard.js';

const METADATA_KEY = 'continuityMemory';

export function getPortableSnapshot() {
    const snapshot = getContext().chatMetadata?.[METADATA_KEY];
    if (!snapshot || snapshot.schemaVersion !== PORTABLE_SCHEMA_VERSION || !snapshot.world?.id) return null;
    return snapshot;
}

async function saveChatMetadata(context) {
    const current = getContext();
    if (!canSafelySaveChatMetadata(context, current)) {
        console.warn('[Continuity] Skipped portable metadata save because the active chat was empty, loading, or had changed.');
        return false;
    }
    if (typeof current.saveMetadata === 'function') {
        await current.saveMetadata();
        return true;
    }
    console.warn('[Continuity] Portable metadata was not saved because this SillyTavern build has no immediate metadata-save API.');
    return false;
}

export async function embedWorldInChat(world, { force = false } = {}) {
    if (!getSettings().embedMemoryInChat) return false;
    const context = getContext();
    if (!context.chatId || !context.chatMetadata || !world?.id || !canSafelySaveChatMetadata(context, getContext())) return false;
    const current = context.chatMetadata[METADATA_KEY];
    if (!force && portableSnapshotMatches(current, world)) return false;
    if (!force && portableSnapshotIsNewer(current, world)) return false;
    context.chatMetadata[METADATA_KEY] = createPortableSnapshot(world);
    if (!await saveChatMetadata(context)) {
        if (current === undefined) delete context.chatMetadata[METADATA_KEY];
        else context.chatMetadata[METADATA_KEY] = current;
        return false;
    }
    return true;
}

export async function clearPortableSnapshot() {
    const context = getContext();
    if (!context.chatMetadata || !Object.hasOwn(context.chatMetadata, METADATA_KEY) || !canSafelySaveChatMetadata(context, getContext())) return false;
    const current = context.chatMetadata[METADATA_KEY];
    delete context.chatMetadata[METADATA_KEY];
    if (!await saveChatMetadata(context)) {
        context.chatMetadata[METADATA_KEY] = current;
        return false;
    }
    return true;
}
