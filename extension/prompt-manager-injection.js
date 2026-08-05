import { PROMPT_MANAGER_SLOTS } from './injection-placement.js';

export const PROMPT_MANAGER_ID = 'continuity_memory_dynamic';

export function configurePromptManagerInjection(manager, settings, content) {
    const slot = PROMPT_MANAGER_SLOTS[settings?.injectionPosition];
    if (!slot || !manager?.activeCharacter) return false;
    const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    if (!Array.isArray(order) || !order.length) return false;

    let prompt = manager.getPromptById(PROMPT_MANAGER_ID);
    if (!prompt) {
        manager.addPrompt({ name: 'Continuity Memory', role: 'user', content: '', system_prompt: false }, PROMPT_MANAGER_ID);
        prompt = manager.getPromptById(PROMPT_MANAGER_ID);
    }
    if (!prompt) return false;

    Object.assign(prompt, {
        name: 'Continuity Memory',
        role: ['system', 'user', 'assistant'].includes(settings.injectionRole) ? settings.injectionRole : 'user',
        content: String(content || ''),
        system_prompt: false,
        marker: false,
        extension: false,
        injection_position: 0,
        injection_depth: 0,
        injection_order: 100,
    });

    for (let index = order.length - 1; index >= 0; index--) {
        if (order[index].identifier === PROMPT_MANAGER_ID) order.splice(index, 1);
    }
    const anchorIndex = order.findIndex(entry => entry.identifier === slot.anchor);
    if (anchorIndex < 0) return false;
    order.splice(anchorIndex + (slot.after ? 1 : 0), 0, { identifier: PROMPT_MANAGER_ID, enabled: true });
    return true;
}

export function clearPromptManagerInjection(manager) {
    const prompt = manager?.getPromptById?.(PROMPT_MANAGER_ID);
    if (prompt) prompt.content = '';
}
