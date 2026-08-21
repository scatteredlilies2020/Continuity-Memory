export const STORY_SNAPSHOT_SECTIONS = Object.freeze([
    { key: 'premise', label: 'Premise' },
    { key: 'majorDevelopments', label: 'Major developments' },
    { key: 'boundaryState', label: 'State at covered boundary' },
    { key: 'openMatters', label: 'Open matters' },
]);

export const ROLLING_STORY_SNAPSHOT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: STORY_SNAPSHOT_SECTIONS.map(section => section.key),
    properties: Object.fromEntries(STORY_SNAPSHOT_SECTIONS.map(section => [section.key, {
        type: 'array',
        items: { type: 'string' },
    }])),
});

export const ROLLING_STORY_SNAPSHOT_EXAMPLE = JSON.stringify(Object.fromEntries(
    STORY_SNAPSHOT_SECTIONS.map(section => [section.key, []]),
));

export function compileRollingStorySnapshot(value) {
    if (typeof value === 'string') return value.replace(/\s+/gu, ' ').trim();
    if (!value || typeof value !== 'object') return '';
    return STORY_SNAPSHOT_SECTIONS.map(section => {
        const items = (Array.isArray(value[section.key]) ? value[section.key] : [])
            .map(item => String(item || '').replace(/\s+/gu, ' ').trim())
            .filter(Boolean);
        return items.length ? `${section.label}: ${items.join('; ')}` : '';
    }).filter(Boolean).join('\n');
}
