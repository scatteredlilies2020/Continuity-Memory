const PROFILE_FIELDS = Object.freeze(['roleBackground', 'appearance', 'personalityQuirks']);

const PROFILE_LABELS = Object.freeze({
    roleBackground: 'Role/background',
    appearance: 'Appearance',
    personalityQuirks: 'Personality/quirks',
});

const TEMPORARY_APPEARANCE = /\b(?:bleed(?:ing)?|blood(?:ied|y)?|bruis(?:e|ed|ing)|clothing|clothes|coat|costume|damp|dirt(?:y)?|dust(?:y|ed|[- ]caked|[- ]streaked)?|exhausted|freshly dressed|grime|injur(?:ed|y)|makeup|mud(?:dy)?|outfit|pose|red(?:dened)? (?:eyes?|wrists?|skin)|robe[sd]?|sweat(?:y|ing)?|tear(?:ful|y|[- ]streaked)|tired|uniform|wearing|weary|wound(?:ed|s)?|split lip)\b/iu;
const DURABLE_APPEARANCE = /\b(?:age[ds]?|bald|beard|build|cheek(?:ed|s)?|complexion|ear[sd]?|eye[sd]?|face|facial|freckle[sd]?|hair|height|horn[sd]?|markings?|moustache|mustache|scar(?:red|s)?|short|skin|species|stature|tall|tattoo(?:ed|s)?|voice|wing[sd]?)\b/iu;
const TEMPORARY_PERSONALITY = /\b(?:adoring|afraid|angry|annoyed|anxious|awed|conflicted|confused|defiant|desperate|distressed|embarrassed|enraged|fearful|frightened|furious|grieving|guilty|happy|hesitant|hopeful|horrified|hostile|jealous|nervous|proud|relieved|resentful|sad|scared|shocked|suspicious|terrified|uncertain|upset|wary|worried)\b/iu;
const DURABLE_BEHAVIOR = /\b(?:always|characteristically|clums(?:y|ily|iness)|devoted|earnest|habit(?:ual|ually|s)?|known for|often|personality|quirk[sy]?|regularly|repeatedly|speech pattern|stammer(?:s|ed|ing)?|stumble(?:s|d|ing)?|stutter(?:s|ed|ing)?|tends? to|trips?|typically|usually)\b/iu;
const DURABLE_ROLE = /\b(?:acolyte|adviser|advisor|agent|apprentice|attendant|background|born|captain|child|commander|council|daughter|doctor|emperor|empress|father|former|formerly|grew up|guard|heir|identity|investigator|Jedi|king|knight|leader|lieutenant|master|member|mentor|minister|mistress|mother|officer|orphan|Padawan|pilot|prince|princess|queen|refugee|role|seneschal|served|service|sister|Sith|soldier|son|student|teacher|title|trained|veteran)\b/iu;
const TRANSIENT_ROLE = /\b(?:attending|bound for|captive|captured|confronting|currently|detained|escorting|grieving|heading to|imprisoned|now|restrained|transporting|under guard|waiting)\b/iu;
const PROFILE_CONTROL_SYNTAX = /[|=]|```|<\/?(?:stat|background_updates)\b|\b(?:Active Threads|Characters|Current Beat|EGO|Emotions|ID|Inventory(?:\s*&\s*Objects)?|Location|Physical State|Positions|Psyche|SUPEREGO|Time\s*&\s*Weather)\s*:/iu;
const CURRENT_ACTION_AS_TRAIT = /^(?:awaiting|complying|defending|escorting|fighting|fleeing|grieving|guarding|heading|investigating|resisting|scrutinizing|studying|surviving|transporting|watching|waiting)\b/iu;

function clean(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function detailKey(value) {
    return clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function characterProfileDetails(value) {
    if (Array.isArray(value)) return value.flatMap(characterProfileDetails);
    return clean(value)
        .split(/\s*(?:,|;|\band\b)\s*/iu)
        .map(part => clean(part).replace(/^[.\-–—:]+|[.\-–—:]+$/gu, ''))
        .filter(Boolean);
}

function uniqueDetails(values) {
    const result = [];
    for (const value of values.flatMap(characterProfileDetails)) {
        const identity = detailKey(value);
        if (!identity) continue;
        const duplicateIndex = result.findIndex(existing => {
            const other = detailKey(existing);
            return other === identity || (identity.length >= 18 && (other.includes(identity) || identity.includes(other)));
        });
        if (duplicateIndex >= 0) {
            if (identity.length > detailKey(result[duplicateIndex]).length) result[duplicateIndex] = value;
            continue;
        }
        result.push(value);
    }
    return result;
}

export function normalizeEntityProfile(value) {
    const source = value && typeof value === 'object' ? value : {};
    const profile = {};
    for (const field of PROFILE_FIELDS) {
        const details = uniqueDetails([source[field]]);
        if (details.length) profile[field] = details;
    }
    return profile;
}

export function parseEntityProfileDescription(value) {
    const source = clean(value);
    if (!source || !/\b(?:Role\/background|Appearance|Personality\/quirks):/iu.test(source)) return {};
    const profile = {};
    const pattern = /(Role\/background|Appearance|Personality\/quirks):\s*([\s\S]*?)(?=\s+(?:Role\/background|Appearance|Personality\/quirks):|$)/giu;
    for (const match of source.matchAll(pattern)) {
        const field = Object.entries(PROFILE_LABELS).find(([, label]) => label.toLocaleLowerCase() === match[1].toLocaleLowerCase())?.[0];
        if (field) profile[field] = characterProfileDetails(match[2]);
    }
    return normalizeEntityProfile(profile);
}

export function entityProfile(value) {
    const typed = normalizeEntityProfile(value?.profile);
    if (Object.keys(typed).length) return typed;
    return parseEntityProfileDescription(value?.description);
}

export function formatEntityProfile(value) {
    const profile = value?.profile || value;
    const normalized = normalizeEntityProfile(profile);
    return PROFILE_FIELDS
        .filter(field => normalized[field]?.length)
        .map(field => `${PROFILE_LABELS[field]}: ${normalized[field].join(', ')}`)
        .join('; ') + (Object.keys(normalized).length ? '.' : '');
}

export function mergeEntityProfiles(priorValue, incomingValue) {
    const prior = entityProfile(priorValue);
    const incoming = entityProfile(incomingValue);
    const merged = {};
    for (const field of PROFILE_FIELDS) {
        const details = uniqueDetails([prior[field], incoming[field]]);
        if (details.length) merged[field] = details;
    }
    return merged;
}

// This gate deliberately decides only whether a detail has the shape of one
// durable profile claim. Semantic meaning remains model-proposed and is checked
// against narrative/canonical evidence by reconciliation-policy.js.
export function characterProfileDetailIsAdmissible(field, detail) {
    const raw = String(detail ?? '');
    const value = clean(raw);
    if (!value || value.length < 2 || value.length > 180 || PROFILE_CONTROL_SYNTAX.test(raw)) return false;
    if (/^(?:unknown|none|n\/a|not established|unrevealed)$/iu.test(value)) return false;
    if (field === 'appearance') return !TEMPORARY_APPEARANCE.test(value);
    if (field === 'roleBackground') {
        return !TRANSIENT_ROLE.test(value) && !TEMPORARY_PERSONALITY.test(value) && !DURABLE_APPEARANCE.test(value);
    }
    if (field !== 'personalityQuirks') return false;
    return !TEMPORARY_PERSONALITY.test(value)
        && !TEMPORARY_APPEARANCE.test(value)
        && !DURABLE_APPEARANCE.test(value)
        && !DURABLE_ROLE.test(value)
        && !CURRENT_ACTION_AS_TRAIT.test(value)
        && !/\bdown for the count\b/iu.test(value);
}

// Model-written profile fields are proposals. This classifier decides which
// grounded details are durable enough to enter the canonical entity profile.
export function durableCharacterProfileDetail(field, detail, evidenceWindows = []) {
    const value = clean(detail);
    if (!characterProfileDetailIsAdmissible(field, detail)) return false;
    if (field === 'appearance') return DURABLE_APPEARANCE.test(value);
    if (field === 'roleBackground') {
        if (DURABLE_ROLE.test(value)) return true;
        const terms = detailKey(value).split(' ').filter(term => term.length >= 3);
        return terms.length > 0 && evidenceWindows.some(window => {
            const source = detailKey(window);
            const detailIdentity = detailKey(value);
            return terms.every(term => source.split(' ').includes(term))
                && ['became', 'born as', 'formerly', 'is', 'is a', 'is an', 'served as', 'trained as', 'was', 'was a', 'was an', 'works as']
                    .some(prefix => source.includes(`${prefix} ${detailIdentity}`));
        });
    }
    if (field !== 'personalityQuirks') return false;
    if (DURABLE_BEHAVIOR.test(value)) return true;
    const terms = detailKey(value).split(' ').filter(term => term.length >= 3);
    if (!terms.length) return false;
    return evidenceWindows.some(window => {
        const source = clean(window);
        const sourceTerms = detailKey(source).split(' ');
        if (!terms.every(term => sourceTerms.includes(term))) return false;
        const sourceKey = detailKey(source);
        const detailIdentity = detailKey(value);
        return /\b(?:is|was|seems?|appears?)\b[^.!?]{0,80}\b(?:by nature|characteristically|habitually|usually|often|always)\b/iu.test(source)
            || /\b(?:personality|temperament|disposition|trait|habit|quirk)\b/iu.test(source)
            || sourceKey.includes(` is ${detailIdentity}`)
            || sourceKey.includes(` was ${detailIdentity}`);
    });
}

export { PROFILE_FIELDS };
