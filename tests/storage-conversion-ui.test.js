import assert from 'node:assert/strict';
import test from 'node:test';
import { bindStorageConversionControls } from '../extension/storage-conversion-ui.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const complete = { status: 'complete', worlds: { checked: 2, converted: 1, repaired: 1 },
    shards: { checked: 8, converted: 4 }, vectors: { checked: 3, converted: 1 } };

function fixture(api) {
    const panel = Object.assign(new EventTarget(), { open: false });
    const button = Object.assign(new EventTarget(), { disabled: false });
    const status = { textContent: '' };
    const document = Object.assign(new EventTarget(), { hidden: false });
    const timers = new Map();
    let nextTimer = 0;
    bindStorageConversionControls({ api, panel, button, status, document,
        setTimer: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimer: id => timers.delete(id),
    });
    return { panel, button, status, document, timers,
        async open(value = true) { panel.open = value; panel.dispatchEvent(new Event('toggle')); await flush(); },
        async click() { button.dispatchEvent(new Event('click')); await flush(); },
        async hide(value = true) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')); await flush(); },
        async tick() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); await flush(); },
    };
}

test('storage controls load only on open, explicitly force checks, and never poll completion', async () => {
    let reads = 0;
    let checks = 0;
    const ui = fixture({ getStorageMigration: async () => { reads++; return { storageMigration: complete }; },
        checkAllStorage: async () => { checks++; return { storageMigration: complete }; } });
    assert.equal(reads, 0);
    await ui.open();
    assert.equal(reads, 1);
    assert.match(ui.status.textContent, /Storage check complete.*6 converted, 1 worlds recovered/);
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.timers.size, 0);
    await ui.click();
    assert.equal(checks, 1);
    assert.equal(ui.timers.size, 0);
    await ui.open(false);
    assert.equal(reads, 1);
});

test('progress polling stops on completion, panel close and hidden page, and resumes only when visible', async () => {
    let reads = 0;
    let done = false;
    const ui = fixture({ getStorageMigration: async () => {
        reads++; return { storageMigration: done ? complete : { ...complete, status: 'running', phase: 'shards' } };
    } });
    await ui.open();
    assert.equal(ui.button.disabled, true);
    assert.equal(ui.timers.size, 1);
    await ui.tick();
    assert.equal(reads, 2);
    assert.equal(ui.timers.size, 1);
    await ui.open(false);
    assert.equal(ui.timers.size, 0);
    await ui.hide();
    await ui.hide(false);
    assert.equal(reads, 2, 'Visibility must not poll a closed panel');
    await ui.open();
    assert.equal(reads, 3);
    await ui.hide();
    assert.equal(ui.timers.size, 0);
    await ui.hide(false);
    assert.equal(reads, 4);
    done = true;
    await ui.tick();
    assert.equal(ui.timers.size, 0);
    assert.equal(ui.button.disabled, false);
});

test('in-flight reads are deduplicated and closing during a request cannot leave a timer', async () => {
    let resolve;
    let calls = 0;
    const ui = fixture({ getStorageMigration: () => { calls++; return new Promise(done => { resolve = done; }); } });
    await ui.open();
    await ui.open();
    assert.equal(calls, 1);
    await ui.open(false);
    resolve({ storageMigration: { ...complete, status: 'running' } });
    await flush();
    assert.equal(ui.timers.size, 0);
});

test('partial and unavailable-server results stop polling and allow explicit retry', async () => {
    let next = 'partial';
    const response = async () => {
        if (next === '404') throw Object.assign(new Error('missing'), { status: 404 });
        return { storageMigration: next === 'complete' ? complete : { ...complete, status: 'partial', errorCount: 1,
            errors: [{ message: '<b>Unresolved missing shard</b>' }] } };
    };
    const ui = fixture({ getStorageMigration: response, checkAllStorage: response });
    await ui.open();
    assert.match(ui.status.textContent, /<b>Unresolved missing shard<\/b>/);
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.timers.size, 0);
    next = '404';
    await ui.click();
    assert.match(ui.status.textContent, /Restart SillyTavern/);
    assert.equal(ui.button.disabled, false);
    next = 'complete';
    await ui.click();
    assert.match(ui.status.textContent, /Storage check complete/);
});
