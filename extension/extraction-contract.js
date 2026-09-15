const temporalRelationSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['frame', 'relation', 'elapsed', 'certainty'],
    properties: {
        frame: { type: 'string' },
        relation: { type: 'string', enum: ['same-period', 'after', 'before', 'overlaps', 'detached', 'unknown'] },
        elapsed: { type: 'string' },
        certainty: { type: 'string', enum: ['explicit', 'implicit', 'unknown'] },
    },
};

export const extractionSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['scene', 'sceneCapsule', 'entities', 'identityResolutions', 'recordMerges', 'facts', 'states', 'relationships', 'events', 'threads', 'backgrounds', 'chronicleEntry'],
    properties: {
        scene: {
            type: 'object', additionalProperties: false,
            required: ['location', 'time', 'participants', 'activity', 'mood'],
            properties: {
                location: { type: 'string' }, time: { type: 'string' }, participants: { type: 'array', items: { type: 'string' } },
                activity: { type: 'string' }, mood: { type: 'string' },
            },
        },
        sceneCapsule: {
            type: 'object', additionalProperties: false,
            required: ['title', 'storyTime', 'location', 'participants', 'opening', 'beats', 'emotionalArc', 'closing', 'importance', 'temporal'],
            properties: {
                title: { type: 'string' }, storyTime: { type: 'string' }, location: { type: 'string' },
                participants: { type: 'array', items: { type: 'string' } }, opening: { type: 'string' },
                beats: { type: 'array', items: { type: 'string' }, maxItems: 10 },
                emotionalArc: { type: 'string' }, closing: { type: 'string' },
                importance: { type: 'integer', minimum: 1, maximum: 5 },
                temporal: temporalRelationSchema,
            },
        },
        entities: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'name', 'type', 'aliases', 'description', 'characterProfile', 'importance'],
                properties: {
                    targetId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } },
                    description: { type: 'string', description: 'Durable description for a non-person entity. Leave empty for a person; characterProfile is validated and formatted into the stored description.' },
                    characterProfile: {
                        type: 'object', additionalProperties: false,
                        required: ['roleBackground', 'ageDemographics', 'appearance', 'personalityQuirks'],
                        properties: {
                            roleBackground: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic established roles, identity-defining history, and durable social functions grammatically attributed to this named person. Never copy a nearby person. Ground in narrative or accepted memory, never status/control-panel fields. Empty when unknown or not a person.' },
                            ageDemographics: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic established age, life-stage, and demographic identity details grammatically attributed to this named person. Never treat age as personality or copy another person. Ground in narrative or accepted memory, never status/control-panel fields. Exclude guesses unless the narrative itself establishes the estimate.' },
                            appearance: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic concise physical traits grammatically attributed to this named person. Never copy another person, an internal reaction, or narrative action. Ground in narrative or accepted memory, never status/control-panel fields. Exclude temporary clothing, wounds, emotion, and pose.' },
                            personalityQuirks: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Atomic established recurring temperament, habits, speech patterns, and quirks grammatically attributed to this named person. Never copy another person or a physical comparison. Ground in narrative or accepted memory, never status/control-panel fields. Exclude one-off reactions.' },
                        },
                    },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
        identityResolutions: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['reference', 'canonical', 'evidence'],
                properties: {
                    reference: { type: 'string' }, canonical: { type: 'string' }, evidence: { type: 'string' },
                },
            },
        },
        recordMerges: {
            type: 'array', maxItems: 20, items: {
                type: 'object', additionalProperties: false,
                required: ['category', 'canonicalId', 'duplicateIds', 'evidence'],
                properties: {
                    category: { type: 'string', enum: ['facts', 'states', 'relationships', 'threads', 'backgrounds'] },
                    canonicalId: { type: 'string' },
                    duplicateIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
                    evidence: { type: 'string' },
                },
            },
        },
        facts: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'subject', 'predicate', 'value', 'category', 'importance', 'persistence'],
                properties: {
                    targetId: { type: 'string' }, subject: { type: 'string' }, predicate: { type: 'string' }, value: { type: 'string' }, category: { type: 'string' },
                    importance: { type: 'integer', minimum: 1, maximum: 5 }, persistence: { type: 'string', enum: ['temporary', 'recurring', 'persistent'] },
                },
            },
        },
        states: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'subject', 'attribute', 'value', 'previous', 'importance', 'scope', 'operation'],
                properties: {
                    targetId: { type: 'string' }, subject: { type: 'string' }, attribute: { type: 'string' }, value: { type: 'string' }, previous: { type: 'string' },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
                    scope: { type: 'string', enum: ['scene', 'ongoing'] },
                    operation: { type: 'string', enum: ['set', 'clear'] },
                },
            },
        },
        relationships: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'from', 'to', 'kind', 'status', 'dynamic', 'importance'],
                properties: {
                    targetId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' },
                    dynamic: { type: 'string' }, importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
        events: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['title', 'summary', 'participants', 'location', 'storyTime', 'consequences', 'importance', 'temporal'],
                properties: {
                    title: { type: 'string' }, summary: { type: 'string' }, participants: { type: 'array', items: { type: 'string' } },
                    location: { type: 'string' }, storyTime: { type: 'string' }, consequences: { type: 'string' },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
                    temporal: temporalRelationSchema,
                },
            },
        },
        threads: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'title', 'detail', 'status', 'participants', 'importance'],
                properties: {
                    targetId: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, status: { type: 'string', enum: ['recorded'] },
                    participants: { type: 'array', items: { type: 'string' } }, importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
        backgrounds: {
            type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['targetId', 'topic', 'summary', 'status', 'certainty', 'participants', 'importance'],
                properties: {
                    targetId: { type: 'string' }, topic: { type: 'string' }, summary: { type: 'string' },
                    status: { type: 'string', enum: ['recorded'] },
                    certainty: { type: 'string', enum: ['confirmed', 'reported', 'rumored', 'uncertain'] },
                    participants: { type: 'array', items: { type: 'string' } },
                    importance: { type: 'integer', minimum: 1, maximum: 5 },
                },
            },
        },
        chronicleEntry: { type: 'string' },
    },
};

const requiredText = {
    entities: ['name', 'type'],
    identityResolutions: ['reference', 'canonical', 'evidence'],
    recordMerges: ['canonicalId', 'evidence'],
    facts: ['subject', 'predicate', 'value', 'category'],
    states: ['subject', 'attribute'],
    relationships: ['from', 'to', 'dynamic'],
    events: ['title', 'summary'],
    threads: ['title', 'detail'],
    backgrounds: ['topic', 'summary'],
};
const nonblank = value => typeof value === 'string' && /\S/u.test(value);
for (const [category, fields] of Object.entries(requiredText)) {
    for (const field of fields) Object.assign(extractionSchema.properties[category].items.properties[field], { minLength: 1, pattern: '\\S' });
}
extractionSchema.properties.states.items.properties.value.description = 'Nonblank supported value for set; empty is allowed only for clear.';
extractionSchema.properties.recordMerges.items.properties.duplicateIds.minItems = 1;

// Definitions, not example records: do not prime the model to copy blank items.
function fieldGuide(schema) {
    if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
    if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, fieldGuide(value)]));
    if (schema.type === 'array') return { arrayOf: fieldGuide(schema.items), emptyArrayAllowed: !schema.minItems, ...(schema.maxItems ? { maxItems: schema.maxItems } : {}) };
    return schema.type + (schema.minimum !== undefined ? ` (${schema.minimum}..${schema.maximum})` : '') + (schema.minLength ? ' (nonblank)' : '') + (schema.description ? ` — ${schema.description}` : '');
}
export const EXTRACTION_FIELD_GUIDE = 'Field definitions (type labels are not values). Return supported values; use [] for categories with no additions or changes.\n' + JSON.stringify(fieldGuide(extractionSchema));

export const EXTRACTION_COMPLETENESS_RULE = `Return complete source-supported records with nonblank identity and core content. Use [] for categories without additions or changes, never blank placeholder records. State set requires a nonblank value; only explicit clear allows an empty value. Unknown or missing values never imply clear. Leave unknown optional details empty; never invent dates, locations, ages, or previous state. Unknown characterProfile groups are []. Preserve distinct supported facts without repeating unchanged records.`;

export function assertCompleteExtractionRecords(result) {
    const problems = [];
    for (const [category, fields] of Object.entries(requiredText)) {
        if (!Array.isArray(result?.[category])) continue; // Shape and legacy migrations are checked by the caller.
        result[category].forEach((record, index) => {
            for (const field of fields) {
                // Legacy relationships can carry their prose as description.
                const value = category === 'relationships' && field === 'dynamic' && record?.dynamic === undefined ? record?.description : record?.[field];
                if (!nonblank(value)) problems.push(`${category}[${index}].${field}`);
            }
            if (category === 'states' && record?.operation !== 'clear' && !nonblank(record?.value)) problems.push(`${category}[${index}].value (set)`);
            if (category === 'recordMerges' && (!Array.isArray(record?.duplicateIds) || !record.duplicateIds.length || !record.duplicateIds.every(nonblank))) problems.push(`${category}[${index}].duplicateIds`);
        });
    }
    if (problems.length) {
        const error = new Error(`Incomplete extraction records: ${problems.slice(0, 16).join(', ')}. Return complete supported records or omit unsupported placeholders; keep valid facts.`);
        error.code = 'CM_INCOMPLETE_RECORDS';
        throw error;
    }
    return result;
}

export function extractionCompletenessFeedback(error) {
    return error?.code === 'CM_INCOMPLETE_RECORDS' ? `\n\nThe previous response was rejected: ${error.message}\n${EXTRACTION_COMPLETENESS_RULE}` : '';
}
