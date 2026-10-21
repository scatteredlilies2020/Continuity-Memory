import { extractionSchema, chronicleParentSchema } from './extraction-contract.js?v=0.15.0-testing.30';

// Reviews edit proposed content. Source bookkeeping and reconciliation targets
// come from the selected generated candidate and the captured source messages.
export function assertReviewedMemoryContent(value, original, layer = 'Digest') {
    const schema = layer === 'Digest' ? extractionSchema : chronicleParentSchema;
    const fail = path => { throw new Error(`Invalid or protected review field: ${path}. Edit the memory text without changing record targets or source information.`); };
    function visit(rule, current, prior, path) {
        if (rule.type === 'object') {
            if (!current || typeof current !== 'object' || Array.isArray(current)) fail(path);
            if (prior?.targetId && current.targetId !== prior.targetId) fail(`${path}.targetId`);
            if (prior?.targetId) {
                const collection = path.split('[')[0];
                const identities = { entities: ['name', 'type', 'aliases'], facts: ['subject', 'predicate'], states: ['subject', 'attribute'], relationships: ['from', 'to'] };
                for (const key of identities[collection] || []) {
                    if (JSON.stringify(current[key]) !== JSON.stringify(prior[key])) fail(`${path}.${key}`);
                }
            }
            for (const key of ['identityResolutions', 'recordMerges']) {
                if (prior?.[key]?.length && JSON.stringify(current[key]) !== JSON.stringify(prior[key])) fail(key);
            }
            for (const [key, child] of Object.entries(current)) {
                const next = path ? `${path}.${key}` : key;
                if (['identityResolutions', 'recordMerges'].includes(key)) {
                    if (JSON.stringify(child) !== JSON.stringify(prior?.[key])) fail(next);
                } else if (!Object.hasOwn(rule.properties || {}, key)) {
                    if (!prior || !Object.hasOwn(prior, key) || JSON.stringify(child) !== JSON.stringify(prior[key])) fail(next);
                } else if (key !== 'targetId') visit(rule.properties[key], child, prior?.[key], next);
                else if (typeof child !== 'string' || child !== (prior?.targetId || '')) fail(next);
            }
        } else if (rule.type === 'array') {
            if (!Array.isArray(current)) fail(path);
            if (rule.maxItems && current.length > rule.maxItems) fail(path);
            const targets = new Map((Array.isArray(prior) ? prior : []).filter(item => item?.targetId).map(item => [item.targetId, item]));
            current.forEach((item, index) => visit(rule.items, item,
                item?.targetId ? targets.get(item.targetId) : prior?.[index], `${path}[${index}]`));
        } else {
            if (rule.type === 'integer' ? !Number.isInteger(current) : typeof current !== rule.type) fail(path);
            if (rule.enum && !rule.enum.includes(current)) fail(path);
            if (rule.minimum !== undefined && current < rule.minimum) fail(path);
            if (rule.maximum !== undefined && current > rule.maximum) fail(path);
        }
    }
    visit(schema, value, original, '');
    return value;
}
