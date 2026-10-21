// The browser editor only exposes the validated content fields in its descriptor.
export function createMemoryEditForm({ descriptor, onSave, onCancel, document = globalThis.document }) {
    const form = document.createElement('form');
    form.className = 'continuity-memory-edit-form';
    const inputs = [];
    for (const field of descriptor.fields) {
        const label = document.createElement('label');
        label.className = 'continuity-field-row';
        const caption = document.createElement('span');
        caption.textContent = field.label + (field.type === 'list' ? ' · one item per line' : '');
        const input = document.createElement(field.type === 'select' ? 'select' : field.type === 'number' ? 'input' : 'textarea');
        input.className = 'text_pole';
        input.setAttribute('aria-label', field.label);
        if (field.type === 'select') {
            for (const value of [...new Set([String(field.value), ...field.options])]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value || 'Unspecified';
                input.append(option);
            }
        } else if (field.type === 'number') {
            input.type = 'number';
            input.min = '1';
            input.max = '5';
            input.step = '1';
        } else input.rows = field.type === 'list' ? 3 : 2;
        input.value = field.type === 'list' ? field.value.join('\n') : String(field.value);
        inputs.push({ field, input, original: input.value });
        label.append(caption, input);
        form.append(label);
    }
    const error = document.createElement('div');
    error.className = 'continuity-progress continuity-error';
    error.setAttribute('role', 'alert');
    const actions = document.createElement('div');
    actions.className = 'continuity-button-row';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'menu_button continuity-small-button';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'menu_button continuity-small-button';
    cancel.textContent = 'Cancel';
    let saving = false;
    cancel.addEventListener('click', () => { if (!saving) onCancel(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (saving) return;
        const patch = {};
        for (const { field, input, original } of inputs) {
            if (input.value === original) continue;
            patch[field.key] = field.type === 'list' ? input.value.split('\n').map(item => item.trim()).filter(Boolean)
                : field.type === 'number' ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
        }
        saving = true;
        for (const control of [save, cancel, ...inputs.map(item => item.input)]) control.disabled = true;
        error.textContent = '';
        try { await onSave(patch); }
        catch (failure) { error.textContent = failure.message; }
        finally {
            saving = false;
            for (const control of [save, cancel, ...inputs.map(item => item.input)]) control.disabled = false;
        }
    });
    actions.append(save, cancel);
    form.append(error, actions);
    return form;
}
