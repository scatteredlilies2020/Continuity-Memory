// Keep a real dropdown and the optional manual model ID in sync. Use native
// controls/events so this works with both upstream and forked SillyTavern UIs.
export function syncModelSelector(input, select, model) {
    if (!input || !select) return;
    const value = String(model || '').trim();
    if (input.value !== value) input.value = value;
    if (value && !Array.from(select.options).some(option => option.value === value)) {
        const option = select.ownerDocument.createElement('option');
        option.value = value;
        option.textContent = value;
        select.append(option);
    }
    select.value = value;
}

export function populateModelSelector(input, select, models, selected) {
    if (!input || !select) return;
    select.replaceChildren();
    for (const model of new Set(models)) {
        const option = select.ownerDocument.createElement('option');
        option.value = model;
        option.textContent = model;
        select.append(option);
    }
    syncModelSelector(input, select, selected);
}

export function bindModelSelector(input, select) {
    if (!input || !select) return;
    select.addEventListener('change', () => {
        input.value = select.value;
        input.dispatchEvent(new input.ownerDocument.defaultView.Event('change', { bubbles: true }));
    });
    input.addEventListener('change', () => syncModelSelector(input, select, input.value));
}
