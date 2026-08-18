import assert from 'node:assert/strict';
import test from 'node:test';
import { addressFactIdentity, canonicalFactReference, hasSelfAddressEvidence, mergeAddressValues, removeInvalidAddressFacts, removeInvalidStoredAddressFacts, sanitizeReconciliationMetadata } from '../extension/reconciliation-policy.js';

function extraction() {
    return {
        entities: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [],
        identityResolutions: [], recordMerges: [],
    };
}

test('canonical fact references expose identity metadata needed for safe target reuse', () => {
    assert.deepEqual(canonicalFactReference({
        id: 'fact_schedule', subject: 'Team 7', predicate: 'training and service structure',
        category: 'team operations', persistence: 'recurring', value: `  ${'schedule '.repeat(30)}  `,
    }), {
        targetId: 'fact_schedule', subject: 'Team 7', predicate: 'training and service structure',
        category: 'team operations', persistence: 'recurring', value: 'schedule '.repeat(20),
    });
});

test('unknown model-generated target IDs fail closed without blocking extraction', () => {
    const result = extraction();
    result.threads.push({ targetId: 'thread_invented', title: 'Open the gate' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [],
        threads: [{ id: 'thread_real' }],
    });
    assert.equal(result.threads[0].targetId, '');
    assert.equal(sanitized.ignored, 1);
});

test('valid target IDs survive while unsafe semantic merge directives are discarded', () => {
    const result = extraction();
    result.facts.push({ targetId: 'fact_real', subject: 'Canal', predicate: 'status', category: 'operations' });
    result.recordMerges.push({ category: 'facts', canonicalId: 'fact_real', duplicateIds: ['fact_missing'], evidence: 'Same status.' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], states: [], relationships: [], threads: [],
        facts: [{ id: 'fact_real', subject: 'Canal', predicate: 'status', category: 'operations' }],
    });
    assert.equal(result.facts[0].targetId, 'fact_real');
    assert.deepEqual(result.recordMerges, []);
    assert.equal(sanitized.ignored, 1);
});

test('fact target IDs fail closed when both predicate and category change', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_cleanup', subject: 'Team 7', predicate: 'training and service structure', category: 'team operations',
    });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{ id: 'fact_cleanup', subject: 'Team 7', predicate: 'cleanup responsibility', category: 'accountability' }],
    });
    assert.equal(result.facts[0].targetId, '');
    assert.equal(sanitized.ignored, 1);
});

test('fact target IDs preserve subject, predicate, and category identity', () => {
    const result = extraction();
    result.facts.push({ targetId: 'fact_canal', subject: 'Canal', predicate: 'priority', category: 'infrastructure' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{ id: 'fact_canal', subject: 'North Canal', predicate: 'maintenance objective', category: 'infrastructure' }],
    });
    assert.equal(result.facts[0].targetId, '');
    assert.equal(sanitized.ignored, 1);
});

test('background strands reuse only valid stable target IDs', () => {
    const result = extraction();
    result.backgrounds.push({ targetId: 'background_qing', topic: 'Qing White Lotus suppression' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [],
        backgrounds: [{ id: 'background_qing', topic: 'Qing White Lotus suppression' }],
    });
    assert.equal(result.backgrounds[0].targetId, 'background_qing');
    assert.equal(sanitized.ignored, 0);
});

test('target IDs fail closed across every mutable record identity', () => {
    const result = extraction();
    result.entities.push({ targetId: 'entity_alpha', name: 'Beta' });
    result.states.push({ targetId: 'state_alpha', subject: 'Beta', attribute: 'location' });
    result.relationships.push({ targetId: 'relationship_alpha', from: 'Alpha', to: 'Gamma', kind: 'rivalry' });
    result.threads.push({ targetId: 'thread_alpha', title: 'Investigate the western gate' });
    result.backgrounds.push({ targetId: 'background_alpha', topic: 'Council response to the warehouse incident' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [{ id: 'entity_alpha', name: 'Alpha', aliases: [] }],
        facts: [],
        states: [{ id: 'state_alpha', subject: 'Alpha', attribute: 'location' }],
        relationships: [{ id: 'relationship_alpha', from: 'Alpha', to: 'Beta', kind: 'rivalry' }],
        threads: [{ id: 'thread_alpha', title: 'Repair the northern bridge' }],
        backgrounds: [{ id: 'background_alpha', topic: 'Courier collapse after the mountain crossing' }],
    });

    assert.equal(sanitized.ignored, 5);
    for (const category of ['entities', 'states', 'relationships', 'threads', 'backgrounds']) {
        assert.equal(result[category][0].targetId, '');
    }
});

test('canonical aliases remain compatible with stable entity and subject IDs', () => {
    const result = extraction();
    result.entities.push({ targetId: 'entity_alpha', name: 'Alpha' });
    result.states.push({ targetId: 'state_alpha', subject: 'Alpha', attribute: 'location' });
    result.relationships.push({ targetId: 'relationship_alpha', from: 'Alpha', to: 'Beta', kind: 'alliance' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [
            { id: 'entity_alpha', name: 'Alpha Carter', aliases: ['Alpha'] },
            { id: 'entity_beta', name: 'Beta Evans', aliases: ['Beta'] },
        ],
        facts: [],
        states: [{ id: 'state_alpha', subject: 'Alpha Carter', attribute: 'location' }],
        relationships: [{ id: 'relationship_alpha', from: 'Alpha Carter', to: 'Beta Evans', kind: 'alliance' }],
        threads: [], backgrounds: [],
    });

    assert.equal(sanitized.ignored, 0);
    assert.equal(result.entities[0].targetId, 'entity_alpha');
    assert.equal(result.states[0].targetId, 'state_alpha');
    assert.equal(result.relationships[0].targetId, 'relationship_alpha');
});

test('relationship target IDs are compatible across reversed endpoints and evolving type wording', () => {
    const result = extraction();
    result.relationships.push({
        targetId: 'relationship_toska_nima', from: 'Nima', to: 'Toska',
        kind: 'protective attendant and encouraged senior',
    });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_toska_nima', from: 'Toska', to: 'Nima',
            kind: 'mistress and personal attendant',
        }],
    });

    assert.equal(sanitized.ignored, 0);
    assert.equal(result.relationships[0].targetId, 'relationship_toska_nima');
});

test('entity target IDs require an exact identity and a compatible type family', () => {
    const result = extraction();
    result.entities.push(
        { targetId: 'entity_toska', name: 'Toska’s deceased Jedi Master', type: 'person' },
        { targetId: 'entity_caelen', name: 'Caelen Veyr’s lightsaber', type: 'object' },
        { targetId: 'entity_caelen', name: 'Caelen Veyr', type: 'object' },
        { targetId: 'entity_caelen', name: 'Caelen', type: 'character' },
    );
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [
            { id: 'entity_toska', name: 'Toska', type: 'person', aliases: [] },
            { id: 'entity_caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.deepEqual(result.entities.map(item => item.targetId), ['', '', '', 'entity_caelen']);
    assert.equal(sanitized.ignored, 3);
});

test('explicit duplicate merges also require matching canonical identity', () => {
    const result = extraction();
    result.recordMerges.push({
        category: 'backgrounds', canonicalId: 'background_alpha', duplicateIds: ['background_beta'], evidence: 'Both mention an incident.',
    });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [],
        backgrounds: [
            { id: 'background_alpha', topic: 'Courier collapse after the mountain crossing' },
            { id: 'background_beta', topic: 'Council response to the warehouse incident' },
        ],
    });

    assert.deepEqual(result.recordMerges, []);
    assert.equal(sanitized.ignored, 1);
});

test('missing optional reconciliation arrays are restored for older or non-strict providers', () => {
    const result = extraction();
    delete result.identityResolutions;
    delete result.recordMerges;
    sanitizeReconciliationMetadata(result, { entities: [], facts: [], states: [], relationships: [], threads: [] });
    assert.deepEqual(result.identityResolutions, []);
    assert.deepEqual(result.recordMerges, []);
});

test('explicit concealment becomes a holder-specific knowledge boundary', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Darth Segundus', type: 'person', aliases: [] },
    );
    result.facts.push({
        subject: 'Lucas Alcazar', predicate: 'intent to conceal Toska from Darth Segundus',
        value: 'Toska remains hidden.', category: 'intention', importance: 4, persistence: 'persistent',
    });

    const validation = sanitizeReconciliationMetadata(result, { entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [] });

    assert.equal(validation.recoveredBoundaries, 1);
    assert.deepEqual(result.facts.at(-1), {
        targetId: '', subject: 'Darth Segundus', predicate: 'knowledge of Toska',
        value: 'Toska is deliberately concealed from Darth Segundus; no disclosure to Darth Segundus is established.',
        category: 'knowledge boundary', importance: 4, persistence: 'persistent',
    });
});

test('explicit recognition in structured narrative becomes durable prior knowledge', () => {
    const result = extraction();
    result.entities.push({ name: 'Darth Segundus', type: 'person', aliases: [] });
    result.sceneCapsule = {
        beats: ['Segundus cites the archive’s kill record for Jedi Master Caelen Veyr, while Lucas disputes its classification.'],
    };
    const world = {
        entities: [{ name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };

    const validation = sanitizeReconciliationMetadata(result, world);

    assert.equal(validation.recoveredKnowledge, 1);
    assert.deepEqual(result.facts[0], {
        targetId: '', subject: 'Darth Segundus', predicate: 'knowledge of Caelen Veyr',
        value: 'Darth Segundus cites the archive’s kill record for Jedi Master Caelen Veyr',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
});

test('questions and possessive action objects do not become character knowledge', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas', type: 'person', aliases: [] },
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Instructor Maren', type: 'person', aliases: ['Maren'] },
        { name: 'Commander Vess', type: 'person', aliases: ['Vess'] },
    );
    result.sceneCapsule = { beats: [
        'Lucas asks whether Toska knows her master’s true identity.',
        'Instructor Maren identifies Toska’s improvisational step as the key result.',
        'Toska acknowledges Commander Vess’s announcement.',
    ] };

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.recoveredKnowledge, 0);
    assert.deepEqual(result.facts, []);
});

test('invalid address placeholders are rejected while concurrent forms remain', () => {
    const result = extraction();
    result.facts.push(
        {
            subject: 'Setsuko Uchiha', predicate: 'calls [canonical addressee]',
            value: '[canonical addressee unavailable]', category: 'form of address',
        },
        {
            subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki.',
            value: 'dead last; Uzumaki-kun', category: 'form of address',
        },
        {
            subject: 'Archive', predicate: 'display label',
            value: '[REDACTED]', category: 'metadata',
        },
    );

    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(sanitized.ignored, 1);
    assert.deepEqual(result.facts.map(item => item.value), ['dead last; Uzumaki-kun', '[REDACTED]']);
});

test('stored malformed address placeholders can be removed without touching valid facts', () => {
    const world = {
        facts: [
            { subject: 'Setsuko Uchiha', predicate: 'calls [canonical addressee]', value: '[canonical addressee unavailable]', category: 'form of address' },
            { subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki.', value: 'Uzumaki-kun', category: 'form of address' },
        ],
    };

    assert.equal(removeInvalidAddressFacts(world), 1);
    assert.equal(world.facts[0].value, 'Uzumaki-kun');
});

test('symbol-only model output cannot become an address form', () => {
    const result = extraction();
    for (const value of ['[', ']', '...', '*', '{}', '""', '—']) result.facts.push({
        subject: 'Kakashi Hatake', predicate: 'calls Setsuko Uchiha', value, category: 'form of address',
    });
    result.facts.push(
        { subject: 'Kakashi Hatake', predicate: 'calls Setsuko Uchiha', value: 'Setsuko', category: 'form of address' },
        { subject: 'Kakashi Hatake', predicate: 'calls Naruto Uzumaki', value: 'ナルト', category: 'form of address' },
        { subject: 'Kakashi Hatake', predicate: 'calls Kurama', value: '🦊', category: 'form of address' },
    );

    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(sanitized.ignored, 7);
    assert.deepEqual(result.facts.map(item => item.value), ['Setsuko', 'ナルト', '🦊']);
});

test('ordinary pronouns cannot become address forms or displace a stored nickname', () => {
    const result = extraction();
    result.facts.push(
        {
            targetId: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
            value: 'you', category: 'form of address', importance: 1, persistence: 'recurring',
        },
        {
            targetId: '', subject: 'Sakura Haruno', predicate: 'calls Setsuko Uchiha',
            value: 'Pinky; you', category: 'form of address', importance: 2, persistence: 'recurring',
        },
    );
    const world = {
        entities: [], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{
            id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
            value: 'Suki-chan', category: 'form of address',
        }],
    };

    const sanitized = sanitizeReconciliationMetadata(result, world, [
        { index: 246, name: 'Naruto', text: '"You reacted, so I kept teasing. Sorry," Naruto says before changing the subject.' },
        { index: 247, name: 'Setsuko', text: '"My pay, you want to know?" I ask Naruto.' },
        { index: 248, name: 'Sakura Haruno', isUser: true, text: '"Pinky, wait a second."' },
    ]);

    assert.equal(sanitized.ignored, 2);
    assert.deepEqual(result.facts, [{
        targetId: '', subject: 'Sakura Haruno', predicate: 'calls Setsuko Uchiha',
        value: 'Pinky', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
    assert.equal(world.facts[0].value, 'Suki-chan');
});

test('an explicitly meaningful disrespectful pronoun remains a valid address form', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'you', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };

    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 12,
        name: 'Narrator',
        text: 'Naruto Uzumaki deliberately calls Setsuko Uchiha “you” as a show of contempt and refuses to use her name.',
    }]);

    assert.equal(sanitized.discardedPronounAddresses, 0);
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].value, 'you');
});

test('stored malformed address placeholders are also removed from replay history', () => {
    const malformed = { subject: 'Setsuko Uchiha', predicate: 'calls [canonical addressee]', value: '[canonical addressee unavailable]', category: 'form of address' };
    const world = { facts: [structuredClone(malformed)], extractions: [{ result: { facts: [structuredClone(malformed)] } }] };
    assert.equal(removeInvalidStoredAddressFacts(world), 2);
    assert.deepEqual(world.facts, []);
    assert.deepEqual(world.extractions[0].result.facts, []);
});

test('stored generic address duplicates are removed from canonical and replay memory', () => {
    const directional = {
        subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno', value: 'Pinky', category: 'form of address',
        temporalAnchorId: 'L1-test-16-23', sources: [{ chatKey: 'chat', from: 16, to: 23 }],
    };
    const generic = {
        subject: 'Setsuko Uchiha', predicate: 'uses the address', value: 'Pinky', category: 'social address',
        temporalAnchorId: 'L1-test-16-23', sources: [{ chatKey: 'chat', from: 16, to: 23 }],
    };
    const world = {
        entities: [], facts: [structuredClone(directional), structuredClone(generic)],
        extractions: [{ result: { facts: [structuredClone(directional), structuredClone(generic)] } }],
    };

    assert.equal(removeInvalidStoredAddressFacts(world), 2);
    assert.deepEqual(world.facts, [directional]);
    assert.deepEqual(world.extractions[0].result.facts, [directional]);
});

test('authoritative address corrections purge superseded replay facts', () => {
    const bad = {
        targetId: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'dead last', category: 'addressing',
    };
    const world = {
        entities: [],
        facts: [{ id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Suki-chan', category: 'form of address' }],
        corrections: [{ operations: [{ action: 'update', category: 'facts', beforeSelector: 'naruto uzumaki|setsuko uchiha' }] }],
        extractions: [{ result: { facts: [structuredClone(bad)] } }],
    };

    assert.equal(removeInvalidStoredAddressFacts(world), 2);
    assert.deepEqual(world.extractions[0].result.facts, []);
    assert.equal(world.facts[0].value, 'Suki-chan');
});

test('legacy and current address predicates share one directional identity', () => {
    assert.equal(
        addressFactIdentity({ subject: 'Setsuko Uchiha', predicate: 'form of address for Naruto Uzumaki', category: 'social address' }),
        addressFactIdentity({ subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki.', category: 'forms of address' }),
    );
    assert.equal(mergeAddressValues('Uzumaki-kun; Uzumaki-san', '“dead last”; Uzumaki-kun'), 'Uzumaki-kun; Uzumaki-san; dead last');
});

test('generic social-address duplicates fold into one unambiguous directional fact', () => {
    const result = extraction();
    result.facts.push(
        { subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno', value: 'Pinky', category: 'form of address', importance: 2, persistence: 'recurring' },
        { subject: 'Setsuko Uchiha', predicate: 'uses the address', value: 'Pinky', category: 'social address', importance: 2, persistence: 'recurring' },
    );
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(sanitized.reconciledAddresses, 1);
    assert.deepEqual(result.facts, [{
        subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno', value: 'Pinky', category: 'form of address',
        importance: 2, persistence: 'recurring', sources: [], targetId: '',
    }]);
});

test('generic social-address records remain when their addressee is ambiguous', () => {
    const result = extraction();
    result.facts.push(
        { subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno', value: 'Pinky', category: 'form of address' },
        { subject: 'Setsuko Uchiha', predicate: 'calls Ino Yamanaka', value: 'Pinky', category: 'form of address' },
        { subject: 'Setsuko Uchiha', predicate: 'uses the address', value: 'Pinky', category: 'social address' },
    );
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(sanitized.reconciledAddresses, 0);
    assert.equal(result.facts.length, 3);
});

test('address target IDs cannot reverse the speaker and addressee', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_suki', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki',
        value: 'dead last', category: 'form of address',
    });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{
            id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
            value: 'Suki-chan', category: 'form of address',
        }],
    });
    assert.equal(result.facts[0].targetId, '');
    assert.equal(sanitized.ignored, 1);
});

test('direct source speech repairs a cross-person address reversal', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'dead last', category: 'addressing', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [
            { id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Suki-chan', category: 'form of address' },
            { id: 'fact_dead_last', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'Uzumaki-san', category: 'form of address' },
        ],
        states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 239,
        name: 'Setsuko',
        isUser: true,
        text: 'I elbow him. "G-go buy your own, dead last." I say and protect the sweets.',
    }]);

    assert.equal(sanitized.repairedAddresses, 1);
    assert.deepEqual(result.facts, [{
        targetId: 'fact_dead_last', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki',
        value: 'dead last', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
});

test('a user-authored vocative repairs a reversal without first-person narration', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_idiot', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'idiot', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [
        { index: 225, name: 'Setsuko', isUser: true, text: '"Me? Why ask, everyone ate here at some point, idiot' },
        { index: 226, name: 'Naruto', isUser: false, text: '"I’m not an idiot," Naruto protests.' },
    ]);

    assert.equal(sanitized.repairedAddresses, 1);
    assert.deepEqual(result.facts, [{
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki',
        value: 'idiot', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
});

test('an address value matching its alleged speaker is rejected without an explicit directional statement', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Alice Carter', predicate: 'calls Bob Evans',
        value: 'Alice', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Alice Carter', aliases: ['Alice'] },
            { name: 'Bob Evans', aliases: ['Bob'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 4, name: 'Alice', isUser: false,
        text: 'Bob checks the list. “Alice, are you ready?” Alice nods.',
    }]);

    assert.equal(sanitized.discardedUnsupportedAddresses, 1);
    assert.deepEqual(result.facts, []);
});

test('stored reversed address facts are repaired from their anchored source range', () => {
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [{
            id: 'fact_idiot', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'idiot',
            category: 'form of address', temporalAnchorId: 'L1-0399d9d5-224-231',
        }],
        extractions: [], corrections: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const changed = removeInvalidStoredAddressFacts(world, [
        { index: 30, name: 'Naruto', isUser: false, text: 'Naruto calls someone else an idiot.' },
        { index: 225, name: 'Setsuko', isUser: true, text: '"Me? Why ask, everyone ate here at some point, idiot' },
        { index: 226, name: 'Naruto', isUser: false, text: '"I’m not an idiot," Naruto protests.' },
    ]);

    assert.equal(changed, 1);
    assert.deepEqual(world.facts[0], {
        id: 'fact_idiot', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'idiot',
        category: 'form of address', temporalAnchorId: 'L1-0399d9d5-224-231',
    });
});

test('stored address records recover supported alternate forms retained in replay history', () => {
    const world = {
        entities: [
            { name: 'Alice Carter', aliases: ['Alice'] },
            { name: 'Bob Evans', aliases: ['Bob'] },
        ],
        facts: [{
            id: 'fact_address', subject: 'Alice Carter', predicate: 'calls Bob Evans', value: 'Show-off',
            category: 'form of address', temporalAnchorId: 'L1-test-8-15',
        }],
        extractions: [
            { from: 0, to: 7, result: { facts: [{ subject: 'Alice Carter', predicate: 'calls Bob Evans', value: 'Captain', category: 'form of address' }] } },
            { from: 8, to: 15, result: { facts: [{ subject: 'Alice Carter', predicate: 'calls Bob Evans', value: 'Show-off', category: 'form of address' }] } },
        ],
        corrections: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const messages = [
        { index: 2, name: 'Alice', isUser: true, text: 'Captain, take the bridge.' },
        { index: 10, name: 'Alice', isUser: true, text: 'Nice landing, Show-off.' },
    ];

    const changed = removeInvalidStoredAddressFacts(world, messages);

    assert.equal(changed, 1);
    assert.equal(world.facts[0].value, 'Show-off; Captain');
});

test('explicit attribution preserves a correctly directed address fact', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 7,
        name: 'Setsuko Uchiha',
        text: 'Naruto Uzumaki calls Setsuko "Suki-chan," and she objects.',
    }]);

    assert.equal(sanitized.repairedAddresses, 0);
    assert.equal(result.facts[0].subject, 'Naruto Uzumaki');
});

test('ambiguous short speaker names do not trigger an address reversal', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'dead last', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: [] },
            { name: 'Setsuko Senju', aliases: [] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 9,
        name: 'Setsuko',
        text: '"Buy your own, dead last," I say.',
    }]);

    assert.equal(sanitized.repairedAddresses, 0);
    assert.equal(result.facts[0].subject, 'Naruto Uzumaki');
});

test('a later range cannot copy an opposite-direction address value', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan; idiot', category: 'form of address', importance: 3, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [
            { id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Suki-chan', category: 'form of address' },
            { id: 'fact_idiot', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'idiot', category: 'form of address' },
        ],
        beliefs: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 24,
        name: 'Naruto',
        text: 'Naruto discusses the survival exercise without using either nickname.',
    }]);

    assert.equal(sanitized.discardedAddressValues, 1);
    assert.equal(sanitized.discardedUnsupportedAddresses, 1);
    assert.deepEqual(result.facts, []);
});

test('a narrated user quote cannot contaminate the opposite address direction', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan; loser', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [
            { id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Suki-chan', category: 'form of address' },
            { id: 'fact_loser', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'loser', category: 'form of address' },
        ],
        beliefs: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [
        { index: 10, name: 'Setsuko', isUser: true, text: 'I hit his head. "Shut up, loser."' },
        { index: 11, name: 'Naruto', isUser: false, text: '"Shut up, loser," Setsuko says. Naruto winces. "Order your lunch, Suki-chan."' },
    ]);

    assert.equal(sanitized.repairedAddresses, 1);
    assert.deepEqual(result.facts.map(item => [item.subject, item.predicate, item.value]), [
        ['Naruto Uzumaki', 'calls Setsuko Uchiha', 'Suki-chan'],
    ]);
});

test('an unambiguous short character name attributes an echoed quote without a stored alias', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_loser', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki',
        value: 'loser', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: [] },
            { name: 'Naruto Uzumaki', aliases: [] },
            { name: "Setsuko's Friday schedule", aliases: [] },
        ],
        facts: [
            { id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Suki-chan', category: 'form of address' },
            { id: 'fact_loser', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'loser', category: 'form of address' },
        ],
        states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 360, name: 'Naruto', isUser: false,
        text: '“Shut up, loser. I did not say it like that,” Setsuko says. Naruto protests.',
    }]);

    assert.equal(sanitized.repairedAddresses, 0);
    assert.deepEqual(result.facts, [{
        targetId: 'fact_loser', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki',
        value: 'loser', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
});

test('a markdown speaker label with its colon inside bold markup preserves direction', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno',
        value: 'Suki', category: 'social address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: [] },
            { name: 'Sakura Haruno', aliases: [] },
            { name: 'Naruto Uzumaki', aliases: [] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 0, name: 'Naruto', isUser: false,
        text: '**Sakura:** Flips her pink hair. “Just because everyone follows you does not make you special, Suki.”',
    }]);

    assert.equal(sanitized.repairedAddresses, 1);
    assert.deepEqual(result.facts, [{
        targetId: '', subject: 'Sakura Haruno', predicate: 'calls Setsuko Uchiha',
        value: 'Suki', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
});

test('a verbose directional social-address fact is normalized for address injection', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'uses respectful address toward Iruka Umino',
        value: 'Current form: "Iruka-sensei"; "Sensei".', category: 'social address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: [] },
            { name: 'Iruka Umino', aliases: [] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 0, name: 'Setsuko', isUser: true, text: '"Ah... Iruka-sensei, yes, sir we passed as a team."',
    }]);

    assert.equal(sanitized.normalizedAddresses, 1);
    assert.deepEqual(result.facts, [{
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Iruka Umino',
        value: 'Iruka-sensei; Sensei', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
});

test('a first-person tell cue repairs a surname-honorific reversal echoed by narration', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_loser', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Uzumaki-kun', category: 'social address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [
            { id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Suki-chan', category: 'form of address' },
            { id: 'fact_loser', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'loser', category: 'form of address' },
        ],
        states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [
        { index: 445, name: 'Setsuko', isUser: true, text: 'I tell Uzumaki-kun his control sucks' },
        { index: 446, name: 'Naruto', isUser: false, text: '“Uzumaki-kun.” Setsuko\'s voice carries the flat, final tone of a diagnosis. “Your control sucks.” Naruto freezes.' },
    ]);

    assert.equal(sanitized.repairedAddresses, 1);
    assert.deepEqual(result.facts, [{
        targetId: 'fact_loser', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki',
        value: 'Uzumaki-kun', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
});

test('an honorific derived from the alleged speaker name fails closed without directional evidence', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Uzumaki-kun', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 5, name: 'Narrator', isUser: false, text: 'The disputed transcript contains “Uzumaki-kun.”',
    }]);

    assert.equal(sanitized.discardedUnsupportedAddresses, 1);
    assert.deepEqual(result.facts, []);
});

test('sentence clauses cannot become address forms', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Kakashi Hatake',
        value: "sensei; He's not too tough.; It's bleeding", category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Kakashi Hatake', aliases: ['Kakashi'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 12, name: 'Setsuko', isUser: true,
        text: '"Sensei, it is bleeding." I look at Kakashi. "Oh me? He\'s not too tough."',
    }]);

    assert.equal(sanitized.ignored, 2);
    assert.equal(result.facts[0].value, 'sensei');
});

test('the first range cannot create the same address form in both directions from an echoed nickname', () => {
    const result = extraction();
    result.facts.push(
        {
            targetId: '', subject: 'Sakura Haruno', predicate: 'calls Setsuko Uchiha',
            value: 'Pinky', category: 'form of address', importance: 2, persistence: 'recurring',
        },
        {
            targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno',
            value: 'Pinky', category: 'form of address', importance: 2, persistence: 'recurring',
        },
    );
    const world = {
        entities: [
            { name: 'Sakura Haruno', aliases: ['Sakura'] },
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [
        {
            index: 20,
            name: 'Setsuko',
            isUser: true,
            text: '"Hmph, as if test scores matter. Pinky." I then look at Kakashi.',
        },
        {
            index: 21,
            name: 'Naruto',
            isUser: false,
            text: 'Setsuko dismisses Sakura with a derisive sound. “Hmph, as if test scores matter. Pinky.” Sakura gasps. “P-Pinky?!”',
        },
    ]);

    assert.equal(sanitized.repairedAddresses, 1);
    assert.equal(sanitized.discardedAddressValues, 0);
    assert.deepEqual(result.facts.map(item => [item.subject, item.predicate, item.value]), [
        ['Setsuko Uchiha', 'calls Sakura Haruno', 'Pinky'],
    ]);
});

test('same-range contamination filtering compares opposite directions emitted together', () => {
    const result = extraction();
    result.facts.push(
        {
            targetId: '', subject: 'Sakura Haruno', predicate: 'calls Setsuko Uchiha',
            value: 'Pinky', category: 'form of address', importance: 2, persistence: 'recurring',
        },
        {
            targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno',
            value: 'Pinky', category: 'form of address', importance: 2, persistence: 'recurring',
        },
    );
    const world = {
        entities: [
            { name: 'Sakura Haruno', aliases: ['Sakura'] },
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [
        {
            index: 20,
            name: 'Setsuko',
            isUser: true,
            text: '"Hmph, as if test scores matter. Pinky." I then look away.',
        },
        {
            index: 21,
            name: 'Narrator',
            isUser: false,
            text: 'Sakura says “Pinky?” in disbelief.',
        },
    ]);

    assert.equal(sanitized.repairedAddresses, 1);
    assert.equal(sanitized.discardedAddressValues, 0);
    assert.deepEqual(result.facts.map(item => [item.subject, item.predicate, item.value]), [
        ['Setsuko Uchiha', 'calls Sakura Haruno', 'Pinky'],
    ]);
});

test('direct new speech may establish the same form in both directions', () => {
    const result = extraction();
    result.facts.push({
        targetId: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan; idiot', category: 'form of address', importance: 3, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [
            { id: 'fact_suki', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha', value: 'Suki-chan', category: 'form of address' },
            { id: 'fact_idiot', subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki', value: 'idiot', category: 'form of address' },
        ],
        beliefs: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 32,
        name: 'Narrator',
        text: 'Naruto Uzumaki calls Setsuko Uchiha “idiot” during their argument.',
    }]);

    assert.equal(sanitized.discardedAddressValues, 0);
    assert.equal(result.facts[0].value, 'idiot');
});

test('self-address falsely inferred from another speaker is rejected', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan', category: 'form of address',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Naruto Uzumaki', aliases: ['Naruto'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };
    const messages = [{
        index: 7,
        name: 'Naruto Uzumaki',
        text: 'Naruto grins. “Suki-chan!” he calls while Setsuko Uchiha rolls her eyes.',
    }];

    const sanitized = sanitizeReconciliationMetadata(result, world, messages);

    assert.deepEqual(result.facts, []);
    assert.equal(sanitized.ignored, 1);
});

test('legitimate first-person self-address remains valid', () => {
    const authored = {
        subject: 'Setsuko Uchiha', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan', category: 'form of address',
    };
    const narrated = {
        subject: 'Setsuko Uchiha', predicate: 'calls Setsuko Uchiha',
        value: 'Suki', category: 'form of address',
    };
    const world = {
        entities: [{ name: 'Setsuko Uchiha', aliases: ['Setsuko'] }],
    };

    assert.equal(hasSelfAddressEvidence(authored, [{
        name: 'Setsuko', text: '“Suki-chan will handle it,” I say, referring to myself.',
    }], world), true);
    assert.equal(hasSelfAddressEvidence(narrated, [{
        name: 'Narrator', text: 'Setsuko Uchiha says, “Suki will take the first watch.”',
    }], world), true);
    assert.equal(hasSelfAddressEvidence(authored, [{
        name: 'Setsuko', text: 'I watch Naruto grin. “Suki-chan!” he calls from the doorway.',
    }], world), false);
});

test('normal speaker-to-addressee address is retained when direct speech supports it', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan', category: 'form of address',
    });

    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'Naruto Uzumaki says, “Hey, Suki-chan!”' }]);

    assert.equal(result.facts.length, 1);
    assert.equal(sanitized.ignored, 0);
});

test('ranks and roles require vocative use rather than descriptive mention', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Kakashi Hatake',
        value: 'Jonin; sensei', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [
            { name: 'Setsuko Uchiha', aliases: ['Setsuko'] },
            { name: 'Kakashi Hatake', aliases: ['Kakashi'] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };

    const sanitized = sanitizeReconciliationMetadata(result, world, [
        {
            index: 3,
            name: 'Setsuko',
            isUser: true,
            text: '“Hmph. Tough talk for a Jonin who was late for their appointment.” I look him in the eyes.',
        },
        {
            index: 13,
            name: 'Setsuko',
            isUser: true,
            text: '“Hmph. That is not just for performance, sensei.”',
        },
    ]);

    assert.equal(sanitized.discardedUnsupportedAddresses, 1);
    assert.equal(result.facts[0].value, 'sensei');
});

test('a title used at the start of direct speech remains a valid address', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Operator', predicate: 'calls Team Leader',
        value: 'Captain', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [{ name: 'Operator', aliases: [] }, { name: 'Team Leader', aliases: [] }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };

    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 4,
        name: 'Operator',
        isUser: true,
        text: '“Captain, the northern relay is ready.”',
    }]);

    assert.equal(sanitized.discardedUnsupportedAddresses, 0);
    assert.equal(result.facts[0].value, 'Captain');
});

test('unquoted user dialogue can establish a direct address', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Technician', predicate: 'calls Supervisor',
        value: 'Chief', category: 'form of address', importance: 2, persistence: 'recurring',
    });
    const world = {
        entities: [{ name: 'Technician', aliases: [] }, { name: 'Supervisor', aliases: [] }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    };

    const sanitized = sanitizeReconciliationMetadata(result, world, [{
        index: 5, name: 'Technician', isUser: true, text: 'Chief, the diagnostics are complete.',
    }]);

    assert.equal(sanitized.discardedUnsupportedAddresses, 0);
    assert.equal(result.facts[0].value, 'Chief');
});

test('corroborated explicit address omitted from facts is recovered from structured continuity', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Setsuko Uchiha', aliases: [] },
        { name: 'Sakura Haruno', aliases: [] },
    );
    result.sceneCapsule = {
        beats: ['Setsuko dismisses Sakura as “Pinky” and declares that she will pass.'],
    };
    result.relationships.push({
        from: 'Sakura Haruno', to: 'Setsuko Uchiha',
        dynamic: 'Sakura resents Setsuko after being called “Pinky.”',
    });
    const messages = [{
        index: 19, name: 'Setsuko',
        text: '“Hmph, as if test scores matter. Pinky.” I then look at Kakashi.',
    }];

    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, messages);

    assert.equal(sanitized.recovered, 1);
    assert.deepEqual(result.facts, [{
        targetId: '', subject: 'Setsuko Uchiha', predicate: 'calls Sakura Haruno',
        value: 'Pinky', category: 'form of address', importance: 2, persistence: 'recurring',
    }]);
});

test('uncorroborated quoted wording is not promoted into an address fact', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Setsuko Uchiha', aliases: [] },
        { name: 'Sakura Haruno', aliases: [] },
    );
    result.sceneCapsule = { beats: ['Setsuko dismisses Sakura as “Pinky” and leaves.'] };

    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Setsuko', text: 'Pinky.' }]);

    assert.equal(sanitized.recovered, 0);
    assert.deepEqual(result.facts, []);
});

test('corroborated explicit aliases are recovered without another model call', () => {
    const result = extraction();
    result.entities.push({ name: 'Kakashi Hatake', aliases: [] });
    result.sceneCapsule = { beats: ['Kakashi Hatake is also known as “Copy Ninja.”'] };
    result.backgrounds.push({ summary: 'Kakashi’s “Copy Ninja” alias remains widely recognized.' });

    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'Kakashi is known throughout the nations as the Copy Ninja.' }]);

    assert.equal(sanitized.recoveredAliases, 1);
    assert.deepEqual(result.entities[0].aliases, ['Copy Ninja']);
});

test('source-supported durable L1 commitments become open threads without another model call', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['Alice vows to protect the northern bridge permanently.'] };
    const messages = [{ name: 'Alice', text: 'I vow to protect the northern bridge permanently.' }];

    const missing = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, messages);
    assert.equal(missing.recoveredCoverage, 1);
    assert.deepEqual(missing.warnings, []);
    assert.deepEqual(result.threads, [{
        targetId: '', title: 'Alice vows to protect the northern bridge permanently.',
        detail: 'Alice vows to protect the northern bridge permanently.', status: 'open',
        participants: ['Alice'], importance: 4,
    }]);
});

test('coverage recovery refuses a summary that disagrees with the raw action', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['Alice vows to destroy the northern bridge permanently.'] };

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Alice', text: 'I vow to protect the northern bridge permanently.' }]);

    assert.equal(validation.recoveredCoverage, 0);
    assert.equal(validation.warnings.length, 1);
    assert.deepEqual(result.threads, []);
});

test('questions about a possible loss do not become durable events', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['Lucas asks whether Toska lost her lightsaber.'] };

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Lucas', text: 'Did you lose your lightsaber?' }]);

    assert.equal(validation.recoveredCoverage, 0);
    assert.deepEqual(validation.warnings, []);
    assert.deepEqual(result.events, []);
});

test('source-supported relationship omissions become relationship records', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Alice', type: 'person', aliases: [] },
        { name: 'Bob', type: 'person', aliases: [] },
    );
    result.sceneCapsule = { beats: ['Alice and Bob became allies after the battle.'] };

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'After the battle, Alice and Bob became allies.' }]);

    assert.equal(validation.recoveredCoverage, 1);
    assert.deepEqual(validation.warnings, []);
    assert.deepEqual(result.relationships.at(-1), {
        targetId: '', from: 'Alice', to: 'Bob', kind: 'allies', status: 'active',
        dynamic: 'Alice and Bob became allies after the battle.', importance: 4,
    });
});

test('an explicit durable former-student fact recovers its missing relationship', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
        { name: 'Toska', type: 'person', aliases: [] },
    );
    result.facts.push({
        targetId: '', subject: 'Caelen Veyr', predicate: 'prior apprenticeship',
        value: 'Lucas Alcazar identifies himself as Caelen Veyr’s former apprentice; Caelen trained him in theory and diplomacy.',
        category: 'background', importance: 4, persistence: 'persistent',
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Lucas Alcazar', text: 'Lucas Alcazar was Caelen Veyr’s former apprentice and trained under him before the Order fell.',
    }]);

    assert.equal(validation.recoveredFactRelationships, 1);
    assert.equal(validation.recoveredCoverage, 1);
    assert.deepEqual(result.relationships, [{
        targetId: '', from: 'Caelen Veyr', to: 'Lucas Alcazar', kind: 'master and apprentice', status: 'ended',
        dynamic: 'Lucas Alcazar identifies himself as Caelen Veyr’s former apprentice; Caelen trained him in theory and diplomacy.',
        importance: 4,
    }]);
});

test('beliefs, uncertain claims, and facts naming several people do not synthesize relationships', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Alice', type: 'person', aliases: [] },
        { name: 'Bob', type: 'person', aliases: [] },
        { name: 'Carol', type: 'person', aliases: [] },
    );
    result.facts.push(
        {
            targetId: '', subject: 'Alice', predicate: 'belief about Bob',
            value: 'Alice believes Bob might be her former mentor.', category: 'character belief',
            importance: 3, persistence: 'persistent',
        },
        {
            targetId: '', subject: 'Alice', predicate: 'training history',
            value: 'Alice, Bob, and Carol were students at the same academy.', category: 'background',
            importance: 3, persistence: 'persistent',
        },
    );
    result.sceneCapsule = { beats: [
        'Alice believes Bob might be her former mentor.',
        'Alice, Bob, and Carol were students at the same academy.',
    ] };

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.recoveredFactRelationships, 0);
    assert.deepEqual(result.relationships, []);
});

test('fact relationship recovery updates one stored pair and preserves its prior description', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Alice', type: 'person', aliases: [] },
        { name: 'Bob', type: 'person', aliases: [] },
    );
    result.facts.push({
        targetId: '', subject: 'Alice', predicate: 'training history',
        value: 'Alice was Bob’s former mentor during the winter campaign.', category: 'background',
        importance: 4, persistence: 'persistent',
    });
    const world = {
        entities: result.entities,
        facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_alice_bob', from: 'Bob', to: 'Alice', kind: 'traveling companions', status: 'active',
            dynamic: 'Alice and Bob crossed the northern frontier together.', importance: 3,
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world, [{
        name: 'Bob', text: 'Alice was my former mentor during the winter campaign.',
    }]);

    assert.equal(validation.recoveredFactRelationships, 1);
    assert.equal(result.relationships.length, 1);
    assert.equal(result.relationships[0].targetId, 'relationship_alice_bob');
    assert.equal(result.relationships[0].from, 'Bob');
    assert.equal(result.relationships[0].to, 'Alice');
    assert.match(result.relationships[0].dynamic, /crossed the northern frontier/);
    assert.equal(result.relationships[0].status, 'active');
    assert.match(result.relationships[0].dynamic, /was Bob’s former mentor/);
});

test('source-supported role omissions become durable identity facts', () => {
    const result = extraction();
    result.entities.push({ name: 'Alice', type: 'person', aliases: [] });
    result.sceneCapsule = { beats: ['Alice served as captain of the northern guard.'] };

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Alice', text: 'I served as captain of the northern guard.' }]);

    assert.equal(validation.recoveredCoverage, 1);
    assert.deepEqual(validation.warnings, []);
    assert.deepEqual(result.facts.at(-1), {
        targetId: '', subject: 'Alice', predicate: 'established role or designation',
        value: 'Alice served as captain of the northern guard.', category: 'identity',
        importance: 4, persistence: 'persistent',
    });
});

test('an explicit later answer resolves a matching omitted open-thread update', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
    );
    result.sceneCapsule = {
        beats: ['Toska reveals Caelen Veyr’s true name, former High Council role, wartime command, and alias Pell.'],
    };
    result.facts.push({
        targetId: '', subject: 'Toska', predicate: 'knowledge of Caelen Veyr’s true identity',
        value: 'Toska disclosed that her deceased master was Jedi Master Caelen Veyr, a former High Council member.',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
    result.threads.push({
        targetId: 'thread_caelen_identity', title: 'Toska’s former master’s true identity',
        detail: 'Toska has not yet answered.', status: 'open',
        participants: ['Lucas Alcazar', 'Toska', 'Toska’s former master'], importance: 3,
    });
    const world = {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
            { name: 'Toska’s former Jedi Master', type: 'person', aliases: ['the Jedi Master'] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_caelen_identity', title: 'Toska’s former master’s true identity',
            detail: 'Lucas asks Toska for her deceased master’s true name and what he was before, but Toska has not yet answered.',
            status: 'open', participants: ['Lucas Alcazar', 'Toska', 'Toska’s former Jedi Master'], importance: 3,
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world, [{
        name: 'Toska',
        text: 'Asked for her master’s true name, Toska answers: “Caelen Veyr. Jedi Master Caelen Veyr.” She reveals that he formerly served the High Council.',
    }]);

    assert.equal(validation.recoveredIdentities, 1);
    assert.equal(validation.reconciledThreads, 1);
    assert.deepEqual(validation.warnings, []);
    assert.deepEqual(result.identityResolutions, [{
        reference: 'Toska’s former Jedi Master', canonical: 'Caelen Veyr',
        evidence: 'Toska reveals Caelen Veyr’s true name, former High Council role, wartime command, and alias Pell.',
    }]);
    assert.deepEqual(result.threads, [{
        targetId: 'thread_caelen_identity', title: 'Toska’s former master’s true identity',
        detail: 'Resolved by explicit continuity: Toska reveals Caelen Veyr’s true name, former High Council role, wartime command, and alias Pell.',
        status: 'resolved', participants: ['Lucas Alcazar', 'Toska', 'Toska’s former Jedi Master'], importance: 3,
    }]);
});

test('an extractor-confirmed open thread is not locally overruled', () => {
    const result = extraction();
    result.entities.push({ name: 'Alice', type: 'person', aliases: [] });
    result.sceneCapsule = { beats: ['Alice reports finding one of the two missing access keys.'] };
    result.threads.push({
        targetId: 'thread_keys', title: 'Recover both access keys',
        detail: 'One access key remains missing.', status: 'open', participants: ['Alice'], importance: 3,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_keys', title: 'Recover both access keys', detail: 'Alice has not yet recovered both access keys.',
            status: 'open', participants: ['Alice'], importance: 3,
        }],
    }, [{ name: 'Alice', text: 'I found one of the two missing access keys.' }]);

    assert.equal(validation.reconciledThreads, 0);
    assert.equal(result.threads[0].status, 'open');
});

test('a speculative identity question cannot merge a descriptive person', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
    );
    result.sceneCapsule = { beats: ['Toska wonders whether her former master’s true name might be Caelen Veyr.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Toska’s former master', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Toska', text: 'Could my former master have been Caelen Veyr?' }]);

    assert.equal(validation.recoveredIdentities, 0);
    assert.deepEqual(result.identityResolutions, []);
});

test('an explicitly named unknown role merges through its established relationship anchor', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Archivist Rowan', type: 'person', aliases: ['Rowan'] },
        { name: 'Mira Vale', type: 'person', aliases: ['Nightglass'] },
    );
    result.sceneCapsule = {
        beats: [
            'Archivist Rowan’s unnamed former student is discussed.',
            'The unknown student is explicitly named as Nightglass.',
        ],
    };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Archivist Rowan', type: 'person', aliases: ['Rowan'] },
            { name: 'Unnamed former student', type: 'person', aliases: [] },
        ], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            from: 'Archivist Rowan', to: 'Unnamed former student', kind: 'former mentor and student',
            status: 'ended', dynamic: 'The student’s identity is unknown.',
        }],
    }, [
        { name: 'Investigator', text: 'Rowan kept the identity hidden. Name the former student.' },
        { name: 'Mira Vale', text: '“Nightglass.” That was the name.' },
    ]);

    assert.equal(validation.recoveredIdentities, 1);
    assert.deepEqual(result.identityResolutions, [{
        reference: 'Unnamed former student', canonical: 'Mira Vale',
        evidence: 'The unknown student is explicitly named as Nightglass.',
    }]);
});

test('a possible partial thread match stays open and becomes a warning', () => {
    const result = extraction();
    result.entities.push({ name: 'Alice', type: 'person', aliases: [] });
    result.sceneCapsule = { beats: ['Alice found the northern access key.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_keys', title: 'Recover the northern and southern access keys',
            detail: 'Alice has not yet found either access key.', status: 'open', participants: ['Alice'], importance: 3,
        }],
    }, [{ name: 'Alice', text: 'I found the northern access key.' }]);

    assert.equal(validation.reconciledThreads, 0);
    assert.equal(result.threads.length, 0);
    assert.match(validation.warnings.at(-1), /Potential partial resolution remains open/);
});

test('source-supported durable limitations become atomic facts', () => {
    const result = extraction();
    result.entities.push({ name: 'Toska', type: 'person', aliases: [] });
    result.sceneCapsule = {
        beats: ['Toska blocks a series of deliberate attacks but reveals a recurring vulnerability on the high outside line and a late response to a rib feint.'],
    };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator',
        text: 'Toska blocks the deliberate attacks. The high outside line is weak, and her response to the rib feint comes late.',
    }]);

    assert.equal(validation.recoveredCoverage, 1);
    assert.deepEqual(validation.warnings, []);
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].subject, 'Toska');
    assert.equal(result.facts[0].category, 'limitations');
    assert.match(result.facts[0].predicate, /^observed limitation/);
    assert.match(result.facts[0].value, /high outside line/);
});

test('a descriptive L1 limitation that conflicts with raw chat remains only a warning', () => {
    const result = extraction();
    result.entities.push({ name: 'Toska', type: 'person', aliases: [] });
    result.sceneCapsule = { beats: ['Toska reveals a recurring vulnerability on the high outside line.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'Toska reveals that her low inside line is weak.' }]);

    assert.equal(validation.recoveredCoverage, 0);
    assert.equal(result.facts.length, 0);
    assert.equal(validation.warnings.length, 1);
});
