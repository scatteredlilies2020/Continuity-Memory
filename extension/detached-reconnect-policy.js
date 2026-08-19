export function latestCompletedDetachedJob(jobs) {
    return (Array.isArray(jobs) ? jobs : []).find(job => job?.status === 'complete') || null;
}

export function completedDetachedWorldIsNewer(currentWorld, storedWorld, completedJob) {
    if (!completedJob || completedJob.status !== 'complete') return false;
    if (!currentWorld || !storedWorld || currentWorld.id !== storedWorld.id) return false;
    if (completedJob.worldId && completedJob.worldId !== storedWorld.id) return false;
    return Number(storedWorld.revision || 0) > Number(currentWorld.revision || 0);
}
