import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bindModelSelector, populateModelSelector, syncModelSelector } from '../extension/model-selector.js';

function controls() {
    const document = { createElement: () => ({ value: '', textContent: '' }), defaultView: { Event } };
    const input = Object.assign(new EventTarget(), { value: '', ownerDocument: document });
    const select = Object.assign(new EventTarget(), {
        value: '', options: [], ownerDocument: document,
        append(option) { this.options.push(option); },
        replaceChildren() { this.options = []; this.value = ''; },
    });
    return { input, select };
}

for (const provider of ['proxy', 'openrouter']) {
    test(`${provider}: fetched dropdown selection saves and survives a settings render`, () => {
        const { input, select } = controls();
        let saved = 'model-a';
        let changes = 0;
        input.addEventListener('change', () => {
            saved = input.value;
            changes++;
            syncModelSelector(input, select, saved);
        });
        bindModelSelector(input, select);
        populateModelSelector(input, select, ['model-a', 'model-b', 'model-b'], saved);
        assert.equal(changes, 0, 'fetching must not change the saved model');
        assert.deepEqual(select.options.map(option => option.value), ['model-a', 'model-b']);
        select.value = 'model-b';
        select.dispatchEvent(new Event('change'));
        assert.equal(saved, 'model-b');
        assert.equal(input.value, 'model-b');
        assert.equal(select.value, 'model-b');
        assert.equal(changes, 1);
        syncModelSelector(input, select, saved);
        assert.equal(select.value, 'model-b');
    });
}

test('manual models remain selectable when absent from a fetched catalog', () => {
    const { input, select } = controls();
    bindModelSelector(input, select);
    populateModelSelector(input, select, ['listed'], 'custom/model');
    assert.equal(select.value, 'custom/model');
    input.value = ' another/model ';
    input.dispatchEvent(new Event('change'));
    assert.equal(input.value, 'another/model');
    assert.equal(select.value, 'another/model');
    assert.equal(select.options.at(-1).textContent, 'another/model');
    populateModelSelector(input, select, ['new-catalog'], input.value);
    assert.equal(select.value, 'another/model');
});

test('settings restore separate provider models without overwriting either catalog', () => {
    const proxy = controls();
    const openrouter = controls();
    populateModelSelector(proxy.input, proxy.select, ['proxy-a', 'proxy-b'], 'proxy-b');
    populateModelSelector(openrouter.input, openrouter.select, ['or-a', 'or-b'], 'or-a');
    syncModelSelector(proxy.input, proxy.select, 'proxy-b');
    syncModelSelector(openrouter.input, openrouter.select, 'or-a');
    assert.equal(proxy.select.value, 'proxy-b');
    assert.equal(openrouter.select.value, 'or-a');
});

test('both embedding providers expose native selectors wired alongside manual IDs', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
    for (const provider of ['proxy', 'openrouter']) {
        assert.match(html, new RegExp(`<select id="continuity_embedding_${provider}_model_select"`));
    }
    assert.match(ui, /bindModelSelector\(document.querySelector\(selector\), document.querySelector\(`\$\{selector\}_select`\)\)/);
});
