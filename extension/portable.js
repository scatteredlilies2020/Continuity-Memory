import { getContext } from '/scripts/st-context.js';
import { getSettings } from './settings.js?v=0.14.0-standalone.69.2';
import { createPortableSnapshot, PORTABLE_SCHEMA_VERSION, portableSnapshotMatches } from './portable-state.js';

const METADATA_KEY = 'continuityMemory';

export function getPortableSnapshot() {
    const snapshot = getContext().chatMetadata?.[METADATA_KEY];
    if (!snapshot || snapshot.schemaVersion !== PORTABLE_SCHEMA_VERSION || !snapshot.world?.id) return null;
    return snapshot;
}

async function saveChatMetadata(context) {
    if (typeof context.saveMetadata === 'function') {
        await context.saveMetadata();
    } else {
        context.saveMetadataDebounced?.();
    }
}

export async function embedWorldInChat(world, { force = false } = {}) {
    if (!getSettings().embedMemoryInChat) return false;
    const context = getContext();
    if (!context.chatId || !context.chatMetadata || !world?.id) return false;
    const current = context.chatMetadata[METADATA_KEY];
    if (!force && portableSnapshotMatches(current, world)) return false;
    context.chatMetadata[METADATA_KEY] = createPortableSnapshot(world);
    await saveChatMetadata(context);
    return true;
}

export async function clearPortableSnapshot() {
    const context = getContext();
    if (!context.chatMetadata || !Object.hasOwn(context.chatMetadata, METADATA_KEY)) return false;
    delete context.chatMetadata[METADATA_KEY];
    await saveChatMetadata(context);
    return true;
}
