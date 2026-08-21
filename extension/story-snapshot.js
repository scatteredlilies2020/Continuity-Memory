export const STORY_SNAPSHOT_SECTIONS = Object.freeze([
    { key: 'premise', label: 'Premise', maxItems: 3, maxLength: 240 },
    { key: 'majorDevelopments', label: 'Major developments', maxItems: 7, maxLength: 240 },
    { key: 'boundaryState', label: 'State at covered boundary', maxItems: 5, maxLength: 220 },
    { key: 'openMatters', label: 'Open matters', maxItems: 5, maxLength: 200 },
]);

export const ROLLING_STORY_SNAPSHOT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: STORY_SNAPSHOT_SECTIONS.map(section => section.key),
    properties: Object.fromEntries(STORY_SNAPSHOT_SECTIONS.map(section => [section.key, {
        type: 'array',
        maxItems: section.maxItems,
        items: { type: 'string', maxLength: section.maxLength },
    }])),
});

export const ROLLING_STORY_SNAPSHOT_EXAMPLE = JSON.stringify(Object.fromEntries(
    STORY_SNAPSHOT_SECTIONS.map(section => [section.key, []]),
));

function compactItem(value, maxLength) {
    const text = String(value || '').replace(/\s+/gu, ' ').trim();
    if (text.length <= maxLength) return text;
    const candidate = text.slice(0, maxLength - 1);
    const boundary = candidate.lastIndexOf(' ');
    return `${candidate.slice(0, boundary > maxLength * 0.65 ? boundary : candidate.length).trim()}…`;
}

export function compileRollingStorySnapshot(value) {
    if (typeof value === 'string') return value.replace(/\s+/gu, ' ').trim();
    if (!value || typeof value !== 'object') return '';
    return STORY_SNAPSHOT_SECTIONS.map(section => {
        const items = (Array.isArray(value[section.key]) ? value[section.key] : [])
            .slice(0, section.maxItems)
            .map(item => compactItem(item, section.maxLength))
            .filter(Boolean);
        return items.length ? `${section.label}: ${items.join('; ')}` : '';
    }).filter(Boolean).join('\n');
}
