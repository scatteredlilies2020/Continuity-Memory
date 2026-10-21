import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
const start = ui.indexOf('function renderMemoryViewer(');
const end = start + ui.slice(start).indexOf('\n}\n') + 2;
const renderer = ui.slice(start, end);

test('background runtime repaints do not replace an open edit or its draft', () => {
    const session = { worldId: 'world', chatKey: 'chat', draft: 'Keep this wording' };
    const context = { memoryEditSession: session, runtime: { world: { id: 'world', revision: 6 } }, getChatKey: () => 'chat',
        getProcessingCoverage: () => assert.fail('an open editor must retain its DOM and input state') };
    vm.runInNewContext(`${renderer}; renderMemoryViewer();`, context);
    assert.equal(context.memoryEditSession, session);
    assert.equal(session.draft, 'Keep this wording');
});

test('switching chats sharing a world retires the old editor and repaints the correct memory', () => {
    const events = [];
    const context = {
        runtime: { world: { id: 'world', revision: 5 } }, getChatKey: () => 'chat-b',
        memoryEditSession: { worldId: 'world', chatKey: 'chat-a' },
        viewerSignature: 'world:5:chat-b:digest::0:10:0', viewerCategory: 'digest', viewerSearch: '', viewerPage: 0,
        getProcessingCoverage: () => ({ latestIndex: 10, pending: 0 }),
        MEMORY_VIEW_CATEGORIES: [{ key: 'digest', label: 'Digest' }],
        memoryViewerPage: () => ({ page: 0, category: 'digest', total: 0, pages: 1, items: [] }),
        $: selector => {
            const chain = {
                prop: (key, value) => { events.push({ selector, key, value }); return chain; },
                val: () => chain, text: () => chain, addClass: () => chain, appendTo: () => chain,
                empty: () => { events.push({ selector, empty: true }); return chain; },
            };
            return chain;
        },
    };
    vm.runInNewContext(`${renderer}; renderMemoryViewer();`, context);
    assert.equal(context.memoryEditSession, null);
    assert.ok(events.some(item => item.selector === '#continuity_memory_viewer' && item.empty));
    assert.ok(events.some(item => item.key === 'disabled' && item.value === false));
});
