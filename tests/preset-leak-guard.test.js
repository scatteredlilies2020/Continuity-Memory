import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { blankSavedPromptMemory, isUnsavedPromptExport, UNSAVED_PROMPT_EXPORTS } from '../extension/preset-leak-guard.js';
import { clearPromptManagerInjection, PROMPT_MANAGER_ID } from '../extension/prompt-manager-injection.js';

const memory = { identifier: PROMPT_MANAGER_ID, name: 'Continuity Memory', role: 'user', content: 'private memory', system_prompt: false, marker: false };

test('saved and exported prompt lists lose only this extension’s memory', () => {
    const prompts = [{ identifier: 'main', content: 'Main prompt' }, structuredClone(memory), null, { identifier: 'tale_fairy_dynamic', content: 'another extension' }];
    assert.equal(blankSavedPromptMemory(prompts), true);
    assert.equal(prompts[1].content, '');
    assert.equal(prompts[0].content, 'Main prompt');
    assert.equal(prompts[3].content, 'another extension');
    assert.equal(prompts.length, 4, 'The entry itself stays so the preset keeps its shape');
    assert.equal(blankSavedPromptMemory(prompts), false, 'an already blank entry needs no re-save');
    for (const missing of [undefined, null, {}, 'prompts']) assert.equal(blankSavedPromptMemory(missing), false);
});

test('only the two controls that save the live slot without an event are intercepted', () => {
    const asked = [];
    assert.equal(isUnsavedPromptExport({ closest: selector => { asked.push(selector); return {}; } }), true);
    assert.deepEqual(asked, [UNSAVED_PROMPT_EXPORTS]);
    assert.match(UNSAVED_PROMPT_EXPORTS, /(^|, )#update_oai_preset(,|$)/);
    assert.match(UNSAVED_PROMPT_EXPORTS, /(^|, )#completion_prompt_manager #prompt-manager-export(,|$)/);
    for (const target of [undefined, null, {}, 'text', { closest: selector => selector === 'other' ? {} : null }]) {
        assert.equal(isUnsavedPromptExport(target), false);
    }
});

const indexSource = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
const guardSource = indexSource.match(/    \/\/ The Prompt Manager slot holds[^]*?^    \}, true\);/m)?.[0];

function guardHarness({ live = [], eventTypes = {} } = {}) {
    const listeners = new Map(), clicks = [], timers = [], errors = [];
    const livePrompts = live.map(prompt => structuredClone(prompt));
    const saved = [];
    let refreshes = 0, invalidations = 0;
    const scope = vm.createContext({
        oai_settings: { prompts: livePrompts },
        event_types: {
            OAI_PRESET_CHANGED_BEFORE: 'preset-before', OAI_PRESET_CHANGED_AFTER: 'preset-after',
            OAI_PRESET_IMPORT_READY: 'import', OAI_PRESET_EXPORT_READY: 'export', PRESET_RENAMED: 'preset-renamed', ...eventTypes,
        },
        eventSource: { on: (name, callback) => { assert.equal(listeners.has(name), false, `${name} is registered once`); listeners.set(name, callback); } },
        promptManager: { getPromptById: identifier => livePrompts.find(prompt => prompt?.identifier === identifier) || null },
        blankSavedPromptMemory, isUnsavedPromptExport, clearPromptManagerInjection,
        scheduleInjectionRefresh: () => { refreshes++; },
        invalidateInjectionRefresh: () => { invalidations++; },
        updateRuntime: patch => errors.push(patch.lastError),
        document: { addEventListener: (type, callback, capture) => clicks.push({ type, callback, capture }) },
        setTimeout: callback => timers.push(callback),
    });
    assert.ok(guardSource, 'the guard is wired inside init()');
    vm.runInContext(guardSource, scope);
    const click = matches => clicks[0].callback({ target: { closest: () => matches ? {} : null } });
    return { scope, listeners, clicks, timers, errors, saved, livePrompts, click, refreshes: () => refreshes, invalidations: () => invalidations };
}

test('startup blanks the slot restored from settings.json, before this chat’s first preview', () => {
    const h = guardHarness({ live: [structuredClone(memory), { identifier: 'main', content: 'Main prompt' }] });
    assert.equal(h.livePrompts[0].content, '');
    assert.equal(h.livePrompts[1].content, 'Main prompt');
    guardHarness({ live: [null, { identifier: 'main', content: 'Main prompt' }] });
});

test('a selected preset is cleaned and saved again, because "New preset" writes before it announces', () => {
    const h = guardHarness();
    const preset = { temperature: 0.7, prompts: [structuredClone(memory), { identifier: 'main', content: 'Main prompt' }] };
    h.listeners.get('preset-before')({ preset, presetName: 'Dirty', savePreset: (...args) => h.saved.push(args) });
    assert.equal(preset.prompts[0].content, '');
    assert.equal(preset.prompts[1].content, 'Main prompt');
    assert.equal(preset.temperature, 0.7);
    assert.deepEqual(h.saved, [['Dirty', preset, false]]);
    h.listeners.get('preset-before')({ preset, presetName: 'Dirty', savePreset: (...args) => h.saved.push(args) });
    assert.equal(h.saved.length, 1, 'a clean preset is not rewritten');
});

test('a preset without a name or save hook is still cleaned', () => {
    const h = guardHarness();
    for (const event of [{}, null, { preset: { prompts: [structuredClone(memory)] } }, { preset: { prompts: [structuredClone(memory)] }, presetName: 'Dirty' }]) {
        const before = h.saved.length;
        h.listeners.get('preset-before')(event);
        assert.equal(h.saved.length, before);
        // Events without a preset have nothing to clean.
        if (event?.preset) assert.equal(event.preset.prompts[0].content, '');
    }
});

test('a failed re-save is reported instead of leaving an unhandled rejection', async () => {
    const h = guardHarness();
    const preset = { prompts: [structuredClone(memory)] };
    h.listeners.get('preset-before')({ preset, presetName: 'Dirty', savePreset: async () => { throw new Error('Failed to save preset'); } });
    await new Promise(setImmediate);
    assert.match(h.errors[0], /Dirty.*Failed to save preset/);
    assert.equal(preset.prompts[0].content, '');
});

test('the live slot is refilled for the current chat once the preset has replaced the prompts', () => {
    const h = guardHarness();
    assert.equal(h.refreshes(), 0);
    h.listeners.get('preset-after')();
    assert.equal(h.refreshes(), 1);
});

test('imported and exported presets carry a blank entry', () => {
    const h = guardHarness();
    const imported = { temperature: 1, prompts: [structuredClone(memory)] };
    h.listeners.get('import')({ data: imported, presetName: 'Imported' });
    assert.equal(imported.prompts[0].content, '');
    assert.equal(imported.temperature, 1);
    const exported = { prompts: [structuredClone(memory), { identifier: 'main', content: 'Main prompt' }] };
    h.listeners.get('export')(exported);
    assert.equal(exported.prompts[0].content, '');
    assert.equal(exported.prompts[1].content, 'Main prompt');
    h.listeners.get('import')({});
    h.listeners.get('export')(undefined);
});

test('"Update preset" and the Prompt Manager export blank the live slot first, then refill it', () => {
    const h = guardHarness({ live: [structuredClone(memory)] });
    assert.equal(h.livePrompts[0].content, '', 'startup has already emptied the restored slot');
    h.livePrompts[0].content = 'private memory'; // the preview refilled it for this chat
    assert.equal(h.clicks.length, 1);
    assert.equal(h.clicks[0].type, 'click');
    assert.equal(h.clicks[0].capture, true, 'SillyTavern’s own handler must find the slot already blank');
    h.click(false);
    assert.equal(h.livePrompts[0].content, 'private memory', 'other controls are untouched');
    assert.equal(h.timers.length, 0);
    h.click(true);
    assert.equal(h.livePrompts[0].content, '');
    assert.equal(h.timers.length, 1);
    assert.equal(h.refreshes(), 0, 'the refill waits until the file has been built');
    h.timers[0]();
    assert.equal(h.refreshes(), 1);
});

test('renaming a preset blanks the slot ahead of the scripted Update, which no click listener can precede', () => {
    const h = guardHarness({ live: [structuredClone(memory)] });
    h.livePrompts[0].content = 'private memory'; // the preview refilled it for this chat
    h.listeners.get('preset-renamed')({ apiId: 'novel', oldName: 'Old', newName: 'New' });
    assert.equal(h.livePrompts[0].content, 'private memory', 'other APIs have no Prompt Manager slot');
    assert.equal(h.invalidations(), 0);
    h.listeners.get('preset-renamed')({ apiId: 'openai', oldName: 'Old', newName: 'New' });
    assert.equal(h.livePrompts[0].content, '');
    assert.equal(h.invalidations(), 1, 'a preview already in flight must not refill the slot before the file is built');
    assert.equal(h.timers.length, 0, 'refilling here would race SillyTavern’s own handler');
    // jQuery's trigger() ends with a native click, and that is what the capture guard sees.
    h.click(true);
    assert.equal(h.timers.length, 1);
});

test('older SillyTavern builds without the preset events still get the click guard', () => {
    const h = guardHarness({ eventTypes: { OAI_PRESET_CHANGED_BEFORE: undefined, OAI_PRESET_CHANGED_AFTER: undefined, OAI_PRESET_IMPORT_READY: undefined, OAI_PRESET_EXPORT_READY: undefined, PRESET_RENAMED: undefined } });
    assert.deepEqual([...h.listeners.keys()], [], 'nothing is left registered against an event name the host lacks');
    assert.equal(h.clicks.length, 1);
});
