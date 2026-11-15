// Progress requests exist only while this panel is visible and conversion is
// running. Completed receipts never create a perpetual browser polling loop.
export function bindStorageConversionControls({ api, panel, button, status, document: doc = globalThis.document,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (!panel || !button || !status) return;
    let timer;
    let pending = false;
    const visible = () => panel.open && !doc.hidden;
    const stop = () => { clearTimer(timer); timer = undefined; };
    const refresh = async (force = false) => {
        stop();
        if (pending || !force && !visible()) return;
        pending = true;
        button.disabled = true;
        try {
            const { storageMigration: state } = await (force ? api.checkAllStorage() : api.getStorageMigration());
            const counts = `${state.worlds.checked} worlds, ${state.shards.checked} shards, ${state.vectors.checked} indexes`;
            if (state.status === 'running') {
                status.textContent = `Checking ${state.phase || 'storage'}… ${counts}. Safe to close this panel.`;
                if (visible()) timer = setTimer(() => { void refresh(); }, 1500);
            } else if (state.status === 'complete') {
                const converted = state.worlds.converted + state.shards.converted + state.vectors.converted;
                status.textContent = `Storage check complete: ${counts}; ${converted} converted, ${state.worlds.repaired || 0} worlds recovered. Completion saved; no automatic conversion rescan on restart.`;
            } else {
                const issue = state.errors?.[0];
                const detail = issue ? `${issue.file || 'storage'}: ${issue.message}` : '';
                status.textContent = `Conversion unfinished (${state.errorCount} issue(s)). Originals preserved; retries on connection. ${detail || 'Use Check all storage to retry now.'}`;
            }
            button.disabled = state.status === 'running';
        } catch (error) {
            status.textContent = error.status === 404
                ? 'Restart SillyTavern with the updated server plugin to enable storage conversion controls.' : error.message;
            button.disabled = false;
        } finally { pending = false; }
    };
    panel.addEventListener('toggle', () => { if (visible()) void refresh(); else stop(); });
    doc.addEventListener('visibilitychange', () => { if (visible()) void refresh(); else stop(); });
    button.addEventListener('click', () => { void refresh(true); });
    if (visible()) void refresh();
}
