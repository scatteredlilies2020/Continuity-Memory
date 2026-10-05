import { createHash } from 'node:crypto';

// Ignore presentation only. Every other character, duplicate line and qualifier
// participates in the fingerprint. Event/Chronicle ordering has separate tests.
const headings = new Set([
    'Checkpoint', 'Addresses', 'User corrections', 'Knowledge boundaries — hard constraints',
    'Established character knowledge', 'Recent continuity', 'Supporting memories', 'Entities',
    'Current state', 'Last-known ongoing conditions (not reconfirmed)', 'Relationships',
    'Character perspectives (not established facts)', 'Facts', 'Past events',
    'Supporting continuity', 'Compact continuity ledger',
    'Recursive Chronicle layers (complete active frontier)', 'Story so far',
    'Memory constraints', 'Current context', 'Relevant details',
].map(title => `${title}:`));
const presentationTag = /^- \[(?:Address forms|User correction|Established character knowledge|Recent history|Entity profile|Current state|Relationship|Fact|Past event)\] /u;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function injectionEvidence(prompt) {
    return prompt.split('\n').filter(line => line && !headings.has(line))
        .map(line => line.replace(presentationTag, '- ')).sort();
}
