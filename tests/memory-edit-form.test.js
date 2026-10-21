import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryEditForm } from '../extension/memory-edit-form.js';

class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.attributes = {}; this.value = ''; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    fire(name) { return this.events[name]?.({ preventDefault() {}, stopPropagation() {} }); }
    all(tag) { return [...(this.tag === tag ? [this] : []), ...this.children.flatMap(child => child.all(tag))]; }
}
const document = { createElement: tag => new Element(tag) };
const descriptor = { fields: [{ key: 'value', label: 'Value', type: 'text', value: 'Old content' },
    { key: 'participants', label: 'Participants', type: 'list', value: ['Alice', 'Bob'] },
    { key: 'importance', label: 'Importance', type: 'number', value: 3 }] };

test('saving sends only changed content fields and typed list values', async () => {
    let saved;
    let stopped = false;
    const form = createMemoryEditForm({ descriptor, document, onSave: async patch => { saved = patch; }, onCancel() {} });
    form.all('textarea')[0].value = 'New content';
    form.all('textarea')[1].value = 'Alice\nClaire';
    await form.events.submit({ preventDefault() {}, stopPropagation() { stopped = true; } });
    assert.deepEqual(saved, { value: 'New content', participants: ['Alice', 'Claire'] });
    assert.equal(stopped, true, 'saving an entry must not bubble into the chat send form');
});

test('failed and conflicting saves preserve the draft and show an inline error', async () => {
    const form = createMemoryEditForm({ descriptor, document, onSave: async () => { throw new Error('Memory changed.'); }, onCancel() {} });
    form.all('textarea')[0].value = 'Keep my draft';
    await form.fire('submit');
    assert.equal(form.all('textarea')[0].value, 'Keep my draft');
    assert.ok(form.all('div').some(item => item.textContent === 'Memory changed.'));
    assert.ok(form.all('button').every(item => !item.disabled));
});

test('cancel performs no save and duplicate submits cannot save twice', async () => {
    let saves = 0;
    let cancelled = 0;
    let finish;
    const form = createMemoryEditForm({ descriptor, document,
        onSave: () => { saves++; return new Promise(resolve => { finish = resolve; }); }, onCancel: () => { cancelled++; } });
    form.all('button')[1].fire('click');
    assert.equal(cancelled, 1);
    assert.equal(saves, 0);
    const pending = form.fire('submit');
    await form.fire('submit');
    assert.equal(saves, 1);
    assert.ok(form.all('button').every(item => item.disabled));
    finish();
    await pending;
});
