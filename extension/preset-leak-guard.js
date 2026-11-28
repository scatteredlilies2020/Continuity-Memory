import { PROMPT_MANAGER_ID } from './prompt-manager-injection.js';

/**
 * SillyTavern saves or exports whatever the live Prompt Manager slot holds.
 * Blank this chat's memory in that copy so only an empty entry can leave the
 * page. Returns whether anything was blanked.
 */
export function blankSavedPromptMemory(prompts) {
    let changed = false;
    for (const prompt of Array.isArray(prompts) ? prompts : []) {
        if (prompt?.identifier === PROMPT_MANAGER_ID && prompt.content) {
            prompt.content = '';
            changed = true;
        }
    }
    return changed;
}

// These two read the live slot and announce nothing an extension can hear.
// Every other preset save emits an event before building its file.
export const UNSAVED_PROMPT_EXPORTS = '#update_oai_preset, #completion_prompt_manager #prompt-manager-export';

export function isUnsavedPromptExport(target) {
    return typeof target?.closest === 'function' && Boolean(target.closest(UNSAVED_PROMPT_EXPORTS));
}
