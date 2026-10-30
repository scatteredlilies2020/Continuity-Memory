import { resolveDigestGroupSize } from './digest-policy.js';
import { CONTINUITY_VERSION } from './build-info.js';

const MAX_PROBLEMS = 40;
const notificationTimes = new Map();

function problemIdentity(message) {
    return String(message || '').replace(/^(?:(?:Automatic memory update failed:|Memory catch-up failed;|Embedding catch-up failed;|Reply cancelled during memory preparation:)\s*)+/u, '').trim();
}

export function rememberHealthProblem(history, problem) {
    const message = String(problem.message || '').trim().slice(0, 2000);
    if (!message) return history;
    const key = `${problem.chatKey}|${problem.source}|${problem.id || problemIdentity(message)}`;
    const previous = history.find(item => item.key === key);
    const time = Number(problem.time) || Date.now();
    if (previous && time <= previous.time) return history;
    const entry = { key, chatKey: problem.chatKey, source: problem.source, message, time,
        count: (previous?.count || 0) + 1 };
    return [entry, ...history.filter(item => item.key !== key)].sort((a, b) => b.time - a.time).slice(0, MAX_PROBLEMS);
}

export function notifyHealthProblem(message, { chatKey, enabled, toastr, now = Date.now(), options = {} } = {}) {
    if (!enabled || !toastr?.error) return false;
    const key = `${chatKey}|${problemIdentity(message)}`;
    if (notificationTimes.has(key) && now - notificationTimes.get(key) < 60000) return false;
    notificationTimes.set(key, now);
    if (notificationTimes.size > 100) notificationTimes.delete(notificationTimes.keys().next().value);
    toastr.error(message, 'Continuity Memory', { timeOut: 12000, closeButton: true, ...options, escapeHtml: true });
    return true;
}

// Capture errors synchronously, before a retry or a throttled UI paint clears
// them. Only problem descriptions and job identifiers are saved, never prompts
// or model response bodies.
export function createHealthProblemTracker({ getHistory, saveHistory, getChatKey, onProblem = () => {},
    isCancellation = () => false, now = () => Date.now() }) {
    const seen = new Map();
    const record = (problem, notify = false) => {
        const history = getHistory();
        const next = rememberHealthProblem(history, problem);
        if (next === history) return;
        saveHistory(next);
        if (notify) onProblem(problem.message);
    };
    return state => {
        const chatKey = getChatKey();
        if (!chatKey) return;
        for (const job of state.memoryJobs || []) {
            if (job.chatKey !== chatKey || job.status !== 'error' || !job.error) continue;
            record({ chatKey, id: job.id, source: 'Memory', message: job.error,
                time: Date.parse(job.completedAt || job.createdAt) || now() });
        }
        const problems = [
            ['Memory', state.lastError], ['Chronicle', state.arcError], ['Story', state.storyLastError],
            ['Embeddings', state.embeddingIndex?.status === 'error' ? state.embeddingIndex.error : ''],
            ['Connection', state.memoryJob?.connection?.phase === 'retrying' ? state.memoryJob.connection.error || state.retryStatus : ''],
        ];
        for (const [source, value] of problems) {
            const message = String(value || '').trim();
            const signature = `${chatKey}|${problemIdentity(message)}`;
            if (seen.get(source) === signature) continue;
            seen.set(source, signature);
            if (!message || state.paused && isCancellation(new Error(message))) continue;
            record({ chatKey, source, message, time: now(),
                id: ['Memory', 'Connection'].includes(source) ? state.memoryJob?.id : undefined }, source !== 'Connection');
        }
    };
}

export function continuityHealth(state, settings, coverage = {}, now = Date.now()) {
    const size = resolveDigestGroupSize(settings.extractionBatchMessages);
    const pending = Math.max(0, Number(coverage.extractable) || 0);
    const totalPending = Math.max(0, Number(coverage.pending) || 0);
    const job = state.memoryJob;
    const connection = job?.connection;
    const index = state.embeddingIndex;
    const versions = `Browser ${CONTINUITY_VERSION} · ${state.health?.detachedJobs
        ? `server ${state.health.version || 'unknown'}${state.health.version !== CONTINUITY_VERSION ? ' — restart SillyTavern to load the updated server plugin' : ''}`
        : state.health ? 'SillyTavern file storage' : 'checking storage'}`;
    const backlog = `${totalPending} pending · ${pending} stable · automatic batch ${size} · reply catch-up at ${size * 2}`;
    const result = (level, label, message) => ({ level, label, message, backlog, versions, totalPending });
    if (!settings.enabled) return result('muted', 'Disabled', 'Continuity Memory is turned off.');
    const latestJob = [...(job ? [job] : []), ...(state.memoryJobs || [])]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const failedAfterLastSuccess = latestJob?.status === 'error'
        && (Date.parse(latestJob.completedAt || latestJob.createdAt) || 0) > (Date.parse(state.lastCompletedAt) || 0);
    const failure = state.lastError || (settings.hierarchyMode !== 'off' && state.arcError)
        || state.storyLastError || (settings.retrievalMode === 'embedding-hybrid' && index?.status === 'error' && index.error)
        || (!state.processing && !state.queue?.length && failedAfterLastSuccess && latestJob.error);
    if (failure) return result('error', 'Problem', String(failure));
    if (state.paused) return result('warning', 'Paused', 'Memory processing is paused. Saved sections remain intact.');
    if (state.roleplayGate?.active) return result('warning', 'Reply waiting', state.roleplayGate.message);
    if (state.status === 'reconnecting' || connection?.phase === 'retrying') {
        return result('warning', 'Retrying', connection?.error || state.retryStatus || 'CM is reconnecting automatically; completed sections are saved.');
    }
    if (state.processing || state.queue?.length || ['queued', 'processing'].includes(job?.status)) {
        const lastProgress = Number(connection?.lastProgressAt) || Number(connection?.startedAt) || Date.parse(job?.startedAt);
        const quietSeconds = Number.isFinite(lastProgress) ? Math.max(0, Math.floor((now - lastProgress) / 1000)) : 0;
        if (quietSeconds >= (Number(settings.requestIdleTimeoutSeconds) || 120)) {
            return result('warning', 'No recent progress', `No model progress for ${quietSeconds}s. The pending section is preserved; CM will reconnect if the request stalls.`);
        }
        const stage = job?.phase === 'chronicle' ? 'Promoting Chronicle'
            : connection?.phase === 'receiving' && !connection.outputCharacters ? 'Model thinking'
                : connection?.outputCharacters ? 'Receiving summary' : 'Building memory';
        const range = job?.from != null && job?.to != null ? ` · messages ${job.from}–${job.to}` : '';
        return result('working', stage, `${state.retryStatus || 'Completed sections are saved as processing continues.'}${range}`);
    }
    if (pending >= size && settings.autoExtract) return result('warning', 'Update pending', 'A complete stable batch is waiting for automatic extraction.');
    if (!settings.autoExtract) return result('warning', 'Automatic updates off', 'Memory updates are manually managed.');
    if (settings.retrievalMode === 'embedding-hybrid' && index?.status === 'syncing') return result('working', 'Indexing', `${index.indexed || 0}/${index.total || 0} memory records indexed.`);
    return result('ready', totalPending ? 'Recent messages raw' : 'Up to date', totalPending
        ? 'Recent messages remain available as raw chat until a stable Digest batch is complete.'
        : 'No pending messages are waiting for memory processing.');
}
