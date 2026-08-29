function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function contentParts(value) {
    return [
        clean(value?.text || value?.summary),
        ...(value?.turningPoints || []).map(clean),
        clean(value?.emotionalArc),
        clean(value?.closingState),
        ...(value?.openThreads || []).map(clean),
    ].filter(Boolean);
}

export function chronicleContentCharacters(value) {
    return contentParts(value).join(' ').length;
}

export function chronicleCompactionPlan(nodes) {
    const sourceCharacters = (nodes || []).reduce((sum, node) => sum + chronicleContentCharacters(node), 0);
    return {
        sourceCharacters,
        targetCharacters: Math.max(400, Math.floor(sourceCharacters * 0.55)),
    };
}

export function assertChronicleCompaction(result, nodes, label = 'Chronicle') {
    const { sourceCharacters } = chronicleCompactionPlan(nodes);
    const resultCharacters = chronicleContentCharacters(result);
    // Tiny inputs can require slightly more prose merely to form a coherent
    // parent. Normal promotion groups must reduce their combined source text.
    if (sourceCharacters >= 800 && resultCharacters >= sourceCharacters) {
        throw new Error(`${label} parent did not compact its sources (${resultCharacters} >= ${sourceCharacters} characters); rewrite complete thoughts more densely instead of clipping them.`);
    }
    return result;
}

export function chronicleCompactionInstruction(nodes) {
    const { sourceCharacters, targetCharacters } = chronicleCompactionPlan(nodes);
    return `COMPACTION REQUIREMENT: The children contain approximately ${sourceCharacters} narrative characters. Aim for at most ${targetCharacters} characters across the parent's narrative fields by merging redundancy and rewriting complete thoughts more densely. This is a semantic compression target, never permission to omit a load-bearing fact, cut text, end a field mid-thought, or use an ellipsis.`;
}
