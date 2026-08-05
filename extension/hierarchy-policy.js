export function nextArcCapsules(world, settings = {}) {
    if (!['l2', 'l3'].includes(settings.hierarchyMode)) return null;
    const groupSize = Math.max(4, Math.min(200, Math.round(Number(settings.arcGroupSize) || 24)));
    const covered = new Set((world.arcs || []).flatMap(arc => arc.capsuleIds || []));
    const byChat = new Map();
    for (const capsule of world.capsules || []) {
        const chatKey = capsule.chatKey || '';
        if (!byChat.has(chatKey)) byChat.set(chatKey, []);
        byChat.get(chatKey).push(capsule);
    }
    for (const capsules of byChat.values()) {
        capsules.sort((a, b) => Number(a.from ?? 0) - Number(b.from ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        const ungrouped = capsules.filter(capsule => !covered.has(capsule.id));
        if (ungrouped.length < groupSize) continue;
        return ungrouped.slice(0, groupSize);
    }
    return null;
}
