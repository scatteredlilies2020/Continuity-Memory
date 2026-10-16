// The host's preparation diagnostics are optional. Stock SillyTavern does not
// provide the local timing module, so never import that host-only asset here.
export function getGenerationTiming() {
    return globalThis.SillyTavernGenerationTiming?.getGenerationTiming?.() ?? null;
}

export function timeGenerationStep(label, work, trace = getGenerationTiming()) {
    const timing = globalThis.SillyTavernGenerationTiming;
    return typeof timing?.timeGenerationStep === 'function'
        ? timing.timeGenerationStep(label, work, trace)
        : work();
}
