import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { continuityHealth, createHealthProblemTracker, notifyHealthProblem, rememberHealthProblem } from '../extension/health-status.js';
import { CONTINUITY_VERSION } from '../extension/build-info.js';

const settings = { enabled: true, autoExtract: true, extractionBatchMessages: 8, hierarchyMode: 'chronicle', requestIdleTimeoutSeconds: 120 };
const time = Date.parse('2026-10-30T07:00:00Z');
const failedJob = { id: 'failed', chatKey: 'chat', status: 'error', createdAt: '2026-10-30T06:00:00Z',
    completedAt: '2026-10-30T06:10:00Z', error: 'Extractor reached its output limit.' };

function trackerFixture() {
    let history = [], chatKey = 'chat', clock = time, saves = 0;
    const notices = [];
    const options = { getChatKey: () => chatKey, getHistory: () => history,
        saveHistory: value => { saves++; history = value; }, onProblem: value => notices.push(value),
        now: () => ++clock, isCancellation: error => /Processing stopped/.test(error.message) };
    return { observe: createHealthProblemTracker(options), notices, history: () => history, saves: () => saves,
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

test('the chat status control and problem view render errors safely even with the settings drawer closed', () => {
    const source = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    const elements = new Map(['continuity_health_card', 'continuity_chat_health', 'continuity_header_health',
        'continuity_health_title', 'continuity_health_message', 'continuity_health_backlog', 'continuity_health_versions', 'continuity_health_details']
        .map(id => [id, { dataset: {}, textContent: '' }]));
    const dialog = { textContent: '' };
    const context = { document: { getElementById: id => elements.get(id), querySelector: selector => elements.get(selector.slice(1)) },
        runtime: { processing: true, lastError: '<img src=x onerror=alert(1)>', progress: { current: 1 } },
        getSettings: () => ({ ...settings, healthProblemHistory: [{ chatKey: 'chat', source: 'Memory', message: 'Earlier problem', time, count: 1 }] }),
        getChatKey: () => 'chat', continuityHealth, lastHealthCoverage: { pending: 16, extractable: 16 }, healthDialogContent: dialog };
    vm.runInNewContext(source.match(/^function setElementText\([^]*?^}/m)[0] + '\n'
        + source.match(/^function renderHealthStatus\([^]*?^}/m)[0] + '\nrenderHealthStatus();', context);
    assert.match(elements.get('continuity_chat_health').textContent, /CM: Problem · 16 pending/);
    assert.equal(elements.get('continuity_health_message').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(elements.get('continuity_chat_health').dataset.level, 'error');
    assert.match(dialog.textContent, /Earlier problem/);
    assert.match(source, /getElementById\('send_form'\)\?\.before\(button\)/);
});
