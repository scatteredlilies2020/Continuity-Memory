/**
 * Prompt Manager also emits completed prompts for UI-only dry runs. Those
 * previews skip generation interceptors, so they contain unreduced history
 * and must never replace the measurement from the last real request.
 */
export function shouldCapturePromptMeasurement(eventData) {
    return eventData?.dryRun !== true;
}
