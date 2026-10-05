// Presentation only: retrieval categories still own their ranking, fair share,
// deduplication and diagnostics. Never summarize or merge record bodies here.
const layouts = new Map([
    ['Checkpoint', ['Current context']],
    ['Addresses', ['Relevant details', 'Address forms']],
    ['User corrections', ['Memory constraints', 'User correction']],
    ['Knowledge boundaries — hard constraints', ['Memory constraints']],
    ['Established character knowledge', ['Relevant details', 'Established character knowledge']],
    ['Recent continuity', ['Relevant details', 'Recent history']],
    ['Supporting memories', ['Relevant details']],
    ['Entities', ['Relevant details', 'Entity profile']],
    ['Current state', ['Current context', 'Current state']],
    ['Last-known ongoing conditions (not reconfirmed)', ['Relevant details']],
    ['Relationships', ['Relevant details', 'Relationship']],
    ['Character perspectives (not established facts)', ['Relevant details']],
    ['Facts', ['Relevant details', 'Fact']],
    ['Past events', ['Relevant details', 'Past event']],
    ['Supporting continuity', ['Relevant details']],
    ['Compact continuity ledger', ['Relevant details']],
]);

export function renderInjectionSections(sections) {
    const groups = new Map(['Memory constraints', 'Current context', 'Relevant details'].map(title => [title, []]));
    for (const { title, rows } of sections) {
        // Unknown future categories retain their label as well as their content.
        const [group, label] = layouts.get(title) || ['Relevant details', title];
        for (const row of rows) {
            if (!row) continue;
            // Existing evidence qualifiers (historical, subjective, last-known,
            // hard limits) already travel with their rows and remain verbatim.
            const rendered = label
                ? row.startsWith('- ') ? `- [${label}] ${row.slice(2)}` : `[${label}] ${row}`
                : row;
            groups.get(group).push(rendered);
        }
    }
    return [...groups].filter(([, rows]) => rows.length)
        .map(([title, rows]) => `\n${title}:\n${rows.map(row => `${row}\n`).join('')}`).join('');
}
