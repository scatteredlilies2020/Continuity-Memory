import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeStructuredCharacterProfiles } from '../extension/reconciliation-policy.js';
import { characterProfileDetailIsAdmissible, canonicalCharacterProfileField } from '../extension/entity-profile.js';

function profile(text, proposed = {}) {
    const entity = { name: 'Meili', type: 'person', characterProfile: proposed };
    const world = { entities: [{ name: 'Meili', type: 'person' }, { name: 'Subaru', type: 'person' }] };
    sanitizeStructuredCharacterProfiles({ entities: [entity] }, world, [{ text }]);
    return entity.profile || {};
}

for (const proposed of [{}, { roleBackground: ["Emilia's knight"] }]) {
    test(`an indirect question cannot assign its embedded role to the speaker (${Object.keys(proposed).length})`, () => {
        assert.deepEqual(profile("Meili tilts her head. She asks Subaru, sweetly, whether he is Emilia's knight. Subaru chokes. He is not a knight.", proposed), {});
    });
}

test('reported and denied propositions cannot validate a proposed biography', () => {
    for (const verb of ['wonders if', 'denies that', 'claims that', 'imagines that']) {
        assert.deepEqual(profile(`Meili ${verb} she is Emilia's knight.`, { roleBackground: ["Emilia's knight"] }), {});
    }
});

test('a direct affirmative role survives but a negated role does not', () => {
    assert.deepEqual(profile('Meili is a guard.').roleBackground, ['guard']);
    assert.deepEqual(profile('Meili is not a guard.', { roleBackground: ['guard'] }), {});
    assert.deepEqual(profile('Meili was never a guard.'), {});
});

test('a subordinate subject cannot become the owner of a derived role', () => {
    assert.deepEqual(profile('Meili watches Subaru because he is a knight.'), {});
});

test('profile shape validation rejects scene debris while retaining useful traits', () => {
    for (const value of ['only one', 'already past the guard of that arm', 'woman on the cot into the same picture']) {
        assert.equal(characterProfileDetailIsAdmissible('roleBackground', value), false);
    }
    assert.equal(characterProfileDetailIsAdmissible('appearance', 'braided hair unspooling sideways as the crystals lance through the space'), false);
    assert.equal(characterProfileDetailIsAdmissible('appearance', 'blue eyes'), true);
    assert.equal(characterProfileDetailIsAdmissible('roleBackground', 'library keeper'), true);
});

function extract(entities, text, stored = []) {
    const result = { entities: structuredClone(entities) };
    sanitizeStructuredCharacterProfiles(result, { entities: stored }, [{ text }]);
    return result.entities;
}

for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
    test(`multi-sentence ${open}${close} dialogue cannot leak into a narrated profile`, () => {
        const entities = extract([
            { name: 'Aria', type: 'person', characterProfile: { roleBackground: ['guest'] } },
            { name: 'Mira', type: 'person', characterProfile: { ageDemographics: ['thirteen'] } },
        ], `Aria pauses. ${open}Mira is thirteen.\nShe is a guest. I meant what I said.${close}`);
        for (const entity of entities) assert.deepEqual(entity.profile || {}, {});
    });
}

test('unclosed dialogue is excluded through the end of the message', () => {
    assert.deepEqual(extract([{ name: 'Aria', type: 'person' }], 'Aria pauses. "Mira is thirteen. She is a guest.')[0].profile || {}, {});
});

test('speech boundaries clear pronoun ownership but retain named narration and possessives', () => {
    const [aria, mira] = extract([
        { name: 'Aria', type: 'person', characterProfile: { appearance: ['green eyes'] } },
        { name: 'Mira', type: 'person', characterProfile: { appearance: ['blue eyes'] } },
    ], `Aria waits. "Mira is a guest." She has green eyes. Mira's eyes are blue.`);
    assert.deepEqual(aria.profile || {}, {});
    assert.deepEqual(mira.profile?.appearance, ['blue eyes']);
});

test('explicit nervous habits survive while momentary nervousness stays out', () => {
    const detail = 'Reties her apron strings as a nervous habit';
    assert.equal(characterProfileDetailIsAdmissible('personalityQuirks', detail), true);
    assert.equal(canonicalCharacterProfileField('personalityQuirks', detail), 'personalityQuirks');
    assert.equal(characterProfileDetailIsAdmissible('personalityQuirks', 'nervous'), false);
    assert.equal(canonicalCharacterProfileField('personalityQuirks', 'angry with a nervous habit'), '');
    const [rem] = extract([{ name: 'Rem', type: 'person', characterProfile: { personalityQuirks: [detail] } }],
        'Rem unties her apron strings and reties them, a small nervous habit.');
    assert.deepEqual(rem.profile?.personalityQuirks, [detail]);
});

test('physical descriptions are not roles and established aliases do not require model repetition', () => {
    const [carter] = extract([
        { name: 'Unnamed carter', type: 'person', characterProfile: { appearance: ['Weathered, with sun-cracked knuckles'] } },
    ], "The carter stands beside his cart. He is a weathered man with sun-cracked knuckles.",
    [{ id: 'carter', name: 'Unnamed carter', type: 'person', aliases: ['the carter'] }]);
    assert.equal(carter.profile?.roleBackground, undefined);
    assert.match(carter.profile?.appearance.join(' '), /weathered/iu);
    assert.match(carter.profile?.appearance.join(' '), /sun-cracked knuckles/iu);
});

test('owner-bound nonhuman body traits and braids survive without admitting possessions', () => {
    const [puck, elsa] = extract([
        { name: 'Puck', type: 'person', characterProfile: { appearance: ['fur', 'ears', 'tail', 'whiskers'] } },
        { name: 'Elsa', type: 'person', characterProfile: { appearance: ['dark eyes', 'braid', 'blue eyes'] } },
    ], "Puck's fur is grey. His ears twitch. His tail curls. His whiskers quiver. Elsa's eyes are dark. Her braid rests on her shoulder. Elsa's carriage carries Mira, whose blue eyes glitter.");
    assert.deepEqual(puck.profile?.appearance, ['fur', 'ears', 'tail', 'whiskers']);
    assert.deepEqual(elsa.profile?.appearance, ['dark eyes', 'braid']);
});

test('scene action objects and hair accessories cannot become biological appearance', () => {
    const [meili] = extract([{ name: 'Meili', type: 'person', characterProfile: { appearance: ['hair ribbon'] } }],
        'Meili sits on the bed. She is sitting beside a bundle — a spare dress, a hair ribbon, a cloth pouch.');
    assert.deepEqual(meili.profile || {}, {});
});

test('capitalized single-word traits are not mistaken for proper names', () => {
    const [puck] = extract([{ name: 'Puck', type: 'person', characterProfile: { appearance: ['Fur', 'Tall'], personalityQuirks: ['Stutters', 'Aria'] } },
        { name: 'Aria', type: 'person' }], 'Puck has fur. He is tall. Puck stutters.');
    assert.deepEqual(puck.profile?.appearance, ['Fur', 'Tall']);
    assert.deepEqual(puck.profile?.personalityQuirks, ['Stutters']);
});

test('authoritative scenario notes and self-introductions keep their narrow evidence role', () => {
    const [aria] = extract([{ name: 'Aria', type: 'person' }], 'OOC: Aria is a court mage.');
    assert.deepEqual(aria.profile?.roleBackground, ['court mage']);
    const [nima] = extract([{ name: 'Nima', type: 'person', characterProfile: { appearance: ['black hair'] } }],
        'A young acolyte arrives. She has black hair. “L-Lady! I’m Nima. I am a knight,” she says.');
    assert.deepEqual(nima.profile?.appearance, ['black hair']);
    assert.equal(nima.profile?.roleBackground, undefined);
});

test('another speaker stuttering cannot contaminate a nearby self-introduction', () => {
    const [nima] = extract([{ name: 'Nima', type: 'person' }],
        '“I’m Nima,” she says. Aria replies, “W-Wait! P-Please!”');
    assert.equal(nima.profile?.personalityQuirks, undefined);
    const [aria] = extract([{ name: 'Aria', type: 'person' }],
        'Aria waits. "Mira stutters. She stumbles randomly."');
    assert.deepEqual(aria.profile || {}, {});
    const [panelOnly] = extract([{ name: 'Nima', type: 'person' }],
        '<stat>\n```\nExample speech = “L-Lady! I’m Nima. P-Please!”\n```\n</stat>');
    assert.deepEqual(panelOnly.profile || {}, {});
});
