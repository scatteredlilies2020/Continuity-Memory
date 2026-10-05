import { createHash } from 'node:crypto';

// Compare memory content, not the instruction preamble or section layout.
// Every detail character, duplicate line and qualifier participates in the
// fingerprint. Event/Chronicle ordering has separate tests.
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
    const lines = prompt.split('\n');
    const start = lines.findIndex(line => headings.has(line));
    if (start < 0) return [];
    const retiredGuide = 'Historical accounts in source order, not a current-status ledger. Plans, conditions, and uncertainty belong to their recorded point; later evidence may supersede them. Preserve character knowledge boundaries when reading across intervals.';
    return lines.slice(start).filter(line => line && !headings.has(line) && line !== retiredGuide && line !== '</continuity>')
        .map(line => line.replace(presentationTag, '- ')).sort();
}
