import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeStructuredCharacterProfiles } from '../extension/reconciliation-policy.js';
import { characterProfileDetailIsAdmissible } from '../extension/entity-profile.js';

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
