import { getSettings, saveSettings } from './settings.js?v=0.15.0-testing.28';

// Keep an explicit fresh start authoritative even after new Digest chunks are
// saved. This is local recovery policy, not a deletion of other synced copies.
export function blockSyncedRecovery(worldId) {
    const settings = getSettings();
    if (!worldId || settings.syncedRecoveryBlockedWorldIds?.includes(worldId)) return;
    settings.syncedRecoveryBlockedWorldIds = [...(settings.syncedRecoveryBlockedWorldIds || []), worldId];
    saveSettings();
}
