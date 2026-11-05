// SillyTavern may wrap an upstream failure in HTTP 200 with { error: true }.
// Do not present that successful local transport status as the failure reason.
export function discoveredModelIds(response, payload) {
    if (!response.ok || payload?.error) {
        const detail = typeof payload?.error === 'string' ? payload.error
            : payload?.error?.message || payload?.message;
        const reason = typeof detail === 'string' && detail.trim() ? detail.trim()
            : response.ok
                ? 'SillyTavern reported an upstream model-list failure. Check the API base URL, saved password/key, and proxy availability; see the SillyTavern server log for the upstream error.'
                : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
        throw new Error(`Model discovery failed: ${reason} Manual model entry remains available.`);
    }
    const source = Array.isArray(payload) ? payload
        : Array.isArray(payload?.data) ? payload.data
            : Array.isArray(payload?.models) ? payload.models : [];
    const models = [...new Set(source.map(item => typeof item === 'string' ? item : item?.id || item?.name)
        .filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].sort();
    if (!models.length) throw new Error('The endpoint returned no model IDs. Manual model entry remains available.');
    return models;
}
