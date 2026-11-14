import { hasChronicleNarrative } from './chronicle-validation.js';

// Missing/empty chronicleText deliberately selects the intact Digest fallback.
// A supplied malformed value is damage, even when C0 can hide it with fallback.
export function digestNarrativeIssue(record) {
    const value = record?.chronicleText;
    if (value === undefined || value === '' || hasChronicleNarrative(value)) return '';
    return 'Malformed Digest chronicleText: the stored narrative is a single letter, punctuation, or non-text placeholder. Repair this field from intact opening/beats/closing and original RP evidence; do not invent events or pad the value.';
}

export function digestRepairInstruction(record) {
    return `Repair this Digest only: ${record.id} (messages ${record.from}–${record.to}, original zero-based indices). Check its chronicleText and Digest fields against intact stored prose and original RP sources. Repair demonstrable damage, preserve correct details, and do not invent new canon or change unrelated records.`;
}
