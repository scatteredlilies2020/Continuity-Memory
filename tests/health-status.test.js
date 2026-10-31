import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clearHealthProblemHistory, continuityHealth, createHealthProblemTracker, notifyHealthProblem, rememberHealthProblem } from '../extension/health-status.js';
import { CONTINUITY_VERSION } from '../extension/build-info.js';

const settings = { enabled: true, autoExtract: true, extractionBatchMessages: 8, hierarchyMode: 'chronicle', requestIdleTimeoutSeconds: 120 };
const time = Date.parse('2026-10-30T07:00:00Z');
const failedJob = { id: 'failed', chatKey: 'chat', status: 'error', createdAt: '2026-10-30T06:00:00Z',
    completedAt: '2026-10-30T06:10:00Z', error: 'Extractor reached its output limit.' };

function trackerFixture() {
    let history = [], clearedAt = {}, chatKey = 'chat', clock = time, saves = 0;
    const notices = [];
    const options = { getChatKey: () => chatKey, getHistory: () => history,
        saveHistory: value => { saves++; history = value; }, onProblem: value => notices.push(value),
        getClearedAt: key => clearedAt[key] || 0,
        now: () => ++clock, isCancellation: error => /Processing stopped/.test(error.message) };
    return { observe: createHealthProblemTracker(options), notices, history: () => history, saves: () => saves,
        clear: () => {
            const preferences = { healthProblemHistory: history, healthProblemClearedAt: clearedAt };
            clearHealthProblemHistory(preferences, chatKey, ++clock);
            history = preferences.healthProblemHistory;
            clearedAt = preferences.healthProblemClearedAt;
        },
        reload: () => createHealthProblemTracker(options), switchChat: value => { chatKey = value; } };
}

test('fast failures remain in saved history after a retry clears live error text', () => {
    const h = trackerFixture();
    h.observe({ lastError: 'Output limit reached' });
    h.observe({ lastError: '', processing: true });
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].message, 'Output limit reached');
    assert.equal(h.notices.length, 1);
    h.reload()({ lastError: '' });
    assert.equal(h.history().length, 1, 'A browser reload must retain the user settings history.');
});

test('clearing the log only removes the selected chat history, not settings or memory', () => {
    const preferences = { enabled: true, chatWorlds: { chat: 'world' }, healthProblemHistory: [
        { chatKey: 'chat', message: 'First error' }, { chatKey: 'other', message: 'Other error' },
    ], healthProblemClearedAt: { other: time - 10 } };
    assert.equal(clearHealthProblemHistory(preferences, 'chat', time), 1);
    assert.deepEqual(preferences.healthProblemHistory, [{ chatKey: 'other', message: 'Other error' }]);
    assert.deepEqual(preferences.healthProblemClearedAt, { other: time - 10, chat: time });
    assert.deepEqual(preferences.chatWorlds, { chat: 'world' });
    assert.equal(preferences.enabled, true);
    const before = structuredClone(preferences);
    assert.equal(clearHealthProblemHistory(preferences, '', time + 1), 0);
    assert.deepEqual(preferences, before, 'No open chat must never clear all chats.');
});

test('cleared server failures stay cleared after polling, reload, and chat switching', () => {
    const h = trackerFixture();
    const state = { memoryJobs: [failedJob], memoryJob: failedJob,
        lastError: `Automatic memory update failed: ${failedJob.error}` };
    h.observe(state);
    h.clear();
    assert.equal(h.history().length, 0);
    h.observe(state);
    const reloaded = h.reload();
    for (let i = 0; i < 10; i++) reloaded(state);
    assert.equal(h.history().length, 0);
    assert.equal(continuityHealth(state, settings).level, 'error', 'Clearing history must not hide active failures.');
    h.switchChat('other');
    reloaded({ lastError: 'Other chat error' });
    assert.equal(h.history()[0].chatKey, 'other');
    h.switchChat('chat');
    reloaded(state);
    assert.equal(h.history().length, 1, 'Returning to the cleared chat must not resurrect its jobs.');
    const newer = { ...failedJob, id: 'new-failure', createdAt: new Date(time + 1000).toISOString(),
        completedAt: new Date(time + 2000).toISOString() };
    reloaded({ memoryJobs: [failedJob, newer], memoryJob: newer, lastError: newer.error });
    assert.equal(h.history().filter(item => item.chatKey === 'chat').length, 1, 'New failures must still be recorded.');
});

test('clearing a transient problem keeps it cleared until a new occurrence', () => {
    const h = trackerFixture();
    const state = { storageError: 'Storage unavailable' };
    h.observe(state);
    h.clear();
    h.observe(state);
    assert.equal(h.history().length, 0);
    h.observe({ storageError: '' });
    h.observe(state);
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].count, 1);
});

test('storage interruptions show automatic recovery and keep their history after reconnection', () => {
    const h = trackerFixture();
    const state = { storageError: 'Continuity server request timed out.' };
    h.observe(state);
    const health = continuityHealth(state, settings);
    assert.equal(health.label, 'Reconnecting storage');
    assert.match(health.message, /retries automatically/);
    state.storageError = '';
    h.observe(state);
    assert.equal(continuityHealth(state, settings).level, 'ready');
    assert.equal(h.history()[0].source, 'Storage');
    assert.equal(h.history()[0].count, 1);
});

test('polling the same problem does not repeatedly save settings or show popups', () => {
    const h = trackerFixture();
    for (let i = 0; i < 20; i++) h.observe({ lastError: 'Output limit reached' });
    assert.equal(h.saves(), 1);
    assert.equal(h.notices.length, 1);
    h.observe({ lastError: '' });
    h.observe({ lastError: 'Output limit reached' });
    assert.equal(h.history()[0].count, 2);
});

test('server job failures restore after reload without old timestamps causing repeated writes', () => {
    const h = trackerFixture();
    h.observe({ memoryJobs: [failedJob] });
    assert.equal(h.history().length, 1);
    assert.equal(h.notices.length, 0, 'Restoring old jobs must not replay all their popups.');
    h.observe({ memoryJob: failedJob, memoryJobs: [failedJob], lastError: `Automatic memory update failed: ${failedJob.error}` });
    const saves = h.saves();
    for (let i = 0; i < 20; i++) h.observe({ memoryJob: failedJob, memoryJobs: [failedJob], lastError: `Automatic memory update failed: ${failedJob.error}` });
    assert.equal(h.saves(), saves);
    assert.equal(h.history().length, 1);
});

test('problem history isolates chats, ignores intentional Stop, and does not save response bodies', () => {
    const h = trackerFixture();
    h.observe({ paused: true, lastError: 'Processing stopped safely.' });
    assert.equal(h.history().length, 0);
    h.observe({ lastError: 'First error', lastRawResponse: 'private model output' });
    h.switchChat('other');
    h.observe({ memoryJobs: [failedJob], lastError: 'Second error' });
    assert.deepEqual(h.history().map(item => item.chatKey), ['other', 'chat']);
    assert.ok(!JSON.stringify(h.history()).includes('private model output'));
});

test('problem history is bounded and stores long errors without unbounded payloads', () => {
    let history = [];
    for (let i = 0; i < 100; i++) history = rememberHealthProblem(history,
        { chatKey: 'chat', source: 'Memory', id: `job-${i}`, message: 'x'.repeat(5000), time: time + i });
    assert.equal(history.length, 40);
    assert.equal(history[0].message.length, 2000);
});

test('background and reply-gate error notifications deduplicate and escape API text', () => {
    const notices = [];
    const options = { chatKey: 'notification-test', enabled: true, toastr: { error: (...args) => notices.push(args) }, now: time };
    assert.equal(notifyHealthProblem('Automatic memory update failed: <b>output limit</b>', options), true);
    assert.equal(notifyHealthProblem('Reply cancelled during memory preparation: Memory catch-up failed; <b>output limit</b>', options), false);
    assert.equal(notices[0][2].escapeHtml, true);
    assert.equal(notifyHealthProblem('Another error', { ...options, enabled: false }), false);
});

test('errors remain visible while progress exists and after server-only failures are restored', () => {
    assert.equal(continuityHealth({ lastError: 'Output limit', progress: { current: 1, total: 4 }, processing: true }, settings).level, 'error');
    assert.equal(continuityHealth({ memoryJobs: [failedJob] }, settings).level, 'error');
    assert.notEqual(continuityHealth({ memoryJobs: [failedJob], lastCompletedAt: '2026-10-30T06:30:00Z' }, settings).level, 'error');
    const complete = { ...failedJob, id: 'completed', createdAt: '2026-10-30T06:20:00Z', status: 'complete' };
    assert.notEqual(continuityHealth({ memoryJobs: [failedJob], memoryJob: complete }, settings).level, 'error');
});

test('health shows thinking, retrying, backlog, and loss of model progress separately', () => {
    const state = { processing: true, memoryJob: { status: 'processing', from: 148, to: 151,
        connection: { phase: 'receiving', reasoningCharacters: 2000, outputCharacters: 0, lastProgressAt: time } } };
    let health = continuityHealth(state, settings, { pending: 14, extractable: 12 }, time);
    assert.equal(health.label, 'Model thinking');
    assert.match(health.message, /148–151/);
    assert.match(health.backlog, /automatic batch 8 · reply catch-up at 16/);
    health = continuityHealth(state, settings, {}, time + 121000);
    assert.equal(health.label, 'No recent progress');
    assert.equal(continuityHealth({ status: 'reconnecting', retryStatus: 'Network unavailable' }, settings).label, 'Retrying');
    assert.equal(continuityHealth({}, settings, { extractable: 8 }).label, 'Update pending');
    assert.equal(continuityHealth({ paused: true }, settings).label, 'Paused');
});

test('browser and server versions reveal a pending server restart', () => {
    const health = continuityHealth({ health: { detachedJobs: true, version: 'old' } }, settings);
    assert.match(health.versions, new RegExp(CONTINUITY_VERSION.replaceAll('.', '\\.')));
    assert.match(health.versions, /restart SillyTavern/);
    assert.doesNotMatch(continuityHealth({ health: { detachedJobs: true, version: CONTINUITY_VERSION } }, settings).versions, /restart/);
    for (const name of ['../manifest.json', '../extension/manifest.json', '../package.json']) {
        assert.equal(JSON.parse(readFileSync(new URL(name, import.meta.url))).version, CONTINUITY_VERSION);
    }
});

test('settings status and problem history render errors safely without adding a chat control', () => {
    const source = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const elements = new Map(['continuity_health_card', 'continuity_header_health',
        'continuity_health_title', 'continuity_health_message', 'continuity_health_backlog', 'continuity_health_versions', 'continuity_health_details', 'continuity_health_clear']
        .map(id => [id, { dataset: {}, textContent: '' }]));
    const dialog = { textContent: '' };
    const context = { document: { getElementById: id => elements.get(id), querySelector: selector => elements.get(selector.slice(1)) },
        runtime: { processing: true, lastError: '<img src=x onerror=alert(1)>', progress: { current: 1 } },
        getSettings: () => ({ ...settings, healthProblemHistory: [{ chatKey: 'chat', source: 'Memory', message: 'Earlier problem', time, count: 1 }] }),
        getChatKey: () => 'chat', continuityHealth, lastHealthCoverage: { pending: 16, extractable: 16 }, healthDialogContent: dialog };
    vm.runInNewContext(source.match(/^function setElementText\([^]*?^}/m)[0] + '\n'
        + source.match(/^function renderHealthStatus\([^]*?^}/m)[0] + '\nrenderHealthStatus();', context);
    assert.equal(elements.get('continuity_header_health').textContent, 'Problem');
    assert.equal(elements.get('continuity_health_message').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(elements.get('continuity_health_card').dataset.level, 'error');
    assert.match(dialog.textContent, /Earlier problem/);
    assert.equal(elements.get('continuity_health_clear').disabled, false);
    assert.doesNotMatch(source, /continuity_chat_health|continuity-chat-health/);
});

test('clear log action persists the change, refreshes the UI and leaves runtime memory untouched', () => {
    const source = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const preferences = { healthProblemHistory: [{ chatKey: 'chat', message: 'Old error' },
        { chatKey: 'other', message: 'Keep this' }] };
    let saves = 0, renders = 0, chatKey = 'chat';
    const state = { world: { digest: ['saved memory'] }, lastError: 'Active error', processing: true };
    const before = structuredClone(state);
    const context = { getSettings: () => preferences, getChatKey: () => chatKey, clearHealthProblemHistory,
        saveSettings: () => saves++, renderHealthStatus: () => renders++, runtime: state };
    vm.runInNewContext(source.match(/^function clearCurrentHealthProblems\([^]*?^}/m)[0]
        + '\nclearCurrentHealthProblems();', context);
    assert.deepEqual(preferences.healthProblemHistory, [{ chatKey: 'other', message: 'Keep this' }]);
    assert.ok(preferences.healthProblemClearedAt.chat > 0);
    assert.equal(saves, 1);
    assert.equal(renders, 1);
    assert.deepEqual(state, before);
    chatKey = '';
    vm.runInNewContext('clearCurrentHealthProblems();', context);
    assert.equal(saves, 1);
    assert.equal(preferences.healthProblemHistory.length, 1);
    assert.match(source, /getClearedAt: chatKey => getSettings\(\)\.healthProblemClearedAt/);
    assert.match(source, /getElementById\('continuity_health_clear'\)\?\.addEventListener\('click', clearCurrentHealthProblems\)/);
    assert.match(source, /customButtons: \[\{ text: 'Clear this chat’s log', action: clearCurrentHealthProblems/);
    const template = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    assert.match(template, /id="continuity_health_clear"[^>]*disabled>Clear problem log<\/button>/);
});

test('the problem dialog stays open and updates its count and clear button immediately', async () => {
    const source = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const preferences = { ...settings, healthProblemHistory: [{ chatKey: 'chat', source: 'Memory',
        message: 'Earlier problem', time, count: 1 }] };
    const clearButton = { disabled: false };
    const elements = new Map([['continuity_health_clear', clearButton],
        ['continuity_health_details', { textContent: '' }]]);
    let saves = 0, close;
    const context = { document: { getElementById: id => elements.get(id),
        querySelector: selector => elements.get(selector.slice(1)), createElement: () => ({ textContent: '' }) },
        getSettings: () => preferences, getChatKey: () => 'chat', continuityHealth, clearHealthProblemHistory,
        saveSettings: () => saves++, runtime: {}, lastHealthCoverage: {}, healthDialogContent: null,
        POPUP_TYPE: { TEXT: 1 }, Popup: class {
            constructor(content, type, value, options) { this.options = options; }
            show() {
                assert.match(context.healthDialogContent.textContent, /Earlier problem/);
                this.options.customButtons[0].action();
                assert.match(context.healthDialogContent.textContent, /No problems have been recorded/);
                assert.equal(elements.get('continuity_health_details').textContent, 'Recent problems (0)');
                assert.equal(clearButton.disabled, true);
                return new Promise(resolve => { close = resolve; });
            }
        } };
    vm.createContext(context);
    for (const name of ['setElementText', 'renderHealthStatus', 'clearCurrentHealthProblems', 'openHealthDetails']) {
        vm.runInContext(source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0], context);
    }
    const pending = vm.runInContext('openHealthDetails();', context);
    assert.ok(context.healthDialogContent, 'Clearing the log must not close the dialog.');
    assert.equal(saves, 1);
    close();
    await pending;
    assert.equal(context.healthDialogContent, null);
});

test('browser cache keys load the clear-log feature without changing the server build', () => {
    const source = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const statusImport = /from '(\.\/health-status\.js[^']+)'/;
    assert.equal(source.match(statusImport)[1], ui.match(statusImport)[1], 'Health notifications must share one module instance.');
    assert.match(source.match(statusImport)[1], /clear-problems=1/);
    assert.match(source, /from '\.\/ui\.js[^']*clear-problems=1'/);
    assert.match(source, /settings\.html[^']*clear-problems=1/);
    for (const file of ['../manifest.json', '../extension/manifest.json']) {
        const manifest = JSON.parse(readFileSync(new URL(file, import.meta.url)));
        assert.match(manifest.js, /clear-problems=1/);
        assert.equal(manifest.version, CONTINUITY_VERSION);
    }
});
