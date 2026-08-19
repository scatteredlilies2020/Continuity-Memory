import assert from 'node:assert/strict';
import test from 'node:test';
import { addressFactIdentity, applySourceAttributionFailClosed, canonicalFactReference, enrichEntityDescriptionsFromEstablishedFacts, entityIsPersonLike, entityTypesAreCompatible, hasSelfAddressEvidence, mergeAddressValues, reconcileResolvedIdentityThreads, reconciliationTargetIsCompatible, recoverRelationshipBackedEntityDescriptions, removeInvalidAddressFacts, removeInvalidStoredAddressFacts, sanitizeReconciliationMetadata } from '../extension/reconciliation-policy.js';

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

test('stable state transitions repair a substituted owner and scene positions ground the active cast', () => {
    const result = extraction();
    result.states.push({
        targetId: 'state_alice_condition', subject: 'Doctor Vale', attribute: 'physical condition',
        value: 'Bruised, bleeding, and unable to bear weight on her left wrist.',
        previous: 'Winded with a raw left wrist.', scope: 'ongoing', operation: 'set', importance: 4,
    });
    result.scene = {
        location: 'Training hall', time: 'Morning', participants: ['Doctor Vale', 'Bob'],
        activity: 'Bob helps Alice sit up after the assessment.', mood: 'Painful',
    };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Alice', type: 'person', aliases: [] },
            { name: 'Bob', type: 'person', aliases: [] },
            { name: 'Doctor Vale', type: 'deceased person', aliases: [] },
        ],
        facts: [], relationships: [], threads: [], backgrounds: [],
        states: [
            { id: 'state_alice_condition', subject: 'Alice', attribute: 'physical condition', value: 'Winded with a raw left wrist.', scope: 'ongoing' },
            { id: 'state_vale_condition', subject: 'Doctor Vale', attribute: 'condition', value: 'Deceased.', scope: 'ongoing' },
        ],
    }, [{
        name: 'Narrator',
        text: '<stat>\nPositions = Alice beside the wall | Bob kneeling beside her\nInventory = Doctor Vale’s old journal\n</stat>\nBob helps Alice sit up.',
    }]);

    assert.equal(result.states[0].subject, 'Alice');
    assert.equal(result.states[0].targetId, 'state_alice_condition');
    assert.equal(result.states[0].value, 'Bruised, bleeding, and unable to bear weight on her left wrist.');
    assert.deepEqual(result.scene.participants, ['Bob', 'Alice']);
    assert.equal(validation.repairedStateOwners, 1);
    assert.equal(validation.reconciledSceneParticipants, 1);
});

test('a different owner cannot hijack a stable state ID without the transition chain', () => {
    const result = extraction();
    result.states.push({
        targetId: 'state_alice_location', subject: 'Bob', attribute: 'location',
        value: 'North gate', previous: 'Unknown', scope: 'ongoing', operation: 'set', importance: 3,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Alice', type: 'person', aliases: [] }, { name: 'Bob', type: 'person', aliases: [] }],
        facts: [], relationships: [], threads: [], backgrounds: [],
        states: [{ id: 'state_alice_location', subject: 'Alice', attribute: 'location', value: 'South gate', scope: 'ongoing' }],
    });
    assert.equal(result.states[0].subject, 'Bob');
    assert.equal(result.states[0].targetId, '');
    assert.equal(validation.repairedStateOwners, 0);
    assert.ok(validation.ignored >= 1);
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

test('closed-compound and possessive punctuation variants reuse one canonical entity', () => {
    const result = extraction();
    result.entities.push({
        targetId: '', name: "Lucas' Hidden Moonbase", type: 'place', aliases: [], description: 'A concealed installation.', importance: 4,
    });
    result.events.push({
        title: 'Arrival', summary: 'The shuttle arrives.', participants: ["Lucas' Hidden Moonbase"],
        location: "Lucas' Hidden Moonbase", storyTime: '', consequences: '', importance: 3,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ id: 'moonbase', name: 'Lucas’s hidden moon base', type: 'place', aliases: [], description: 'A concealed installation.' }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, []);

    assert.equal(result.entities[0].name, 'Lucas’s hidden moon base');
    assert.equal(result.entities[0].targetId, 'moonbase');
    assert.deepEqual(result.events[0].participants, ['Lucas’s hidden moon base']);
    assert.equal(validation.canonicalizedEntityVariants, 1);
});

test('specific role descriptions share the person type family without matching places or objects', () => {
    assert.equal(entityIsPersonLike('deceased guild master'), true);
    assert.equal(entityIsPersonLike('senior laboratory engineer'), true);
    assert.equal(entityTypesAreCompatible('deceased guild master', 'person'), true);
    assert.equal(entityTypesAreCompatible('laboratory engineer', 'orbital station'), false);
    assert.equal(entityTypesAreCompatible('fleet commander', 'artifact weapon'), false);
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

test('factive role knowledge preserves both the holder knowledge and the established role', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Alice Ren', type: 'person', aliases: ['Alice'] },
        { name: 'Borin Vale', type: 'person', aliases: ['Borin'] },
    );
    result.sceneCapsule = { beats: [], participants: ['Alice Ren', 'Borin Vale'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'Alice knows Borin held a council seat.' }]);

    assert.equal(validation.recoveredKnowledge, 2);
    assert.ok(result.facts.some(item => item.subject === 'Alice Ren'
        && item.predicate === 'knowledge of Borin Vale'
        && item.category === 'knowledge'));
    assert.ok(result.facts.some(item => item.subject === 'Borin Vale'
        && item.predicate === 'established role or designation'
        && item.category === 'identity'
        && /held a council seat/iu.test(item.value)));
});

test('a different character’s inference cannot block direct knowledge evidence', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Alice Ren', type: 'person', aliases: ['Alice'] },
        { name: 'Borin Vale', type: 'person', aliases: ['Borin'] },
        { name: 'Cara Sol', type: 'person', aliases: ['Cara'] },
    );
    result.facts.push({
        targetId: '', subject: 'Alice Ren', predicate: 'knowledge of Borin Vale',
        value: 'Cara concludes that Alice knows enough about Borin to exploit his history.',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'Alice knows Borin held a council seat.' }]);

    assert.equal(validation.normalizedKnowledgeHolders, 1);
    assert.equal(validation.recoveredKnowledge, 2);
    assert.ok(result.facts.some(item => item.subject === 'Cara Sol'
        && item.category === 'character belief'
        && /^belief about Alice Ren/iu.test(item.predicate)));
    assert.ok(result.facts.some(item => item.subject === 'Alice Ren'
        && item.predicate === 'knowledge of Borin Vale'
        && /held a council seat/iu.test(item.value)));
    assert.ok(result.facts.some(item => item.subject === 'Borin Vale'
        && item.predicate === 'established role or designation'));
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
    }, [{ name: 'Toska', text: 'My former master was Caelen Veyr.' }]);

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

test('objective relationship facts work with descriptive person-role entity types', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Doctor Vale', type: 'deceased guild master', aliases: [] },
        { name: 'Ari Lane', type: 'apprentice archivist', aliases: [] },
    );
    result.facts.push({
        targetId: '', subject: 'Doctor Vale', predicate: 'former student relationship',
        value: 'Doctor Vale formerly mentored Ari Lane as an apprentice archivist.',
        category: 'biographical history', importance: 4, persistence: 'persistent',
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator',
        text: 'Doctor Vale formerly mentored Ari Lane as an apprentice archivist in the guild archives.',
    }]);

    assert.equal(validation.recoveredFactRelationships, 1);
    assert.equal(result.relationships.length, 1);
    assert.deepEqual([result.relationships[0].from, result.relationships[0].to].sort(), ['Ari Lane', 'Doctor Vale']);
});

test('one established trainer fact recovers each named trainee relationship without linking the trainees', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'], description: 'Deceased Jedi Master who trained Lucas and Toska.' },
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'], description: 'Former Jedi apprentice.' },
        { name: 'Toska', type: 'person', aliases: [], description: 'Jedi Padawan trained by Caelen.' },
    );
    result.facts.push({
        targetId: '', subject: 'Caelen Veyr', predicate: 'training provided to apprentices',
        value: 'Caelen taught Lucas and Toska theory, diplomacy, restraint, and Jedi principles.',
        category: 'history', importance: 4, persistence: 'persistent',
    });
    result.sceneCapsule = { beats: ['Caelen taught Lucas and Toska as his two Jedi trainees.'] };

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Lucas', text: 'Caelen taught Lucas and Toska as his apprentices.' }]);

    assert.equal(validation.recoveredFactRelationships, 2);
    assert.equal(result.relationships.length, 2);
    assert.ok(result.relationships.some(item => [item.from, item.to].includes('Lucas Alcazar') && [item.from, item.to].includes('Caelen Veyr')));
    assert.ok(result.relationships.some(item => [item.from, item.to].includes('Toska') && [item.from, item.to].includes('Caelen Veyr')));
    assert.equal(result.relationships.some(item => [item.from, item.to].includes('Lucas Alcazar') && [item.from, item.to].includes('Toska')), false);
    assert.ok(result.relationships.every(item => item.status === 'ended'));
});

test('a mission target role mention cannot synthesize a relationship with the assigner', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Darth Segundus', type: 'person', aliases: [], description: 'Sith commander.' },
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'], description: 'Sith operative.' },
        { name: 'Toska', type: 'person', aliases: [], description: 'Jedi Padawan survivor.' },
    );
    result.facts.push({
        subject: 'Darth Segundus', predicate: 'mission assignment',
        value: 'Assigned Lucas to hunt Toska, a supposed young Jedi Padawan survivor.',
        category: 'assignment', importance: 3, persistence: 'persistent',
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'Darth Segundus assigned Lucas to hunt Toska, a supposed Jedi Padawan survivor.' }]);

    assert.equal(validation.recoveredFactRelationships, 0);
    assert.deepEqual(result.relationships, []);
});

test('an established unique biography canonicalizes a later descriptive relationship endpoint', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [], description: 'Former Jedi Padawan.' },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'], description: 'Deceased Jedi Master who trained Toska.' },
    );
    result.relationships.push({
        targetId: '', from: 'Toska', to: 'Toska’s former Jedi Master', kind: 'Jedi Master and Padawan',
        status: 'ended', dynamic: 'Toska remains loyal to her deceased Jedi Master.', importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, []);

    assert.equal(validation.recoveredEstablishedIdentities, 1);
    assert.deepEqual(result.identityResolutions, [{
        reference: 'Toska’s former Jedi Master', canonical: 'Caelen Veyr',
        evidence: 'Established canonical biography uniquely identifies Toska’s former Jedi Master as Caelen Veyr.',
    }]);
    assert.ok(result.relationships.some(item => [item.from, item.to].includes('Toska') && [item.from, item.to].includes('Caelen Veyr')));
});

test('an incidental role mention cannot turn a killer into the victim\'s former master', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [], description: 'A captive Padawan.' },
        { name: 'Lucas Alcazar', type: 'Sith apprentice', aliases: ['Lucas'], description: 'Sith apprentice who defeated a Jedi Master and took Toska captive.' },
        { name: 'Toska’s Jedi Master', type: 'person', aliases: ['Toska’s Master'], description: 'Jedi Master killed by Lucas.' },
    );
    result.relationships.push(
        { targetId: '', from: 'Lucas Alcazar', to: 'Toska', kind: 'captor and captive', status: 'active', dynamic: 'Lucas restrains Toska as his captive.', importance: 4 },
        { targetId: '', from: 'Toska', to: 'Toska’s Jedi Master', kind: 'Jedi Master and Padawan', status: 'ended', dynamic: 'Toska was the dead Jedi Master’s Padawan.', importance: 4 },
    );

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, []);

    assert.equal(validation.recoveredEstablishedIdentities, 0);
    assert.deepEqual(result.identityResolutions, []);
    assert.ok(result.relationships.some(item => item.from === 'Toska' && item.to === 'Toska’s Jedi Master'));
    assert.equal(result.relationships.filter(item => [item.from, item.to].includes('Lucas Alcazar') && [item.from, item.to].includes('Toska')).length, 1);
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
    }, [{ name: 'Toska', text: 'My former master was Caelen Veyr.' }]);

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

test('a historical mentor relationship cannot remain active after its established evidence says former', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'], description: 'Former Jedi apprentice.' },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'], description: 'Deceased Jedi Master.' },
    );
    result.facts.push({
        targetId: '', subject: 'Lucas Alcazar', predicate: 'identity disclosure',
        value: 'Lucas Alcazar identifies himself as Caelen Veyr’s former apprentice.',
        category: 'identity', importance: 4, persistence: 'persistent',
    });
    result.relationships.push({
        targetId: '', from: 'Lucas Alcazar', to: 'Caelen Veyr', kind: 'Jedi master and Padawan',
        status: 'active', dynamic: 'Lucas argues about Caelen’s rank and displays a relic.', importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Lucas', text: 'Lucas Alcazar was Caelen Veyr’s former apprentice.' }]);

    assert.equal(validation.reconciledHistoricalRelationships, 1);
    assert.equal(result.relationships.length, 1);
    assert.equal(result.relationships[0].kind, 'former Jedi master and Padawan');
    assert.equal(result.relationships[0].status, 'ended');
    assert.match(result.relationships[0].dynamic, /former apprentice/);
});

test('an epistemic rider cannot contaminate or suppress the relationship asserted before it', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
        { name: 'Caelen Veyr', type: 'deceased Jedi Master', aliases: ['Caelen'] },
    );
    result.facts.push({
        targetId: '', subject: 'Lucas Alcazar', predicate: 'identity as Caelen Veyr’s former apprentice',
        value: 'Lucas explicitly identifies himself as Caelen Veyr’s former apprentice, but Toska does not know that Lucas Alcazar is the Sith’s true identity.',
        category: 'identity', importance: 5, persistence: 'persistent',
    });
    result.relationships.push({
        targetId: 'relationship_toska_caelen', from: 'Toska', to: 'Caelen Veyr',
        kind: 'former Jedi Master and Padawan', status: 'ended',
        dynamic: 'Lucas explicitly identifies himself as Caelen Veyr’s former apprentice.', importance: 5,
    });
    const world = {
        entities: result.entities, facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_toska_caelen', from: 'Toska', to: 'Caelen Veyr',
            kind: 'former Jedi Master and Padawan', status: 'ended',
            dynamic: 'Toska was Caelen Veyr’s Padawan and remains loyal after his death.', importance: 5,
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world, [{
        name: 'Lucas', text: 'I was Caelen Veyr’s former apprentice. Toska does not know Lucas Alcazar is my true identity.',
    }]);

    assert.equal(validation.recoveredFactRelationships, 1);
    assert.equal(result.relationships.length, 2);
    const toskaCaelen = result.relationships.find(item => item.targetId === 'relationship_toska_caelen');
    const lucasCaelen = result.relationships.find(item => [item.from, item.to].includes('Lucas Alcazar'));
    assert.match(toskaCaelen.dynamic, /Toska was Caelen Veyr’s Padawan/);
    assert.deepEqual([lucasCaelen.from, lucasCaelen.to].sort(), ['Caelen Veyr', 'Lucas Alcazar']);
    assert.equal(lucasCaelen.status, 'ended');
    assert.doesNotMatch(lucasCaelen.dynamic, /Toska does not know/);
});

test('a pending named object cannot be conflated with a different object being presented', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Toska’s green-crystal lightsaber', type: 'object', aliases: [] },
        { name: 'Caelen Veyr’s lightsaber and crystal', type: 'object', aliases: [] },
    );
    result.facts.push({
        targetId: '', subject: 'Toska', predicate: 'former lightsaber status',
        value: 'Toska’s recovered green-crystal lightsaber is now in Lucas’s possession and is shown to Segundus.',
        category: 'possession and loss', importance: 4, persistence: 'persistent',
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [
        { name: 'Narrator', text: 'The retrieval team remains in hyperspace with the green saber; arrival is expected later.' },
        { name: 'Lucas', text: 'I show Segundus Caelen Veyr’s lightsaber and crystal as proof.' },
    ]);

    assert.equal(validation.discardedContradictedObjectFacts, 1);
    assert.deepEqual(result.facts, []);
});

test('relationship descriptions become self-contained without changing their asserted meaning', () => {
    const result = extraction();
    result.relationships.push({
        targetId: '', from: 'Alice', to: 'Bob', kind: 'friends', status: 'active',
        dynamic: 'They trust one another with the archive key.', importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.normalizedRelationshipDescriptions, 1);
    assert.match(result.relationships[0].dynamic, /Relationship between Alice and Bob/);
    assert.match(result.relationships[0].dynamic, /trust one another with the archive key/);
});

test('state transitions use the canonical stored value as their previous value', () => {
    const result = extraction();
    result.states.push({
        targetId: 'state_alice_location', subject: 'Alice', attribute: 'current location',
        value: 'North tower', previous: 'Unknown', scope: 'ongoing', operation: 'set', importance: 3,
    });
    const world = {
        entities: [{ name: 'Alice', type: 'person', aliases: [] }], facts: [], relationships: [], threads: [], backgrounds: [],
        states: [{
            id: 'state_alice_location', subject: 'Alice', attribute: 'location', value: 'South gate',
            previous: '', scope: 'ongoing', operation: 'set', importance: 3,
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world);

    assert.equal(validation.reconciledStateTransitions, 1);
    assert.equal(result.states[0].previous, 'South gate');
    assert.equal(result.states[0].targetId, 'state_alice_location');
});

test('state durability gate removes non-conditions and demotes scene actions', () => {
    const result = extraction();
    result.states.push(
        { targetId: '', subject: 'Lucas', attribute: 'physical condition', value: 'Freshly dressed in dark robes and armor; no new injury is established.', previous: '', importance: 2, scope: 'ongoing', operation: 'set' },
        { targetId: '', subject: 'Pilot', attribute: 'assignment', value: 'Waiting at the console.', previous: '', importance: 2, scope: 'ongoing', operation: 'set' },
        { targetId: '', subject: 'Toska', attribute: 'physical condition', value: 'Recovering from a broken wrist.', previous: '', importance: 4, scope: 'ongoing', operation: 'set' },
    );
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, []);

    assert.equal(result.states.some(item => item.subject === 'Lucas'), false);
    assert.equal(result.states.find(item => item.subject === 'Pilot').scope, 'scene');
    assert.equal(result.states.find(item => item.subject === 'Toska').scope, 'ongoing');
    assert.equal(validation.discardedNonDurableStates, 1);
    assert.equal(validation.demotedSceneStates, 1);
});

test('major event consequences require a durable typed record', () => {
    const result = extraction();
    result.events.push({
        title: 'Northern bridge collapse', summary: 'The northern bridge collapsed.', participants: ['Alice'],
        consequences: 'The northern road is now impassable to supply wagons.', importance: 5,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });
    assert.ok(validation.warnings.some(item => /Typed coverage gap.*Northern bridge collapse/u.test(item)));

    result.facts.push({
        targetId: '', subject: 'Northern road', predicate: 'accessibility',
        value: 'The northern road is impassable to supply wagons after the bridge collapse.',
        category: 'infrastructure', importance: 5, persistence: 'persistent',
    });
    const covered = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });
    assert.ok(!covered.warnings.some(item => /Typed coverage gap.*Northern bridge collapse/u.test(item)));
});

test('the typed audit flags epistemic leakage, scene conflicts, and contradictory thread status', () => {
    const result = extraction();
    result.scene = { location: 'Harbor', participants: ['Alice'] };
    result.facts.push({
        targetId: '', subject: 'Alice', predicate: 'Bob’s allegiance',
        value: 'Alice believes Bob might secretly serve the crown.', category: 'background',
        importance: 4, persistence: 'persistent',
    });
    result.states.push({
        targetId: '', subject: 'Alice', attribute: 'location', value: 'Mountain keep',
        previous: '', scope: 'scene', operation: 'set', importance: 3,
    });
    result.threads.push({
        targetId: '', title: 'Recover the archive key',
        detail: 'The archive key remains missing and must still be recovered.', status: 'resolved',
        participants: ['Alice'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Alice', type: 'person', aliases: [] }, { name: 'Bob', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.ok(validation.warnings.some(item => /Epistemic conflict/u.test(item)));
    assert.ok(validation.warnings.some(item => /Scene\/state conflict/u.test(item)));
    assert.ok(validation.warnings.some(item => /Thread lifecycle conflict/u.test(item)));
});

test('a learned claim remains an open thread when its truth still lacks confirmation', () => {
    const result = extraction();
    result.threads.push({
        targetId: '', title: 'Whether the mentor concealed the archive key',
        detail: 'Ari learned Rowan’s claim that the mentor concealed the key, but she lacks confirmation of what the mentor actually knew or intended.',
        status: 'open', participants: ['Ari', 'Rowan'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.ok(!validation.warnings.some(item => /Thread lifecycle conflict/u.test(item)));
});

test('the typed audit flags simultaneous unique-object possession', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Alice', type: 'person', aliases: [] },
        { name: 'Bob', type: 'person', aliases: [] },
        { name: 'Sun Key', type: 'artifact', aliases: [] },
    );
    result.states.push(
        { targetId: '', subject: 'Alice', attribute: 'possession', value: 'Sun Key', scope: 'ongoing', operation: 'set', importance: 4 },
        { targetId: '', subject: 'Bob', attribute: 'possession', value: 'Sun Key', scope: 'ongoing', operation: 'set', importance: 4 },
    );

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.ok(validation.warnings.some(item => /Possession conflict.*Sun Key/u.test(item)));
});

test('identity and temporal changes require explicit transition anchors', () => {
    const result = extraction();
    result.sceneCapsule = { temporal: { relation: 'unknown', elapsed: 'three days', certainty: 'explicit' } };
    result.facts.push({
        targetId: 'fact_alice_rank', subject: 'Alice', predicate: 'military rank', value: 'General',
        category: 'identity', importance: 4, persistence: 'persistent',
    });
    const world = {
        entities: [{ name: 'Alice', type: 'person', aliases: [] }], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{
            id: 'fact_alice_rank', subject: 'Alice', predicate: 'military rank', value: 'Captain',
            category: 'identity', importance: 4, persistence: 'persistent',
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world);

    assert.ok(validation.warnings.some(item => /Identity\/role conflict/u.test(item)));
    assert.ok(validation.warnings.some(item => /Temporal conflict/u.test(item)));
});

test('mixed character assertions cannot become one objective biographical fact', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Caelen Veyr', type: 'person', aliases: ['Pell'], description: 'A Jedi whose disputed history is being discussed.' },
        { name: 'Lucas Alcazar', type: 'person', aliases: [], description: 'A Sith questioning Toska.' },
        { name: 'Toska', type: 'person', aliases: [], description: 'Caelen’s grieving Padawan.' },
    );
    result.facts.push({
        targetId: '', subject: 'Caelen Veyr', predicate: 'former identity and service',
        value: 'Caelen Veyr served as an investigator and member of the Jedi High Council before the Purge and commanded the Republic’s Twelfth Reconnaissance Fleet during the war.',
        category: 'biographical history', persistence: 'persistent', importance: 5,
    });
    const messages = [
        { name: 'Toska', isUser: false, text: '“Caelen Veyr served as an investigator for the High Council before the Purge. During the war, he commanded the Republic’s Twelfth Reconnaissance Fleet.”' },
        { name: 'Lucas Alcazar', isUser: true, text: 'I tell her Caelen Veyr was in the Jedi High Council.' },
    ];

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, messages);

    assert.ok(validation.sourceAttributionConflicts.some(item => item.category === 'facts'));
    assert.ok(validation.warnings.some(item => /Source-attribution conflict.*former identity and service/u.test(item)));
});

test('explicit claimant overrides a wrongly assigned canonical-looking belief holder', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Toska', type: 'person', aliases: [] },
    );
    result.facts.push({
        targetId: '', subject: 'Toska', predicate: 'belief about Caelen Veyr — former apprentice',
        value: 'Lucas claims Caelen Veyr trained him before Toska.',
        category: 'character belief', persistence: 'persistent', importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.normalizedEpistemicFacts, 1);
    assert.equal(result.facts[0].subject, 'Lucas Alcazar');
    assert.equal(result.facts[0].category, 'character belief');
    assert.match(result.facts[0].predicate, /^belief about Caelen Veyr — former apprentice$/u);
});

test('historical relationships and entity descriptions inherit source uncertainty', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Caelen Veyr', type: 'person', aliases: [], description: 'Caelen Veyr formerly trained Lucas Alcazar as his Jedi apprentice in diplomacy and theory.' },
        { name: 'Lucas Alcazar', type: 'person', aliases: [], description: 'A concealed Sith.' },
    );
    result.relationships.push({
        targetId: '', from: 'Caelen Veyr', to: 'Lucas Alcazar', kind: 'former Jedi master and apprentice', status: 'ended',
        dynamic: 'Caelen Veyr formerly trained Lucas Alcazar as his Jedi apprentice in diplomacy and theory.', importance: 4,
    });
    const messages = [{
        name: 'Lucas Alcazar', isUser: true,
        text: 'I claim, “Caelen Veyr formerly trained Lucas Alcazar as his Jedi apprentice in diplomacy and theory.”',
    }];

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, messages);

    assert.ok(validation.sourceAttributionConflicts.some(item => item.category === 'entities'));
    assert.ok(validation.sourceAttributionConflicts.some(item => item.category === 'relationships'));
    assert.equal(applySourceAttributionFailClosed(result, validation.sourceAttributionConflicts), 2);
    assert.equal(result.relationships.length, 0);
    assert.match(result.entities[0].description, /remain disputed or attributed/u);
});

test('a safe canonical relationship prevents an entity role from degrading to a placeholder', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Doctor Vale', type: 'person', aliases: [], description: 'Doctor Vale formerly trained Ari but secretly feared her talent.' },
        { name: 'Ari Lane', type: 'person', aliases: [], description: 'An apprentice.' },
    );
    result.relationships.push({
        targetId: '', from: 'Ari Lane', to: 'Doctor Vale', kind: 'former mentor and student', status: 'ended',
        dynamic: 'Doctor Vale was Ari Lane’s former mentor; Ari now suspects Vale feared her talent.', importance: 4,
    });
    result.facts.push({
        targetId: '', subject: 'Ari Lane', predicate: 'belief about Doctor Vale — fear',
        value: 'Ari believes Doctor Vale feared her talent.', category: 'character belief', importance: 4, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'Doctor Vale was Ari Lane’s former mentor. Ari now suspects Vale feared her talent.' }]);

    assert.equal(validation.sourceAttributionConflicts.some(item => item.category === 'entities' && item.label === 'Doctor Vale'), false);
    assert.equal(result.entities[0].description, 'Role/background: Ari Lane’s former mentor.');
    assert.doesNotMatch(result.entities[0].description, /feared her talent/iu);
    assert.doesNotMatch(result.entities[0].description, /remain disputed or attributed/iu);
});

test('a subjective update cannot overwrite an established entity description', () => {
    const result = extraction();
    result.entities.push({
        targetId: 'entity_caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
        description: 'Toska’s former Jedi Master, whose strict restraint is now interpreted by Toska as fear-driven suppression of her potential.',
        importance: 4,
    });
    result.facts.push({
        targetId: '', subject: 'Toska', predicate: 'belief about Caelen Veyr — fear and suppression',
        value: 'Toska is beginning to believe Caelen kept her power small because he feared her potential.',
        category: 'character belief', importance: 4, persistence: 'persistent',
    });
    const established = 'Toska’s deceased former Jedi Master, known as Pell while in hiding.';
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ id: 'entity_caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Pell'], description: established }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Toska', isUser: false,
        text: 'Toska says, “Maybe Caelen kept me small because he was afraid of what I could become.”',
    }]);

    assert.ok(validation.sourceAttributionConflicts.some(item => item.category === 'entities'));
    assert.equal(validation.diagnosticWarnings.length, 0);
    assert.ok(validation.localWarnings.some(item => /Source-attribution conflict/u.test(item)));
    assert.equal(applySourceAttributionFailClosed(result, validation.sourceAttributionConflicts), 1);
    assert.equal(result.entities[0].description, established);
    assert.equal(result.facts[0].category, 'character belief');
});

test('objective narration may still update an established entity description', () => {
    const result = extraction();
    result.entities.push({
        targetId: 'entity_caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
        description: 'Toska’s deceased former Jedi Master, known as Pell while hiding on the desert planet and carrying a blue lightsaber.',
        importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{
            id: 'entity_caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
            description: 'Toska’s deceased former Jedi Master, known as Pell while in hiding.',
        }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'Caelen Veyr lived under the name Pell on the desert planet. His blue lightsaber lay beside his body in the abandoned hut.',
    }]);

    assert.equal(validation.sourceAttributionConflicts.some(item => item.category === 'entities'), false);
});

test('structured character profiles discard only unsupported neighboring details', () => {
    const result = extraction();
    result.entities.push({
        name: 'Nima', type: 'person', aliases: [], importance: 4,
        description: 'Role/background: Toska’s base-born attendant; Appearance: round-cheeked, jaw-length black hair, green eyes; Personality/quirks: devoted, randomly stumbles, telepathic.',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'Nima is Toska’s base-born attendant. *She is round-cheeked with jaw-length black hair.* Nima is devoted. *She randomly stumbles while following Toska.*',
    }]);

    assert.equal(validation.discardedCharacterProfileDetails, 2);
    assert.equal(result.entities[0].description, 'Role/background: Toska’s base-born attendant; Appearance: round-cheeked, jaw-length black hair; Personality/quirks: devoted, randomly stumbles.');
    assert.doesNotMatch(result.entities[0].description, /green eyes|telepathic/iu);
    assert.ok(validation.localWarnings.some(item => /withheld 2 unsupported detail/u.test(item)));
});

test('schema-separated character profile fields are grounded and assembled into the entity description', () => {
    const result = extraction();
    result.entities.push({
        name: 'Nima', type: 'person', aliases: [], importance: 4, description: '',
        characterProfile: {
            roleBackground: 'young acolyte, Toska’s personal attendant',
            appearance: 'round-cheeked, black hair cropped unevenly at her jaw, green eyes',
            personalityQuirks: 'earnest, stutters, repeatedly trips',
        },
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'A young acolyte rounds the arch too fast. She is round-cheeked, with black hair cropped unevenly at her jaw. Her bow nearly finds the floor. “I’m Nima.”\nNima serves as Toska’s personal attendant. Nima is earnest. Nima stutters. Nima repeatedly trips while following Toska.',
    }]);

    assert.equal(result.entities[0].description, 'Role/background: young acolyte, Toska’s personal attendant; Appearance: round-cheeked, black hair cropped unevenly at her jaw; Personality/quirks: earnest, stutters, repeatedly trips.');
    assert.equal(validation.discardedCharacterProfileDetails, 1);
    assert.equal('characterProfile' in result.entities[0], false);
    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['young acolyte', 'Toska’s personal attendant'],
        appearance: ['round-cheeked', 'black hair cropped unevenly at her jaw'],
        personalityQuirks: ['earnest', 'stutters', 'repeatedly trips'],
    });
    assert.doesNotMatch(result.entities[0].description, /green eyes/iu);
});

test('typed character profiles reject scene conditions and temporary reactions even when source-grounded', () => {
    const result = extraction();
    result.entities.push({
        name: 'Nima', type: 'person', aliases: [], importance: 4, description: '',
        characterProfile: {
            roleBackground: 'personal attendant, currently escorting Toska',
            appearance: 'black hair, dust-streaked, split lip',
            personalityQuirks: 'stutters, awed, proud',
        },
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'Nima is Toska’s personal attendant and is currently escorting Toska. Nima has black hair, but she is dust-streaked and has a split lip. Nima stutters. She is awed and proud right now.',
    }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['Toska’s personal attendant'],
        appearance: ['black hair'],
        personalityQuirks: ['stutters'],
    });
    assert.equal(result.entities[0].description, 'Role/background: Toska’s personal attendant; Appearance: black hair; Personality/quirks: stutters.');
    assert.equal(validation.discardedCharacterProfileDetails, 5);
});

test('generated status panels cannot become character-profile evidence', () => {
    const result = extraction();
    result.entities.push({
        name: 'Toska', type: 'person', aliases: [], importance: 5, description: '',
        characterProfile: {
            roleBackground: [
                'Jedi Padawan',
                'afraid 😠 | Pilot: disciplined loyalty 🫡 Psyche = Toska | ID: survive',
                'former Jedi Council member',
            ],
            appearance: ['shoulder-length brown hair', 'blue eyes'],
            personalityQuirks: ['dusty', 'defending Caelen’s secrecy while scrutinizing Lucas'],
        },
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: `<stat>
\`\`\`
Physical State = Toska is dusty and firmly restrained
Emotions = Toska: afraid 😠 | Pilot: disciplined loyalty 🫡
Psyche = Toska | ID: survive | EGO: comply while watching
Characters = Toska | captive Jedi Padawan; Caelen Veyr | former Jedi Council member
\`\`\`
</stat>

Toska is a Jedi Padawan. Toska has shoulder-length brown hair and blue eyes. Toska defends Caelen's secrecy while scrutinizing Lucas.`,
    }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['Jedi Padawan'],
        appearance: ['shoulder-length brown hair', 'blue eyes'],
    });
    assert.doesNotMatch(result.entities[0].description, /Pilot|Psyche|Council|dusty|defending/iu);
    assert.equal(validation.discardedCharacterProfileDetails, 4);
});

test('arbitrary structured statbox formats cannot become character-profile evidence', () => {
    const result = extraction();
    result.entities.push({
        name: 'Toska', type: 'person', aliases: [], importance: 5, description: '',
        characterProfile: {
            roleBackground: ['Jedi Padawan', 'fleet admiral', 'oracle'],
            appearance: ['blue eyes', 'silver hair', 'horns'],
            personalityQuirks: ['stutters', 'ruthless', 'cheerful'],
        },
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: `<character_sheet>
Role: fleet admiral
Appearance: silver hair
</character_sheet>

\`\`\`json
{"appearance":"horns","personality":"ruthless"}
\`\`\`

| Field | Value |
| --- | --- |
| Role | oracle |
| Temperament | cheerful |

[Vitals]
Mood -> triumphant
Goal -> seize the throne
[/Vitals]

Toska is a Jedi Padawan. Toska has blue eyes. Toska stutters.`,
    }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['Jedi Padawan'],
        appearance: ['blue eyes'],
        personalityQuirks: ['stutters'],
    });
    assert.doesNotMatch(result.entities[0].description, /admiral|oracle|silver|horns|ruthless|cheerful/iu);
    assert.equal(validation.discardedCharacterProfileDetails, 6);
});

test('immersive second-person premises cannot leak into a third-person entity profile', () => {
    const result = extraction();
    result.entities.push({
        name: 'Darth Segundus', type: 'person', aliases: ['Segundus'], importance: 4, description: '',
        characterProfile: {
            roleBackground: [
                'firm believer of the Rule of Two',
                'would not allow you to gain an apprentice so the best course of action is to hide the would be apprentice until the time is right',
                'Lucas Alcazar’s Sith Master',
            ],
            appearance: [], personalityQuirks: [],
        },
    });
    result.relationships.push({
        targetId: '', from: 'Lucas Alcazar', to: 'Darth Segundus', kind: 'Sith master and apprentice', status: 'active',
        dynamic: 'Darth Segundus is Lucas Alcazar’s Sith Master and controls his assignments.', importance: 4,
    });
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'Your Master, Darth Segundus, sent you to the desert. Darth Segundus is a firm believer of the Rule of Two and would not allow you to gain an apprentice, so the best course of action is to hide the would-be apprentice until the time is right.',
    }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['Lucas Alcazar’s Sith Master'],
        personalityQuirks: ['firm believer of the Rule of Two'],
    });
    assert.doesNotMatch(result.entities[0].description, /\b(?:I|me|my|we|us|our|you|your)\b/u);
    assert.doesNotMatch(result.entities[0].description, /best course|hide the would/iu);
});

test('canonical record prose removes first and second person while retaining supported third-person clauses', () => {
    const result = extraction();
    result.facts.push({ targetId: '', subject: 'Lucas', predicate: 'orders you to wait', value: 'You must remain here.', category: 'order', persistence: 'temporary', importance: 2 });
    result.relationships.push({
        targetId: '', from: 'Lucas', to: 'Toska', kind: 'captor and captive', status: 'active', importance: 4,
        dynamic: 'Lucas holds Toska captive; you should not attempt escape.',
    });
    result.events.push({
        title: 'Lucas returns', summary: 'Lucas returns to the moonbase. You should prepare for training.',
        consequences: 'Toska sees Lucas arrive.', participants: ['Lucas', 'Toska'], importance: 3,
    });
    result.threads.push({
        targetId: '', title: 'Toska awaits training', detail: 'Toska awaits Lucas’s evaluation. You must train later.',
        status: 'open', participants: ['Toska', 'Lucas'], importance: 3,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, []);

    assert.deepEqual(result.facts, []);
    assert.equal(result.relationships[0].dynamic, 'Lucas holds Toska captive;');
    assert.equal(result.events[0].summary, 'Lucas returns to the moonbase.');
    assert.equal(result.threads[0].detail, 'Toska awaits Lucas’s evaluation.');
    assert.ok(validation.discardedNonThirdPersonProseFields >= 4);
    assert.equal(validation.discardedNonThirdPersonProseRecords, 1);
});

test('one malformed imported profile detail does not erase valid sibling details', () => {
    const result = extraction();
    result.entities.push({ targetId: 'toska', name: 'Toska', type: 'person', aliases: [], importance: 5, description: '' });
    sanitizeReconciliationMetadata(result, {
        entities: [{
            id: 'toska', name: 'Toska', type: 'person', aliases: [],
            description: 'Role/background: Jedi Padawan, afraid | Pilot: vigilant, former Jedi Council member; Appearance: blue eyes.',
            profile: {
                roleBackground: ['Jedi Padawan', 'afraid | Pilot: vigilant', 'former Jedi Council member'],
                appearance: ['blue eyes'],
            },
        }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Toska has blue eyes.' }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['Jedi Padawan', 'former Jedi Council member'], appearance: ['blue eyes'],
    });
    assert.doesNotMatch(result.entities[0].description, /Pilot/iu);
});

test('an older locally extracted profile is re-grounded detail by detail under the new validator', () => {
    const result = extraction();
    result.entities.push({ targetId: 'lucas', name: 'Lucas', type: 'person', aliases: [], importance: 5, description: '' });
    sanitizeReconciliationMetadata(result, {
        entities: [{
            id: 'lucas', name: 'Lucas', type: 'person', aliases: [],
            description: 'Role/background: former Council member, Caelen’s former apprentice; Appearance: blue eyes.',
            profile: {
                roleBackground: ['former Council member', 'Caelen’s former apprentice'], appearance: ['blue eyes'],
            },
        }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
        sources: { chat: { processedMessages: [{ index: 0, fingerprint: 'old', version: 1 }] } },
    }, [{ name: 'Narrator', isUser: false, text: 'Lucas was Caelen’s former apprentice.' }]);

    assert.deepEqual(result.entities[0].profile, { roleBackground: ['Caelen’s former apprentice'] });
});

test('typed profile grammar accepts genre-neutral roles and enduring traits', () => {
    const result = extraction();
    result.entities.push({
        name: 'Aria', type: 'person', aliases: [], importance: 4, description: '',
        characterProfile: { roleBackground: 'court mage', appearance: '', personalityQuirks: 'sarcastic' },
    });
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Aria was a court mage. Aria is sarcastic by nature.' }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['court mage'], personalityQuirks: ['sarcastic'],
    });
});

test('a neighboring character name cannot survive as another person role', () => {
    const result = extraction();
    result.entities.push({
        targetId: 'caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Pell'], importance: 5, description: '',
        characterProfile: { roleBackground: ['Toska'], appearance: [], personalityQuirks: [] },
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{
            id: 'caelen', name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
            description: 'Role/background: Toska.', profile: { roleBackground: ['Toska'] },
        }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Toska defends Caelen Veyr’s memory.' }]);

    assert.deepEqual(result.entities[0].profile, {});
    assert.equal(result.entities[0].description, '');
    assert.equal(validation.discardedCharacterProfileDetails, 1);
});

test('source-derived profile recovery does not depend on the model proposing Nima details', () => {
    const result = extraction();
    result.entities.push({
        name: 'Nima', type: 'person', aliases: [], importance: 4, description: '',
        characterProfile: { roleBackground: ['young acolyte', 'Toska’s personal attendant'], appearance: [], personalityQuirks: [] },
    });
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [
        { name: 'Lucas', isUser: true, text: 'OOC: A young acolyte arrives as Toska’s personal attendant. She has a stutter. Nima follows and stumbles randomly.' },
        { name: 'Narrator', isUser: false, text: 'A young acolyte rounds the arch. She is round-cheeked, with black hair cropped unevenly at her jaw. “I’m Nima,” she says.' },
    ]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['young acolyte'],
        appearance: ['round-cheeked', 'with black hair cropped unevenly at her jaw'],
        personalityQuirks: ['stutters', 'habitually stumbles'],
    });
});

test('accepted facts and relationship descriptions deterministically restore Caelen roles', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Caelen Veyr', type: 'person', aliases: ['Pell'], importance: 5, description: '', characterProfile: { roleBackground: ['Toska'], appearance: [], personalityQuirks: [] } },
        { name: 'Toska', type: 'person', aliases: [], importance: 5, description: '', characterProfile: { roleBackground: [], appearance: [], personalityQuirks: [] } },
    );
    result.facts.push({
        targetId: '', subject: 'Caelen Veyr', predicate: 'established role or designation',
        value: 'Caelen Veyr held a Council seat.', category: 'identity', importance: 5, persistence: 'persistent',
    });
    result.relationships.push({
        targetId: '', from: 'Toska', to: 'Caelen Veyr', kind: 'former Jedi master and apprentice', status: 'ended',
        dynamic: "Toska was Caelen Veyr's Jedi Padawan.", importance: 5,
    });
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Toska was Caelen Veyr’s Jedi Padawan. Caelen Veyr held a Council seat.' }]);

    assert.deepEqual(result.entities.find(item => item.name === 'Caelen Veyr').profile, {
        roleBackground: ['Jedi Master', 'former Jedi Council member'],
    });
});

test('a self-introduction does not pull another named person into a character profile', () => {
    const result = extraction();
    result.entities.push(
        {
            name: 'Nima', type: 'person', aliases: [], importance: 4, description: '',
            characterProfile: { roleBackground: 'young acolyte', appearance: 'silver hair', personalityQuirks: '' },
        },
        { name: 'Maren', type: 'person', aliases: [], importance: 3, description: '' },
    );
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'Maren has silver hair. A young acolyte enters. “I’m Nima,” she says.',
    }]);

    assert.equal(validation.discardedCharacterProfileDetails, 1);
    assert.equal(result.entities[0].description, 'Role/background: young acolyte.');
    assert.doesNotMatch(result.entities[0].description, /silver hair/iu);
});

test('schema profile fields safely convert a legacy free-form person without losing established traits', () => {
    const result = extraction();
    result.entities.push({
        targetId: 'entity_nima', name: 'Nima', type: 'person', aliases: [], importance: 4, description: '',
        characterProfile: {
            roleBackground: 'young naive acolyte and Toska’s personal attendant',
            appearance: 'round-cheeked with jaw-length black hair',
            personalityQuirks: 'earnest, stutters, frequently trips, telepathic',
        },
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{
            id: 'entity_nima', name: 'Nima', type: 'person', aliases: [],
            description: 'Young naive acolyte and Toska’s personal attendant; earnest, stutters, and frequently trips.',
        }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'Nima enters the room. She is round-cheeked with jaw-length black hair.',
    }]);

    assert.equal(result.entities[0].description, 'Role/background: young naive acolyte, Toska’s personal attendant; Appearance: round-cheeked with jaw-length black hair; Personality/quirks: earnest, stutters, frequently trips.');
    assert.equal(validation.discardedCharacterProfileDetails, 1);
    assert.doesNotMatch(result.entities[0].description, /telepathic/iu);
});

test('structured character profiles retain prior sections when a new profile invents replacements', () => {
    const established = 'Role/background: Toska’s base-born attendant; Appearance: round-cheeked, black hair; Personality/quirks: earnest, devoted.';
    const result = extraction();
    result.entities.push({
        targetId: 'entity_nima', name: 'Nima', type: 'person', aliases: [], importance: 4,
        description: 'Appearance: green-eyed; Personality/quirks: cruel.',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ id: 'entity_nima', name: 'Nima', type: 'person', aliases: [], description: established }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Nima carries honey sweets to Toska.' }]);

    assert.equal(validation.discardedCharacterProfileDetails, 2);
    assert.equal(result.entities[0].description, established);
});

test('character dialogue alone cannot establish an objective profile detail', () => {
    const result = extraction();
    result.entities.push({
        name: 'Nima', type: 'person', aliases: [], importance: 4,
        description: 'Appearance: green eyes.',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Lucas', isUser: false, text: 'Lucas claims, “Nima has green eyes.”' }]);

    assert.equal(validation.discardedCharacterProfileDetails, 1);
    assert.equal(result.entities[0].description, '');
});

test('a nearby character trait cannot be attached to the wrong profile', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Nima', type: 'person', aliases: [], importance: 4, description: 'Appearance: green eyes.' },
        { name: 'Lucas', type: 'person', aliases: [], importance: 4, description: '' },
    );
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Nima entered the room. Lucas had green eyes.' }]);

    assert.equal(validation.discardedCharacterProfileDetails, 1);
    assert.equal(result.entities[0].description, '');
});

test('multi-character prose cannot transfer biography thoughts or relative appearance into the wrong profile', () => {
    const result = extraction();
    result.entities.push(
        {
            name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'], importance: 5, description: '',
            characterProfile: {
                roleBackground: ['former Council member', 'complete absence', 'Caelen Veyr’s former apprentice', 'strict conservative'],
                appearance: [
                    'insult finds purchase precisely because it resembles doubts she never permitted herself to voice',
                    'surely seen the doubt pass through her blue eyes',
                ],
                personalityQuirks: ['shorter than Lucas when he rises beside her—the top of her head reaches his chin'],
            },
        },
        { name: 'Toska', type: 'person', aliases: [], importance: 5, description: '' },
        { name: 'Caelen Veyr', type: 'person', aliases: [], importance: 5, description: '' },
    );
    result.relationships.push({
        targetId: '', from: 'Lucas Alcazar', to: 'Caelen Veyr', kind: 'former Jedi master and apprentice', status: 'ended',
        dynamic: 'Lucas Alcazar was Caelen Veyr’s former apprentice.', importance: 5,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: `Lucas has reframed Caelen's protection as condescension. The insult finds purchase because it resembles doubts Toska never permitted herself to voice. Toska has blue eyes. Caelen Veyr was a former Council member and a strict conservative. Lucas Alcazar is a complete absence from Toska's records. Toska is shorter than Lucas when he rises beside her; the top of her head reaches his chin. Lucas Alcazar was Caelen Veyr’s former apprentice.`,
    }]);

    assert.deepEqual(result.entities[0].profile, { roleBackground: ['Caelen Veyr’s former apprentice'] });
    assert.equal(result.entities[0].description, 'Role/background: Caelen Veyr’s former apprentice.');
    assert.equal(validation.discardedCharacterProfileDetails, 6);
});

test('an entity possessive object cannot make another person trait evidence for its owner', () => {
    const result = extraction();
    result.entities.push(
        {
            name: 'Lucas', type: 'person', aliases: [], importance: 4, description: '',
            characterProfile: { roleBackground: [], appearance: ['blue eyes'], personalityQuirks: [] },
        },
        { name: 'Toska', type: 'person', aliases: [], importance: 4, description: '' },
    );
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: "Lucas's shuttle carries Toska, whose blue eyes remain fixed on the viewport." }]);

    assert.deepEqual(result.entities[0].profile, {});
    assert.equal(validation.discardedCharacterProfileDetails, 1);
});

test('local pronoun ownership works in a multi-character scene without sharing the trait', () => {
    const result = extraction();
    result.entities.push(
        {
            name: 'Mara', type: 'person', aliases: [], importance: 4, description: '',
            characterProfile: { roleBackground: [], appearance: ['green eyes'], personalityQuirks: [] },
        },
        {
            name: 'John', type: 'person', aliases: [], importance: 4, description: '',
            characterProfile: { roleBackground: [], appearance: ['green eyes'], personalityQuirks: [] },
        },
    );
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Mara enters beside John. She has green eyes.' }]);

    assert.deepEqual(result.entities.find(item => item.name === 'Mara').profile, { appearance: ['green eyes'] });
    assert.deepEqual(result.entities.find(item => item.name === 'John').profile, {});
});

test('obvious field mismatches are reclassified without banning durable conditional traits', () => {
    const result = extraction();
    result.entities.push({
        name: 'Ilyra', type: 'person', aliases: [], importance: 4, description: '',
        characterProfile: {
            roleBackground: ['traditionalist'],
            appearance: [],
            personalityQuirks: ['eyes turn silver when casting magic'],
        },
    });
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Ilyra is a traditionalist. Ilyra’s eyes turn silver when casting magic.' }]);

    assert.deepEqual(result.entities[0].profile, {
        appearance: ['eyes turn silver when casting magic'], personalityQuirks: ['traditionalist'],
    });
});

test('field repair defers to valid model semantics when a phrase has mixed cues', () => {
    const result = extraction();
    result.entities.push({
        name: 'Rook', type: 'person', aliases: [], importance: 4, description: '',
        characterProfile: {
            roleBackground: ['scarred veteran'],
            appearance: [],
            personalityQuirks: ['short-tempered'],
        },
    });
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'Rook is a scarred veteran. Rook is short-tempered by nature.' }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['scarred veteran'], personalityQuirks: ['short-tempered'],
    });
});

test('appositive character introductions support genre-neutral profiles', () => {
    const result = extraction();
    result.entities.push({
        name: 'K-7', type: 'person', aliases: [], importance: 3, description: '',
        characterProfile: { roleBackground: ['court automaton'], appearance: ['brass skin'], personalityQuirks: [] },
    });
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', isUser: false, text: 'The court automaton K-7 has brass skin.' }]);

    assert.deepEqual(result.entities[0].profile, {
        roleBackground: ['court automaton'], appearance: ['brass skin'],
    });
});

test('identity resolution lets a stored placeholder relationship support its canonical name', () => {
    const result = extraction();
    result.identityResolutions.push({
        reference: "Toska's Former Master",
        canonical: 'Caelen Veyr',
        evidence: 'Toska identifies her former Jedi Master as Caelen Veyr.',
    });
    result.relationships.push({
        targetId: '', from: 'Toska', to: 'Caelen Veyr', kind: 'Jedi Master and Padawan', status: 'ended by death',
        dynamic: 'Caelen Veyr was Toska’s former Jedi Master; Toska remains loyal to and grieving for him.', importance: 5,
    });
    const world = {
        entities: [], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_former_master', from: 'Toska', to: "Toska's Former Master",
            kind: 'Jedi Master and Padawan', status: 'ended by death',
            dynamic: "Toska's Former Master was Toska's Jedi Master; Toska remains loyal to and grieving for him.",
            importance: 5,
        }],
    };
    const messages = [{
        name: 'Lucas Alcazar', isUser: false,
        text: 'Lucas reports, “Caelen Veyr was Toska’s former Jedi Master; Toska remains loyal to and grieving for him.”',
    }];

    const validation = sanitizeReconciliationMetadata(result, world, messages);

    assert.equal(validation.sourceAttributionConflicts.some(item => item.category === 'relationships'), false);
});

test('composite identity resolution canonicalizes a placeholder without triggering the stable-pair guard', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Pell'] },
    );
    result.identityResolutions.push({
        reference: 'the dead Jedi / Toska’s former Master / Pell',
        canonical: 'Caelen Veyr',
        evidence: 'Toska explicitly identifies her deceased former Master as Caelen Veyr and says he used the name Pell.',
    });
    result.relationships.push({
        targetId: 'relationship_former_master', from: 'Toska', to: 'Caelen Veyr',
        kind: 'Jedi Master and Padawan', status: 'ended by death',
        dynamic: 'Relationship between Toska and Caelen Veyr: Caelen Veyr was Toska’s Jedi Master; Toska remains loyal to and grieving for him.',
        importance: 5,
    });
    const world = {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Toska’s former Jedi Master', type: 'person', aliases: [] },
        ], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_former_master', from: 'Toska', to: 'Toska’s former Jedi Master',
            kind: 'Jedi Master and Padawan', status: 'ended by death',
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world);

    assert.equal(validation.normalizedIdentityReferences, 2);
    assert.equal(validation.relationshipEndpointConflicts.length, 0);
    assert.equal(result.relationships[0].targetId, 'relationship_former_master');
    assert.deepEqual(result.identityResolutions.map(item => item.reference), [
        'the dead Jedi', 'Toska’s former Master', 'Pell',
    ]);
});

test('explicit naming canonicalizes a descriptive identity before stable relationship validation', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Ari Lane', type: 'person', aliases: [] },
        { name: 'Doctor Vale', type: 'deceased guild master', aliases: ['Vale'] },
    );
    result.sceneCapsule = {
        participants: ['Ari Lane', 'Doctor Vale'],
        beats: ['Ari Lane reveals the true name of her former mentor as Doctor Vale.'],
    };
    result.relationships.push({
        targetId: 'relationship_mentor', from: 'Ari Lane', to: 'Doctor Vale',
        kind: 'former mentor and student', status: 'ended by death',
        dynamic: 'Doctor Vale was Ari Lane’s former mentor.', importance: 4,
    });
    result.threads.push({
        targetId: '', title: 'Why the mentor hid the archive', detail: 'The motive remains unknown.',
        status: 'open', participants: ['Ari Lane', 'Ari Lane’s former mentor'], importance: 3,
    });
    const world = {
        entities: [
            { name: 'Ari Lane', type: 'person', aliases: [] },
            { name: 'Ari Lane’s former mentor', type: 'person', aliases: [], description: 'A renowned guild master.' },
        ], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_mentor', from: 'Ari Lane', to: 'Ari Lane’s former mentor',
            kind: 'former mentor and student', status: 'ended by death',
            dynamic: 'Ari Lane was trained by her former mentor.',
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world, [{
        name: 'Ari Lane', text: 'My former mentor was Doctor Vale. Vale trained me in the guild archives.',
    }]);

    assert.equal(validation.recoveredIdentities, 1);
    assert.ok(validation.canonicalizedIdentityReferences >= 1);
    assert.deepEqual(result.identityResolutions, [{
        reference: 'Ari Lane’s former mentor', canonical: 'Doctor Vale',
        evidence: 'Ari Lane reveals the true name of her former mentor as Doctor Vale.',
    }]);
    assert.equal(result.relationships[0].targetId, 'relationship_mentor');
    assert.equal(result.relationships[0].to, 'Doctor Vale');
    assert.deepEqual(result.threads[0].participants, ['Ari Lane', 'Doctor Vale']);
    assert.equal(validation.relationshipEndpointConflicts.length, 0);
});

test('speculative naming never canonicalizes a descriptive identity', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Ari Lane', type: 'person', aliases: [] },
        { name: 'Doctor Vale', type: 'deceased guild master', aliases: [] },
    );
    result.sceneCapsule = { beats: ['Ari Lane wonders whether her former mentor might have been Doctor Vale.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Ari Lane’s former mentor', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Ari Lane', text: 'Could my former mentor have been Doctor Vale?' }]);

    assert.equal(validation.recoveredIdentities, 0);
    assert.deepEqual(result.identityResolutions, []);
});

test('an unsupported cross-role identity mapping is rejected before it can rewrite continuity', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Ari Lane', type: 'person', aliases: [] },
        { name: 'Captain Rhea', type: 'fleet commander', aliases: ['Rhea'] },
    );
    result.identityResolutions.push({
        reference: 'Ari Lane’s former mentor', canonical: 'Captain Rhea',
        evidence: 'The fleet salutes Captain Rhea as she takes command.',
    });
    result.relationships.push({
        targetId: 'relationship_mentor', from: 'Ari Lane', to: 'Ari Lane’s former mentor',
        kind: 'former mentor and student', status: 'ended', dynamic: 'The former mentor trained Ari.', importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Ari Lane', type: 'person', aliases: [] },
            { name: 'Ari Lane’s former mentor', type: 'guild master', aliases: [] },
        ], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_mentor', from: 'Ari Lane', to: 'Ari Lane’s former mentor',
            kind: 'former mentor and student', status: 'ended', dynamic: 'The former mentor trained Ari.',
        }],
    }, [{ name: 'Narrator', text: 'The fleet salutes Captain Rhea as she takes command.' }]);

    assert.equal(validation.discardedIdentityResolutions, 1);
    assert.deepEqual(result.identityResolutions, []);
    assert.equal(result.relationships[0].to, 'Ari Lane’s former mentor');
    assert.equal(result.relationships[0].targetId, 'relationship_mentor');
});

test('a stable relationship ID cannot change its participant pair', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
    );
    result.relationships.push({
        targetId: 'relationship_lucas_toska', from: 'Lucas Alcazar', to: 'Caelen Veyr',
        kind: 'captor and captive; prospective master and apprentice', status: 'active',
        dynamic: 'Lucas Alcazar is coercively attempting to reshape Toska into his Sith apprentice and undermines her deceased Master, Caelen Veyr; Toska remains resistant.',
        importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_lucas_toska', from: 'Lucas Alcazar', to: 'Toska',
            kind: 'captor and captive; prospective master and apprentice',
        }],
    });

    assert.equal(validation.relationshipEndpointConflicts.length, 1);
    assert.equal(validation.diagnosticWarnings.length, 0);
    assert.match(validation.relationshipEndpointConflicts[0].warning, /relationship IDs cannot change their participant pair/iu);
    assert.equal(result.relationships[0].targetId, '');
    assert.equal(applySourceAttributionFailClosed(result, validation.relationshipEndpointConflicts), 1);
    assert.equal(result.relationships.length, 0);
});

test('a relationship cannot resolve both endpoints to the same participant', () => {
    const result = extraction();
    result.entities.push({ name: 'Caelen Veyr', type: 'person', aliases: ['Pell'] });
    result.relationships.push({
        targetId: '', from: 'Caelen Veyr', to: 'Pell', kind: 'former Jedi master and Padawan',
        status: 'ended', dynamic: 'Caelen Veyr formerly trained a Padawan.', importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.relationshipEndpointConflicts.length, 1);
    assert.match(validation.relationshipEndpointConflicts[0].warning, /same participant/u);
});

test('explicit OOC canon and matching stored canon are not source-attribution conflicts', () => {
    const makeResult = () => {
        const result = extraction();
        result.facts.push({
            targetId: '', subject: 'Caelen Veyr', predicate: 'wartime command',
            value: 'Caelen Veyr commanded the Republic Twelfth Reconnaissance Fleet during the war.',
            category: 'biographical history', persistence: 'persistent', importance: 4,
        });
        return result;
    };
    const ooc = makeResult();
    const oocValidation = sanitizeReconciliationMetadata(ooc, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'User', isUser: true, text: 'OOC: canon: Caelen Veyr commanded the Republic Twelfth Reconnaissance Fleet during the war.' }]);
    assert.equal(oocValidation.sourceAttributionConflicts.length, 0);

    const known = makeResult();
    const knownValidation = sanitizeReconciliationMetadata(known, {
        entities: [], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{
            id: 'fact_command', subject: 'Caelen Veyr', predicate: 'wartime command',
            value: 'Caelen Veyr commanded the Republic Twelfth Reconnaissance Fleet during the war.',
            category: 'biographical history', persistence: 'persistent', importance: 4,
        }],
    }, [{ name: 'Toska', isUser: false, text: '“Caelen Veyr commanded the Republic Twelfth Reconnaissance Fleet during the war.”' }]);
    assert.equal(knownValidation.sourceAttributionConflicts.length, 0);
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

test('an extractor-confirmed completed thread is resolved instead of moving the goalposts', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_history', title: 'Describe life in hiding',
        detail: 'Toska has answered by describing deprivation, cramped training, and constant flight; broader implications remain only partly explored.',
        status: 'open', participants: ['Toska'], importance: 3,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Toska', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_history', title: 'Describe life in hiding', detail: 'Toska has not yet described it.',
            status: 'open', participants: ['Toska'], importance: 3,
        }],
    }, [{ name: 'Toska', text: 'We ate what we found, trained in cramped rooms, and fled whenever danger came.' }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads[0].status, 'resolved');
    assert.match(result.threads[0].detail, /Resolved by extracted continuity/);
});

test('an achieved atomic activity is resolved despite a vague broader-consequences goalpost', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_garden', title: 'Toska explores the moonbase garden',
        detail: 'Toska has reached the garden tier and begun exploring it; the extent and consequences of her broader exploration remain open.',
        status: 'open', participants: ['Toska'], importance: 3,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Toska', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_garden', title: 'Toska explores the moonbase garden',
            detail: 'Toska intends to explore the garden tier.', status: 'open', participants: ['Toska'], importance: 3,
        }],
    }, [{ name: 'Toska', text: 'Toska enters the garden and rests her hand in its grass.' }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads[0].status, 'resolved');
});

test('preliminary progress cannot resolve a thread whose incoming update states the real gap', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['Lucas contacts the retrieval team and departs for bay four.'] };
    result.threads.push({
        targetId: 'thread_saber', title: 'Recover Toska’s green lightsaber',
        detail: 'The retrieval team has been contacted, but the lightsaber remains in bay four and has not been recovered.',
        status: 'open', participants: ['Lucas', 'Toska'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Lucas', type: 'person', aliases: [] },
            { name: 'Toska', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_saber', title: 'Recover Toska’s green lightsaber',
            detail: 'Lucas must recover Toska’s green lightsaber.', status: 'open', participants: ['Lucas', 'Toska'], importance: 4,
        }],
    }, [{ name: 'Lucas', text: 'Contact the team. We are going to bay four; the saber is still there.' }]);

    assert.equal(validation.reconciledThreads, 0);
    assert.equal(result.threads[0].status, 'open');
});

test('answering one item cannot resolve a broad multi-topic uncertainty thread', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_history', title: 'Unresolved circumstances surrounding Mentor Vale',
        detail: 'Resolved by extracted continuity: Ari now knows Rowan was Mentor Vale’s former apprentice.',
        status: 'resolved', participants: ['Ari', 'Rowan', 'Mentor Vale'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Ari', type: 'person', aliases: [] },
            { name: 'Rowan', type: 'person', aliases: [] },
            { name: 'Mentor Vale', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_history', title: 'Unresolved circumstances surrounding Mentor Vale',
            detail: 'Ari knows Mentor Vale had a former apprentice, but the truth of the apprentice’s failures, hidden history, additional claims, and demanded proof remains unresolved.',
            status: 'open', participants: ['Ari', 'Rowan', 'Mentor Vale'], importance: 4,
        }],
    }, [{ name: 'Rowan', text: 'The former apprentice was Rowan.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
    assert.match(result.threads[0].detail, /failures, hidden history/iu);
});

test('a historical event that never answered why cannot resolve the why thread', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['Caelen rescued Toska from the refugee district but never told her why he was there.'] };
    result.threads.push({
        targetId: 'thread_why', title: 'Why Caelen found Toska at the refugee fire',
        detail: 'Caelen rescued Toska from the destroyed refugee district but never told her why he was there.',
        status: 'resolved', participants: ['Caelen Veyr', 'Toska'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
            { name: 'Toska', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_why', title: 'Why Caelen found Toska at the refugee fire',
            detail: 'Toska does not know why Caelen found her there.', status: 'open',
            participants: ['Caelen Veyr', 'Toska'], importance: 4,
        }],
    }, [{ name: 'Toska', text: 'Caelen never told me why he was there.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
});

test('preparing to recover an object is not mistaken for recovery', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_saber', title: 'Recovery of Toska’s green lightsaber',
        detail: 'The retrieval team is in low orbit and preparing to land to recover Toska’s saber.',
        status: 'open', participants: ['Toska'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Toska', type: 'person', aliases: [] }], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_saber', title: 'Recovery of Toska’s green lightsaber',
            detail: 'A team will recover the saber.', status: 'open', participants: ['Toska'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'The team prepares to land; the saber has not been recovered.' }]);

    assert.equal(validation.reconciledThreads, 0);
    assert.equal(result.threads[0].status, 'open');
});

test('a model-supplied resolved thread is reopened when its own detail says the action is unfinished', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_saber', title: 'Recovery of Toska’s green lightsaber',
        detail: 'Resolved by extracted continuity: The team is preparing to land and must still recover the saber.',
        status: 'resolved', participants: ['Toska'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Toska', type: 'person', aliases: [] }], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_saber', title: 'Recovery of Toska’s green lightsaber',
            detail: 'A team will recover the saber.', status: 'open', participants: ['Toska'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'The team is preparing to land; the saber remains at the site.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
    assert.equal(result.threads[0].detail, 'A team will recover the saber.');
});

test('a newly introduced resolved thread becomes open when its deadline and delivery remain pending', () => {
    const result = extraction();
    result.threads.push({
        targetId: '', title: 'Can Mara fulfill the three-day delivery?',
        detail: 'Resolved by extracted continuity: Mara must deliver the archive to Sol within three days.',
        status: 'resolved', participants: ['Mara', 'Sol'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Mara', type: 'person', aliases: [] },
            { name: 'Sol', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [], threads: [],
    }, [{ name: 'Sol', text: 'You must deliver the archive to me within three days.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
    assert.equal(result.threads[0].detail, 'Mara must deliver the archive to Sol within three days.');
});

test('receiving somebody else’s report cannot resolve a thread to make a future report', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_report', title: 'What will Lucas report about Caelen’s death?',
        detail: 'Resolved by explicit continuity: Lucas entered the hall and received Maren’s damage report.',
        status: 'resolved', participants: ['Lucas', 'Caelen'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Lucas', type: 'person', aliases: [] },
            { name: 'Caelen', type: 'person', aliases: [] },
            { name: 'Maren', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_report', title: 'What will Lucas report about Caelen’s death?',
            detail: 'Lucas has not yet reported Caelen’s death.', status: 'open',
            participants: ['Lucas', 'Caelen'], importance: 4,
        }],
    }, [{ name: 'Maren', text: 'Lucas entered the hall and received my damage report.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
});

test('a concise completed contact update can resolve an unanswered request thread', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_contact', title: 'Sol’s unanswered status request',
        detail: 'Resolved: Sol’s unanswered request led to live contact with Mara on an active channel.',
        status: 'resolved', participants: ['Sol', 'Mara'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Sol', type: 'person', aliases: [] },
            { name: 'Mara', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_contact', title: 'Sol’s unanswered status request',
            detail: 'Sol’s request remains unanswered.', status: 'open', participants: ['Sol', 'Mara'], importance: 4,
        }],
    }, [{ name: 'Mara', text: 'The channel opens and I establish live contact with Sol.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 0);
    assert.equal(result.threads[0].status, 'resolved');
});

test('an unrelated completed action cannot resolve a decision thread by sharing its topic words', () => {
    const result = extraction();
    result.events.push({
        title: 'Dask sanitizes the log',
        summary: 'Dask returned to the relay and omitted the co-Sith declaration from the routine log.',
        consequences: 'The co-Sith claim remains absent from the record.',
        participants: ['Dask'], importance: 3,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Darth Segundus', type: 'person', aliases: [] },
            { name: 'Lucas', type: 'person', aliases: [] },
            { name: 'Dask', type: 'person', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_claim', title: 'Will Segundus accept Lucas’s co-Sith claim?',
            detail: 'Segundus has not yet accepted or rejected the claim.', status: 'open',
            participants: ['Darth Segundus', 'Lucas'], importance: 4,
        }],
    }, [{ name: 'Dask', text: 'I returned to the relay and omitted the co-Sith declaration from the log.' }]);

    assert.equal(validation.reconciledThreads, 0);
    assert.deepEqual(result.threads, []);
});

test('a completed two-part task is resolved from a source-backed event even when beats split the actions', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Nima', type: 'person', aliases: [] },
    );
    result.sceneCapsule = { beats: [
        'Toska confirms the training saber still functions.',
        'Nima returns with a medkit and applies a bacta strip.',
    ] };
    result.events.push({
        title: 'Nima tends Toska',
        summary: 'Nima recovers the training saber, fetches pain supplies in a medkit, and applies bacta to Toska.',
        consequences: 'The saber and pain supplies are both in use.',
        participants: ['Nima', 'Toska'], importance: 3,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_supplies', title: 'Retrieve the training saber and pain supplies',
            detail: 'Nima must recover the training saber and obtain pain supplies; neither task is completed.',
            status: 'open', participants: ['Nima', 'Toska'], importance: 3,
        }],
    }, [{
        name: 'Nima',
        text: 'Nima recovers the training saber, returns with the pain-supply medkit, and applies a bacta strip to Toska.',
    }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads.length, 1);
    assert.equal(result.threads[0].targetId, 'thread_supplies');
    assert.equal(result.threads[0].status, 'resolved');
});

test('a resolved identity thread cannot stay open by moving its remaining question into the old title', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Ari Lane', type: 'person', aliases: [] },
        { name: 'Doctor Vale', type: 'deceased guild master', aliases: [] },
    );
    result.identityResolutions.push({
        reference: 'Ari Lane’s former mentor', canonical: 'Doctor Vale',
        evidence: 'Ari identifies her former mentor as Doctor Vale.',
    });
    result.threads.push({
        targetId: 'thread_identity', title: 'Ari Lane’s former mentor’s true identity',
        detail: 'Doctor Vale is now identified, but the reason for the concealment remains unknown.',
        status: 'open', participants: ['Ari Lane', 'Doctor Vale'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Ari Lane', type: 'person', aliases: [] },
            { name: 'Ari Lane’s former mentor', type: 'guild master', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_identity', title: 'Ari Lane’s former mentor’s true identity',
            detail: 'The mentor’s identity remains unknown.', status: 'open',
            participants: ['Ari Lane', 'Ari Lane’s former mentor'], importance: 4,
        }],
    }, [{ name: 'Ari Lane', text: 'My former mentor was Doctor Vale. Why the guild hid that remains unknown.' }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads.length, 2);
    assert.equal(result.threads[0].targetId, 'thread_identity');
    assert.equal(result.threads[0].status, 'resolved');
    assert.equal(result.threads[1].targetId, '');
    assert.equal(result.threads[1].status, 'open');
    assert.match(result.threads[1].title, /Unresolved circumstances surrounding Doctor Vale/);
    assert.match(result.threads[1].detail, /reason for the concealment remains unknown/);
});

test('a later unrelated identity reveal cannot rewrite an already resolved thread', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_mentor_identity', title: 'Ari Lane’s former mentor’s true identity',
        detail: 'The masked commander is revealed as Captain Rhea.', status: 'resolved',
        participants: ['Ari Lane', 'Captain Rhea'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_mentor_identity', title: 'Ari Lane’s former mentor’s true identity',
            detail: 'Resolved by explicit continuity: Ari identified Doctor Vale as her former mentor.',
            status: 'resolved', participants: ['Ari Lane', 'Doctor Vale'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'The masked commander is revealed as Captain Rhea.' }]);

    assert.equal(validation.preservedResolvedThreads, 1);
    assert.equal(result.threads[0].status, 'resolved');
    assert.match(result.threads[0].detail, /Ari identified Doctor Vale/);
    assert.deepEqual(result.threads[0].participants, ['Ari Lane', 'Doctor Vale']);
});

test('a source-explicit future commitment becomes an open thread even when extraction omits it', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Captain Rhea', type: 'fleet commander', aliases: ['Rhea'] },
        { name: 'Envoy Sol', type: 'diplomat', aliases: ['Sol'] },
    );
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Captain Rhea', text: "I tell the crew I'll be going tomorrow to meet Envoy Sol; they remain aboard." }]);

    assert.equal(validation.recoveredCommitments, 1);
    assert.equal(result.threads.length, 1);
    assert.equal(result.threads[0].status, 'open');
    assert.match(result.threads[0].title, /^Captain Rhea will go tomorrow to meet Envoy Sol/);
    assert.deepEqual(result.threads[0].participants, ['Captain Rhea', 'Envoy Sol']);
});

test('speculative or unanchored future wording is not promoted into a commitment', () => {
    const result = extraction();
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [
        { name: 'Ari', text: 'I might meet the envoy tomorrow, perhaps.' },
        { name: 'Ari', text: 'I will open the door.' },
    ]);

    assert.equal(validation.recoveredCommitments, 0);
    assert.equal(result.threads.length, 0);
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

test('a role-name apposition resolves a descriptive identity across a chunk boundary', () => {
    const result = extraction();
    result.entities.push({
        name: 'Caelen Veyr', type: 'person', aliases: ['Master Caelen Veyr'],
        description: 'Details about Caelen Veyr remain disputed or attributed in this excerpt; consult character perspectives and source history.',
    });
    result.sceneCapsule = { beats: ['Toska identifies her deceased Jedi Master as Caelen Veyr.'] };
    const world = {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Toska’s former Jedi Master', type: 'person', aliases: [], description: 'A formerly renowned Jedi Master.' },
        ], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            from: 'Toska', to: 'Toska’s former Jedi Master', kind: 'Jedi Master and Padawan', status: 'ended',
        }],
    };

    const validation = sanitizeReconciliationMetadata(result, world, [{
        name: 'Toska', text: 'Caelen Veyr. Jedi Master Caelen Veyr.',
    }]);

    assert.equal(validation.recoveredIdentities, 1);
    assert.ok(result.identityResolutions.some(item =>
        item.reference === 'Toska’s former Jedi Master' && item.canonical === 'Caelen Veyr'));
});

test('a source-established alias becomes the canonical name of a descriptive entity', () => {
    const result = extraction();
    result.entities.push({
        targetId: 'entity_master', name: 'Toska’s former master', type: 'person',
        aliases: ['Jedi Master', 'Caelen Veyr', 'Jedi Master Caelen Veyr', 'Pell'],
        description: 'Toska’s deceased Jedi Master.',
    });
    result.sceneCapsule = { beats: ['Toska identifies her deceased Jedi Master as Caelen Veyr.'] };
    result.relationships.push({
        from: 'Toska', to: 'Toska’s former master', kind: 'Jedi Master and Padawan', status: 'ended',
        dynamic: 'Toska was the Padawan of Toska’s former master.', importance: 4,
    });
    const world = {
        entities: [
            { id: 'entity_master', name: 'Toska’s former master', type: 'person', aliases: [] },
            { name: 'Toska', type: 'person', aliases: [] },
        ], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{ from: 'Toska', to: 'Toska’s former master', kind: 'Jedi Master and Padawan', status: 'ended' }],
    };

    sanitizeReconciliationMetadata(result, world, [{
        name: 'Toska', text: 'Caelen Veyr. Jedi Master Caelen Veyr.',
    }]);

    assert.equal(result.entities[0].name, 'Caelen Veyr');
    assert.ok(result.entities[0].aliases.includes('Toska’s former master'));
    assert.equal(result.relationships[0].to, 'Caelen Veyr');
    assert.ok(result.identityResolutions.some(item => item.reference === 'Toska’s former master'
        && item.canonical === 'Caelen Veyr'));
});

test('a mixed-owner role placeholder is normalized to its grammatical owner', () => {
    const result = extraction();
    result.entities.push({
        name: 'Toska’s former apprentice of Caelen Veyr', type: 'person', aliases: [],
        description: 'Identity remains uncertain.',
    });
    result.facts.push({
        subject: 'Toska’s former apprentice of Caelen Veyr', predicate: 'identity',
        value: 'The apprentice remains unidentified.', category: 'identity', importance: 3, persistence: 'persistent',
    });
    result.threads.push({
        title: 'Identify Caelen Veyr’s former apprentice', detail: 'The identity remains unknown.', status: 'open',
        participants: ['Toska', 'Toska’s former apprentice of Caelen Veyr'], importance: 4,
    });

    sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
        ], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, []);

    assert.equal(result.entities[0].name, 'Caelen Veyr’s former apprentice');
    assert.equal(result.facts[0].subject, 'Caelen Veyr’s former apprentice');
    assert.deepEqual(result.threads[0].participants, ['Toska', 'Caelen Veyr’s former apprentice']);
});

test('a resolved descriptive identity replaces an objective unknown-identity fact', () => {
    const result = extraction();
    result.entities.push({ name: 'Caelen Veyr', type: 'person', aliases: ['Toska’s former master'] });
    result.identityResolutions.push({
        reference: 'Toska’s former master', canonical: 'Caelen Veyr',
        evidence: 'Toska explicitly identifies her former master as Caelen Veyr.',
    });
    sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Toska’s former master', type: 'person', aliases: [] },
        ], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{
            id: 'fact_unknown_identity', subject: 'Toska’s former master', predicate: 'true name and former identity',
            value: 'Unknown; no answer has yet been given.', category: 'identity', importance: 3, persistence: 'persistent',
        }],
    }, [{ name: 'Toska', text: 'My former master was Caelen Veyr.' }]);

    const update = result.facts.find(item => item.targetId === 'fact_unknown_identity');
    assert.equal(update?.subject, 'Toska’s former master');
    assert.match(update?.value || '', /established identity/iu);
    assert.doesNotMatch(update?.value || '', /unknown|no answer/iu);
});

test('a holder-confirmed descriptive identity supersedes that holder’s stale unknown-identity boundary', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'Jedi Master', aliases: ['Caelen'] },
    );
    result.identityResolutions.push({
        reference: 'Toska’s deceased Jedi Master', canonical: 'Caelen Veyr',
        evidence: 'Toska explicitly identifies her deceased Jedi Master as Caelen Veyr.',
    });
    result.facts.push({
        subject: 'Toska', predicate: 'knowledge of Caelen Veyr', value: 'Toska identifies her deceased Master as Caelen Veyr.',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{
            id: 'fact_unknown_master', subject: 'Toska', predicate: 'knowledge of her deceased Jedi Master’s true identity',
            value: 'Toska has not yet disclosed or established her Master’s true identity.',
            category: 'knowledge boundary', importance: 3, persistence: 'persistent',
        }],
    }, [{ name: 'Toska', text: 'My deceased Jedi Master was Caelen Veyr.' }]);

    assert.equal(validation.supersededIdentityBoundaries, 1);
    assert.ok(result.facts.some(item => item.targetId === 'fact_unknown_master'
        && item.category === 'knowledge' && /is Caelen Veyr/iu.test(item.value)), JSON.stringify(result.facts));
});

test('reapplying a possessive identity resolution never turns its owner into the resolved person', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
    );
    result.identityResolutions.push({
        reference: 'Toska’s former master', canonical: 'Caelen Veyr',
        evidence: 'Toska explicitly names Caelen Veyr as her former master.',
    });
    result.relationships.push({
        from: 'Toska', to: 'Caelen Veyr', kind: 'former Jedi master and Padawan', status: 'ended',
        dynamic: 'Caelen Veyr was Toska’s former Jedi master.', importance: 5,
    });
    sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Toska’s former master', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Toska', text: 'Caelen Veyr was my Jedi Master.' }]);

    assert.equal(result.relationships[0].from, 'Toska');
    assert.equal(result.relationships[0].to, 'Caelen Veyr');
});

test('relational knowledge topics canonicalize and reversed self-identification knowledge changes holder', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
    );
    result.relationships.push({
        from: 'Toska', to: 'Caelen Veyr', kind: 'Jedi Master and Padawan', status: 'ended',
        dynamic: 'Toska was Caelen Veyr’s Padawan.', importance: 4,
    }, [{ name: 'Toska', text: 'My former master was Caelen Veyr.' }]);
    result.facts.push(
        {
            subject: 'Toska', predicate: "knowledge of her former master's true identity",
            value: 'Toska did not know Caelen held a Council seat.', category: 'knowledge', persistence: 'persistent', importance: 4,
        },
        {
            subject: 'Toska', predicate: 'knowledge of Lucas Alcazar',
            value: 'Toska identifies herself as Toska after Lucas threatens her.', category: 'knowledge', persistence: 'persistent', importance: 4,
        },
    );

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Toska', text: 'Caelen Veyr was my Jedi Master. My name is Toska.' }]);

    assert.equal(validation.normalizedRelationalKnowledge, 1);
    assert.equal(result.facts[0].predicate, 'knowledge of Caelen Veyr');
    assert.equal(validation.repairedSelfIdentificationKnowledge, 1);
    assert.equal(result.facts[1].subject, 'Lucas Alcazar');
    assert.equal(result.facts[1].predicate, 'knowledge of Toska');
});

test('stored relationship roles repair a later disputed entity placeholder', () => {
    const result = extraction();
    result.entities.push({
        name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
        description: 'Details about Caelen Veyr remain disputed or attributed in this excerpt; consult character perspectives and source history.',
    });
    sanitizeReconciliationMetadata(result, {
        entities: [{
            name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
            description: 'Details about Caelen Veyr remain disputed or attributed in this excerpt; consult character perspectives and source history.',
        }],
        facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            from: 'Toska', to: 'Caelen Veyr', kind: 'Jedi Master and Padawan', status: 'ended',
            dynamic: 'Toska was Caelen Veyr’s Padawan and grieves his death.',
        }],
    }, [{ name: 'Lucas', text: 'I believe Caelen lied about his Council history.' }]);

    assert.equal(result.entities[0].description, 'Role/background: Jedi Master.');
});

test('relationship fallback never copies a subject clause into the object participant biography', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: [], description: 'Details about Lucas Alcazar remain disputed or attributed in this excerpt; consult character perspectives and source history.' },
        { name: 'Toska', type: 'person', aliases: [], description: 'Details about Toska remain disputed or attributed in this excerpt; consult character perspectives and source history.' },
    );
    const relationship = {
        from: 'Lucas Alcazar', to: 'Toska', kind: 'captor and captive', status: 'active',
        dynamic: 'Relationship between Lucas Alcazar and Toska: Lucas Alcazar captured and restrained Toska as his captive; Toska remains defiant.', importance: 4,
    };

    recoverRelationshipBackedEntityDescriptions(result, {
        entities: [], facts: [], states: [], relationships: [relationship], threads: [], backgrounds: [],
    }, null);

    assert.match(result.entities[0].description, /^Lucas Alcazar captured/iu);
    assert.doesNotMatch(result.entities[1].description, /^Lucas Alcazar captured/iu);
});

test('role facts enrich entity biographies as complete grammatical sentences', () => {
    const result = extraction();
    result.entities.push({
        name: 'Lucas Alcazar', type: 'person', aliases: [],
        description: 'Lucas Alcazar captured Toska and intends to train her.', importance: 4,
    });
    result.facts.push({
        subject: 'Lucas Alcazar', predicate: 'serves', value: 'Darth Segundus as his Sith apprentice',
        category: 'role', persistence: 'persistent', importance: 4,
    });

    enrichEntityDescriptionsFromEstablishedFacts(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(result.entities[0].description, 'Lucas Alcazar captured Toska and intends to train her. Lucas Alcazar serves Darth Segundus as his Sith apprentice.');
});

test('validated identity resolution preserves placeholder entity and relationship target anchors', () => {
    const result = extraction();
    result.entities.push({
        targetId: 'entity_master', name: 'Caelen Veyr', type: 'person', aliases: ['Pell'],
        description: 'Caelen Veyr was Toska’s Jedi Master.', importance: 5,
    });
    result.identityResolutions.push({
        reference: 'Toska’s deceased master', canonical: 'Caelen Veyr',
        evidence: 'Toska explicitly names her deceased master as Jedi Master Caelen Veyr.',
    });
    result.relationships.push({
        targetId: 'relationship_master', from: 'Toska', to: 'Caelen Veyr',
        kind: 'Jedi master and Padawan', status: 'ended',
        dynamic: 'Relationship between Toska and Caelen Veyr: Toska was Caelen Veyr’s Padawan.', importance: 4,
    });

    const stored = {
        entities: [{ id: 'entity_master', name: 'Toska’s deceased master', type: 'person', aliases: [] }],
        facts: [], states: [], threads: [], backgrounds: [],
        relationships: [{
            id: 'relationship_master', from: 'Toska', to: 'Toska’s deceased master',
            kind: 'Jedi master and Padawan', status: 'ended',
            dynamic: 'Toska was the deceased master’s Padawan.',
        }],
    };

    assert.equal(reconciliationTargetIsCompatible('entities', result.entities[0], stored.entities[0], stored, result), true);
    assert.equal(reconciliationTargetIsCompatible('relationships', result.relationships[0], stored.relationships[0], stored, result), true);
});

test('pronoun relationship descriptions restore the canonical participant role', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Pell'], description: 'Toska was his Padawan and remains loyal to his memory.' },
    );
    result.relationships.push({
        from: 'Toska', to: 'Caelen Veyr', kind: 'Jedi master and Padawan', status: 'ended',
        dynamic: 'Relationship between Toska and Caelen Veyr: Toska was his Padawan and remains loyal to his memory.', importance: 4,
    });

    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Toska', text: 'Caelen Veyr was my Jedi Master.' }]);

    assert.equal(result.entities[1].description, 'Role/background: Jedi Master.');
});

test('knowledge taxonomy suffixes canonicalize and membership boundaries remove vague overclaims only', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
    );
    result.identityResolutions.push({
        reference: 'Toska’s former master', canonical: 'Caelen Veyr',
        evidence: 'Toska identifies her master as Caelen Veyr, a former High Council member and Republic commander.',
    });
    result.facts.push(
        {
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr’s High Council status — MEMBERSHIP',
            value: 'Toska knew his name, but did not know that he had been in the High Council.',
            category: 'knowledge boundary', persistence: 'persistent', importance: 4,
        },
        {
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska identified Caelen as a former High Council member and Republic military commander who used the alias Pell.',
            category: 'knowledge', persistence: 'persistent', importance: 4,
        },
    );

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Toska', text: 'My former master was Caelen Veyr.' }]);

    assert.equal(validation.normalizedKnowledgePredicates, 1);
    assert.equal(validation.repairedKnowledgeMembershipOverclaims, 2);
    assert.equal(result.facts[0].predicate, 'knowledge of Caelen Veyr’s High Council status');
    assert.equal(result.facts[1].predicate, 'knowledge of Caelen Veyr');
    assert.doesNotMatch(result.facts[1].value, /High Council/iu);
    assert.match(result.facts[1].value, /Republic military commander/iu);
    assert.match(result.facts[1].value, /alias Pell/iu);
    assert.doesNotMatch(result.identityResolutions[0].evidence, /High Council/iu);
});

test('uncertain membership knowledge constrains a conflicting broad positive summary', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
    );
    result.facts.push(
        {
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr’s former identity',
            value: 'She now knows his name and Republic history, plus possible High Council history and a claimed former apprentice.',
            category: 'knowledge', persistence: 'persistent', importance: 4,
        },
        {
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr',
            value: 'Toska identifies Caelen and describes his High Council, Republic fleet, and concealed life as Pell.',
            category: 'knowledge', persistence: 'persistent', importance: 4,
        },
    );

    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.repairedKnowledgeMembershipOverclaims, 1);
    assert.match(result.facts[0].value, /possible High Council history/iu);
    assert.doesNotMatch(result.facts[1].value, /High Council/iu);
    assert.match(result.facts[1].value, /Republic fleet/iu);
});

test('an identify-title thread resolves when its descriptive reference receives a canonical name', () => {
    const result = extraction();
    result.identityResolutions.push({
        reference: 'Toska’s former master', canonical: 'Caelen Veyr',
        evidence: 'Toska identifies her deceased master as Jedi Master Caelen Veyr.',
    });
    result.threads.push({
        targetId: 'thread_identity', title: 'Identify Toska’s former master',
        detail: 'His identity and prior status remain undisclosed.', status: 'open', participants: ['Toska'], importance: 4,
    });

    const stored = {
        entities: [{ name: 'Toska’s former master', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_identity', title: 'Identify Toska’s former master',
            detail: 'His identity and prior status remain undisclosed.', status: 'open', participants: ['Toska'], importance: 4,
        }],
    };
    reconcileResolvedIdentityThreads(result, stored);

    assert.equal(result.threads.find(item => item.targetId === 'thread_identity')?.status, 'resolved');
    assert.equal(result.threads.some(item => item.targetId === '' && item.status === 'open'), false);
});

test('suspicion and partial clarification cannot resolve an objective open question', () => {
    const result = extraction();
    result.threads.push(
        {
            targetId: 'thread_target', title: 'Who misrepresented the Jedi target',
            detail: 'Toska suspects Lucas was sent false information because he found a Jedi Master.',
            status: 'resolved', participants: ['Toska', 'Lucas Alcazar'], importance: 3,
        },
        {
            title: 'What was the former master before the Purge',
            detail: 'Partially clarified: Lucas claims the former master held a Council seat.',
            status: 'open', participants: ['Toska', 'Lucas Alcazar'], importance: 3,
        },
    );
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_target', title: 'Who misrepresented the Jedi target',
            detail: 'The source of the false mission information remains unknown.',
            status: 'open', participants: ['Toska', 'Lucas Alcazar'], importance: 3,
        }],
    }, [{ name: 'Toska', text: 'I suspect someone sent you false information, but I have no proof.' }]);

    assert.equal(result.threads[0].status, 'open');
    assert.equal(result.threads[1].status, 'open');
});

test('authoritative OOC concealed identity becomes holder boundaries and removes the mixed rider', () => {
    const result = extraction();
    result.sceneCapsule = { beats: [], participants: ['Lucas Alcazar', 'Toska', 'Loyalist Pilot'] };
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Loyalist Pilot', type: 'person', aliases: ['pilot'] },
    );
    result.facts.push({
        subject: 'Lucas Alcazar', predicate: 'former identity',
        value: 'Lucas Alcazar was formerly Caelen Veyr’s apprentice; he is now a Sith apprentice, but his Sith name is not established and no one in the scene knows that he is Lucas.',
        category: 'identity', importance: 5, persistence: 'persistent',
    }, {
        subject: 'Toska', predicate: 'knowledge of Lucas Alcazar’s identity',
        value: 'Toska has learned that the current Sith is Lucas Alcazar.',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
    result.threads.push({
        title: 'Caelen Veyr’s former apprentice',
        detail: 'Resolved as to identity when Lucas names himself as Caelen’s former apprentice.',
        status: 'resolved', participants: ['Lucas Alcazar', 'Toska'], importance: 4,
    });

    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Lucas', text: 'Lucas Alcazar. OOC: No one knows I am Lucas. That is not my Sith name.' }]);

    assert.equal(validation.recoveredOocIdentityBoundaries, 4);
    for (const holder of ['Toska', 'Loyalist Pilot']) {
        assert.ok(result.facts.some(item => item.subject === holder
            && item.predicate === 'knowledge of Lucas Alcazar’s identity'
            && item.category === 'knowledge boundary'));
        assert.ok(result.threads.some(item => item.status === 'open'
            && item.title.includes(holder) && item.title.includes('Lucas Alcazar')));
    }
    assert.equal(result.facts.some(item => item.subject === 'Toska'
        && item.category === 'knowledge' && /current Sith is Lucas/iu.test(item.value)), false);
    const identity = result.facts.find(item => item.subject === 'Lucas Alcazar' && item.predicate === 'former identity');
    assert.equal(identity.value, 'Lucas Alcazar was formerly Caelen Veyr’s apprentice; he is now a Sith apprentice');
    const historicalIdentityThread = result.threads.find(item => item.title === 'Caelen Veyr’s former apprentice');
    assert.equal(historicalIdentityThread.status, 'resolved');
    assert.doesNotMatch(historicalIdentityThread.detail, /names himself/iu);
    assert.match(historicalIdentityThread.detail, /name only|knowledge boundar/iu);
});

test('an active identity boundary blocks canonical-name leakage from model knowledge prose', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [], description: '', importance: 5 },
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Darth Lucifer'], description: '', importance: 5 },
    );
    result.facts.push({
        targetId: '', subject: 'Toska', predicate: 'knowledge of Lucas Alcazar',
        value: 'Toska knows Lucas Alcazar was Caelen Veyr’s former apprentice.',
        category: 'knowledge', importance: 5, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities,
        facts: [{
            id: 'boundary', subject: 'Toska', predicate: 'knowledge of Lucas Alcazar’s identity',
            value: 'Toska does not know that the current figure’s true identity is Lucas Alcazar.',
            category: 'knowledge boundary', importance: 5, persistence: 'persistent',
        }],
        states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Darth Lucifer', isUser: false,
        text: '“I was Caelen’s former apprentice,” he tells Toska. He does not give his former name.',
    }]);

    assert.equal(result.facts.some(item => item.category === 'knowledge' && /Lucas Alcazar/iu.test(item.value)), false);
    assert.equal(validation.discardedKnowledgeBoundaryLeaks, 1);
});

test('explicit raw identity discovery may cross an older identity boundary', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [], description: '', importance: 5 },
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Darth Lucifer'], description: '', importance: 5 },
    );
    result.facts.push({
        targetId: '', subject: 'Toska', predicate: 'knowledge of Lucas Alcazar’s identity',
        value: 'Toska now knows the current figure is Lucas Alcazar.',
        category: 'knowledge', importance: 5, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities,
        facts: [{
            id: 'boundary', subject: 'Toska', predicate: 'knowledge of Lucas Alcazar’s identity',
            value: 'Toska does not know that the current figure’s true identity is Lucas Alcazar.',
            category: 'knowledge boundary', importance: 5, persistence: 'persistent',
        }],
        states: [], relationships: [], threads: [], backgrounds: [],
    }, [{
        name: 'Narrator', isUser: false,
        text: 'Toska recognizes the masked figure as Lucas Alcazar and now knows his true identity.',
    }]);

    assert.equal(result.facts.some(item => item.category === 'knowledge' && /Lucas Alcazar/iu.test(item.value)), true);
    assert.equal(validation.discardedKnowledgeBoundaryLeaks, 0);
});

test('an unrelated unknown detail cannot preserve false current-identity recognition against OOC canon', () => {
    const result = extraction();
    result.sceneCapsule = { beats: [], participants: ['Lucas Alcazar', 'Toska', 'Loyalist Pilot'] };
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Loyalist Pilot', type: 'person', aliases: [] },
    );
    result.facts.push({
        subject: 'Toska', predicate: 'knowledge of Lucas Alcazar’s identity',
        value: 'Toska now knows Lucas Alcazar was Caelen Veyr’s former apprentice, but does not know how Lucas became Sith or his Sith name.',
        category: 'knowledge', importance: 3, persistence: 'persistent',
    });

    sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Lucas', text: 'Lucas Alcazar. OOC: No one knows I am Lucas. That is not my Sith name.' }]);

    const toskaIdentityFacts = result.facts.filter(item => item.subject === 'Toska'
        && item.predicate === 'knowledge of Lucas Alcazar’s identity');
    assert.equal(toskaIdentityFacts.length, 1);
    assert.equal(toskaIdentityFacts[0].category, 'knowledge boundary');
    assert.match(toskaIdentityFacts[0].value, /does not know that the current figure/iu);
    assert.equal(result.relationships.some(item => [item.from, item.to].includes('Toska')
        && [item.from, item.to].includes('Lucas Alcazar') && /apprentice/iu.test(item.kind)), false);
});

test('duplicate same-role relationship anchors recover a previously established named identity', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Ari Lane', type: 'person', aliases: [] },
        { name: 'Doctor Vale', type: 'guild master', aliases: [] },
    );
    result.sceneCapsule = { beats: ['Ari Lane discusses her former mentor’s archived work.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], threads: [], backgrounds: [],
        relationships: [
            { from: 'Ari Lane', to: 'Ari Lane’s former mentor', kind: 'former mentor and student', status: 'ended' },
            { from: 'Ari Lane', to: 'Doctor Vale', kind: 'former mentor and student', status: 'ended' },
        ],
    }, [{ name: 'Ari Lane', text: 'I review my former mentor’s archived work.' }]);

    assert.equal(validation.recoveredIdentities, 1);
    assert.deepEqual(result.identityResolutions, [{
        reference: 'Ari Lane’s former mentor', canonical: 'Doctor Vale',
        evidence: 'Stable relationship continuity identifies Ari Lane’s former mentor as Doctor Vale.',
    }]);
});

test('a different current relationship cannot hijack a named former mentor identity', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
    );
    result.sceneCapsule = { beats: [
        'Toska identifies her deceased Jedi Master as Caelen Veyr.',
    ] };
    result.identityResolutions.push({
        reference: 'Toska’s former Jedi Master', canonical: 'Lucas Alcazar',
        evidence: 'Stable relationship continuity identifies Toska’s former Jedi Master as Lucas Alcazar.',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Lucas Alcazar', type: 'person', aliases: [] },
            { name: 'Toska’s former Jedi Master', type: 'person', aliases: [] },
        ], facts: [], states: [], threads: [], backgrounds: [],
        relationships: [
            { from: 'Toska', to: 'Toska’s former Jedi Master', kind: 'former Jedi master and apprentice', status: 'ended' },
            { from: 'Lucas Alcazar', to: 'Toska', kind: 'captor and prospective master-apprentice', status: 'active' },
        ],
    }, [{
        name: 'Toska',
        text: 'Asked for her master’s true name, Toska answers: “Jedi Master Caelen Veyr.”',
    }]);

    assert.equal(validation.discardedIdentityResolutions, 1);
    assert.equal(validation.recoveredIdentities, 1);
    assert.deepEqual(result.identityResolutions, [{
        reference: 'Toska’s former Jedi Master', canonical: 'Caelen Veyr',
        evidence: 'Toska identifies her deceased Jedi Master as Caelen Veyr.',
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
    assert.match(validation.diagnosticWarnings.at(-1), /Potential partial resolution remains open/);
});

test('a completed stage resolves when extraction carries its remaining stage as a new atomic thread', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Captain Rhea', type: 'fleet commander', aliases: ['Rhea'] },
        { name: 'Envoy Sol', type: 'diplomat', aliases: ['Sol'] },
    );
    result.sceneCapsule = { beats: [
        'Captain Rhea departs aboard the courier and arrives at the summit complex.',
    ] };
    result.threads.push({
        targetId: '', title: 'Captain Rhea’s report to Envoy Sol',
        detail: 'Captain Rhea has arrived, but her meeting and report to Envoy Sol have not yet occurred.',
        status: 'open', participants: ['Captain Rhea', 'Envoy Sol'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_trip', title: 'Captain Rhea’s departure to meet Envoy Sol',
            detail: 'Captain Rhea will depart tomorrow to meet Envoy Sol; the departure has not yet occurred.',
            status: 'open', participants: ['Captain Rhea', 'Envoy Sol'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'Captain Rhea departs aboard the courier and arrives at the summit complex.' }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads.length, 2);
    assert.equal(result.threads[0].status, 'open');
    assert.equal(result.threads[1].targetId, 'thread_trip');
    assert.equal(result.threads[1].status, 'resolved');
    assert.match(result.threads[1].detail, /Resolved by explicit continuity|atomic continuity transition/);
});

test('preserving concealment for now cannot resolve an ongoing concealment thread', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_conceal', title: 'Conceal Mira from the Chancellor',
        detail: 'Resolved: Contact ended and the scrubbed relay preserved concealment for now; discovery remains a danger.',
        status: 'resolved', participants: ['Mira', 'Chancellor'], importance: 5,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Mira', type: 'person', aliases: [] }, { name: 'Chancellor', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_conceal', title: 'Conceal Mira from the Chancellor',
            detail: 'Mira must remain concealed from the Chancellor.', status: 'open',
            participants: ['Mira', 'Chancellor'], importance: 5,
        }],
    }, [{ name: 'Narrator', text: 'Contact ended. The scrubbed relay preserved Mira’s concealment for now.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
});

test('destination readiness for an incoming arrival cannot complete the arrival thread', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_arrival', title: 'Conceal the apprentice at the moon base',
        detail: 'Resolved: The concealed bay is ready for the incoming shuttle and the clamp passed diagnostics.',
        status: 'resolved', participants: ['Mentor', 'Apprentice', 'Moon Base'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Mentor', type: 'person', aliases: [] },
            { name: 'Apprentice', type: 'person', aliases: [] },
            { name: 'Moon Base', type: 'place', aliases: [] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_arrival', title: 'Conceal the apprentice at the moon base',
            detail: 'The apprentice must arrive and be concealed at the moon base.', status: 'open',
            participants: ['Mentor', 'Apprentice', 'Moon Base'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'The concealed bay is ready for the incoming shuttle; its clamp passed diagnostics.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
});

test('preparing to recover an object while recovery is pending cannot resolve its recovery thread', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_saber', title: 'Recover Mira’s green lightsaber',
        detail: 'Resolved: The team secured fuel and began low-orbit descent to recover Mira’s green lightsaber; recovery is still pending.',
        status: 'resolved', participants: ['Mira', 'Retrieval team'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Mira', type: 'person', aliases: [] }, { name: 'Retrieval team', type: 'group', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_saber', title: 'Recover Mira’s green lightsaber',
            detail: 'The green lightsaber has not yet been recovered.', status: 'open',
            participants: ['Mira', 'Retrieval team'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'The team began low-orbit descent to recover Mira’s green lightsaber. Recovery is still pending.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
});

test('a completed recovery clause resolves recovery while later transport remains pending', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['The retrieval team recovered Mira’s green lightsaber and is transporting it to the base.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Mira', type: 'person', aliases: [] }, { name: 'Retrieval team', type: 'group', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_saber', title: 'Recover Mira’s green lightsaber',
            detail: 'The green lightsaber has not yet been recovered.', status: 'open',
            participants: ['Mira', 'Retrieval team'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'The retrieval team recovered Mira’s green lightsaber and is transporting it to the base.' }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads[0].status, 'resolved');
    assert.match(result.threads[0].detail, /recovered Mira’s green lightsaber/);
});

test('receiving a recovered object stays open while only recovery and transport are complete', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_receive', title: 'Receive the recovered green lightsaber',
        detail: 'Resolved: The team recovered the green lightsaber and is transporting it to Mira.',
        status: 'resolved', participants: ['Mira', 'Retrieval team'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Mira', type: 'person', aliases: [] }, { name: 'Retrieval team', type: 'group', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_receive', title: 'Receive the recovered green lightsaber',
            detail: 'Mira has not yet received the recovered lightsaber.', status: 'open',
            participants: ['Mira', 'Retrieval team'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'The team recovered the green lightsaber and is transporting it to Mira.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
});

test('one assessor beginning work cannot complete another named assessor’s thread', () => {
    const result = extraction();
    result.events.push({
        title: 'Maren finishes the warm-up', summary: 'Maren completes his warm-up assessment of Mira.',
        consequences: 'Lucas now begins his personal assessment.', participants: ['Maren', 'Mira', 'Lucas'], importance: 4,
    });
    result.threads.push({
        targetId: 'thread_lucas_assessment', title: 'Lucas’s personal assessment of Mira',
        detail: 'Resolved: Lucas now begins his personal assessment after Maren completes the warm-up.',
        status: 'resolved', participants: ['Lucas', 'Mira', 'Maren'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Lucas', type: 'person', aliases: [] }, { name: 'Mira', type: 'person', aliases: [] }, { name: 'Maren', type: 'person', aliases: [] }],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_lucas_assessment', title: 'Lucas’s personal assessment of Mira',
            detail: 'Lucas will assess Mira after Maren finishes.', status: 'open', participants: ['Lucas', 'Mira'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'Maren completes the warm-up. Lucas begins his personal assessment of Mira.' }]);

    assert.equal(validation.reopenedUnsupportedThreads, 1);
    assert.equal(result.threads[0].status, 'open');
});

test('a refusal resolves the atomic leave decision even when a broader decision remains open', () => {
    const result = extraction();
    result.threads.push({
        targetId: 'thread_leave', title: 'Mira decides whether to leave the enclave',
        detail: 'Mira refused to leave and the hatch closed, but whether she accepts the enclave’s terms remains unresolved.',
        status: 'open', participants: ['Mira'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Mira', type: 'person', aliases: [] }], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_leave', title: 'Mira decides whether to leave the enclave',
            detail: 'Mira has not yet decided whether to leave.', status: 'open', participants: ['Mira'], importance: 4,
        }],
    }, [{ name: 'Mira', text: 'I refuse to leave. The hatch closes behind me.' }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads[0].status, 'resolved');
    assert.match(result.threads[0].detail, /refused to leave/);
});

test('entering a destination resolves a stale reach-destination thread', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['Mira entered the hidden moon base and is now inside its training wing.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [{ name: 'Mira', type: 'person', aliases: [] }], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_arrival', title: 'Reach the hidden moon base',
            detail: 'Mira has not yet reached the hidden moon base.', status: 'open', participants: ['Mira'], importance: 4,
        }],
    }, [{ name: 'Narrator', text: 'Mira entered the hidden moon base and is now inside its training wing.' }]);

    assert.equal(validation.reconciledThreads, 1);
    assert.equal(result.threads[0].status, 'resolved');
});

test('an explicit knowledge boundary becomes a persistent open identity thread', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Mira', type: 'person', aliases: [] },
        { name: 'Lord Ash', type: 'person', aliases: [] },
        { name: 'Master Vale', type: 'person', aliases: [] },
    );
    result.facts.push({
        targetId: '', subject: 'Lord Ash', predicate: 'identity as Master Vale’s former student',
        value: 'Lord Ash identifies himself as Master Vale’s former student, but Mira does not know that Lord Ash is the masked ruler’s true identity.',
        category: 'identity', importance: 5, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: result.entities, facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.recoveredIdentityThreads, 1);
    const thread = result.threads.find(item => /has not recognized Lord Ash’s identity/.test(item.title));
    assert.equal(thread.status, 'open');
    assert.deepEqual(thread.participants, ['Mira', 'Lord Ash']);
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
    assert.equal(validation.diagnosticWarnings.length, 1);
});

test('a resolved descriptive-person thread consolidates its placeholder into the named person', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
    );
    result.sceneCapsule = { beats: ['Caelen’s former apprentice is named Lucas Alcazar.'] };
    result.facts.push({
        subject: 'Lucas Alcazar', predicate: 'former apprentice of Caelen Veyr',
        value: 'Lucas Alcazar was previously trained by Caelen Veyr as an apprentice.',
        category: 'history', importance: 4, persistence: 'persistent',
    });
    result.threads.push({
        title: 'Identity and fate of Caelen Veyr’s former apprentice',
        detail: 'Resolved as to the historical former-apprentice name: Lucas Alcazar.',
        status: 'resolved', participants: ['Lucas Alcazar', 'Caelen Veyr'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
            { name: "Caelen Veyr's former apprentice", type: 'person', aliases: [] },
        ],
        facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [
        { name: 'Toska', text: 'Name the apprentice.' },
        { name: 'Masked Sith', text: 'Lucas Alcazar. He was trained by Caelen as an apprentice.' },
    ]);

    assert.equal(validation.recoveredIdentities, 1);
    assert.deepEqual(result.identityResolutions, [{
        reference: "Caelen Veyr's former apprentice", canonical: 'Lucas Alcazar',
        evidence: 'Caelen’s former apprentice is named Lucas Alcazar.',
    }]);
});

test('absence of an identified answer cannot resolve an identification thread', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['No confirmed deceiver has been identified.'] };
    result.threads.push({
        targetId: 'thread_deceiver', title: 'Determine who misrepresented the Jedi mission',
        detail: 'Resolved by extracted continuity: no confirmed deceiver has been identified',
        status: 'resolved', participants: ['Toska', 'Lucas Alcazar'], importance: 3,
    });
    const world = {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
        ], facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_deceiver', title: 'Determine who misrepresented the Jedi mission',
            detail: 'The source of the misleading mission information remains unknown.',
            status: 'open', participants: ['Toska', 'Lucas Alcazar'], importance: 3,
        }],
    };

    sanitizeReconciliationMetadata(result, world, [{
        name: 'Toska', text: 'No confirmed deceiver has been identified.',
    }]);

    assert.equal(result.threads[0].status, 'open');
    assert.match(result.threads[0].detail, /remains unknown/iu);
});

test('revelation prose is attributed to its speaker without stealing an earlier knowledge clause', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
        { name: 'Toska', type: 'person', aliases: [] },
    );
    result.facts.push(
        {
            subject: 'Caelen Veyr', predicate: 'knowledge of Lucas Alcazar',
            value: 'Lucas reveals that Caelen failed a previous apprentice, whom he names as Lucas Alcazar.',
            category: 'knowledge', importance: 4, persistence: 'persistent',
        },
        {
            subject: 'Toska', predicate: 'knowledge of Caelen Veyr’s former apprentice',
            value: 'She previously lacked the name; Lucas has identified himself as that apprentice.',
            category: 'knowledge', importance: 4, persistence: 'persistent',
        },
    );
    sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.ok(result.facts.some(item => item.subject === 'Lucas Alcazar'
        && item.category === 'character belief' && /knowledge of Lucas Alcazar/iu.test(item.predicate)));
    assert.ok(result.facts.some(item => item.subject === 'Toska'
        && item.category === 'knowledge' && /former apprentice/iu.test(item.predicate)));
});

test('a subordinate inference cannot survive as an established role designation', () => {
    const result = extraction();
    result.entities.push({ name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] });
    result.facts.push({
        subject: 'Lucas Alcazar', predicate: 'established role or designation',
        value: 'that Lucas is maintaining a covert power structure and becomes more suspicious.',
        category: 'identity', importance: 5, persistence: 'persistent',
    });
    result.sceneCapsule = { beats: ['Toska concludes that Lucas is maintaining a covert power structure and becomes more suspicious.'] };
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Toska', text: 'I think you are building a covert power structure.' }]);

    assert.equal(validation.discardedMalformedDesignations, 1);
    assert.equal(result.facts.some(item => item.predicate === 'established role or designation'), false);
});

test('a direct role-name answer resolves an of-phrase placeholder and restores its relationship', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
        { name: 'Caelen Veyr', type: 'person', aliases: [] },
    );
    result.sceneCapsule = { beats: ['Lucas identifies the apprentice as Lucas Alcazar.'] };
    result.facts.push({
        subject: 'Toska', predicate: 'knowledge of former apprentice of Caelen Veyr',
        value: 'Toska now knows that Caelen’s former apprentice was Lucas Alcazar.',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
    result.threads.push({
        targetId: 'thread_apprentice', title: 'Identity and fate of Caelen Veyr’s former apprentice',
        detail: 'Toska does not know who the former apprentice was or what became of them.', status: 'open',
        participants: ['Toska', 'Caelen Veyr', 'Former apprentice of Caelen Veyr'], importance: 4,
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [
            { name: 'Toska', type: 'person', aliases: [] },
            { name: 'Caelen Veyr', type: 'person', aliases: [] },
            { name: 'Former apprentice of Caelen Veyr', type: 'person', aliases: [] },
        ],
        facts: [], states: [], relationships: [], backgrounds: [],
        threads: [{
            id: 'thread_apprentice', title: 'Identity and fate of Caelen Veyr’s former apprentice',
            detail: 'The identity remains unknown.', status: 'open', participants: ['Toska', 'Caelen Veyr'], importance: 4,
        }],
    }, [
        { name: 'Toska', text: 'Name the apprentice.' },
        { name: 'Masked Sith', text: 'Lucas Alcazar. He was trained by Master Caelen.' },
    ]);

    assert.equal(validation.recoveredIdentities, 1);
    assert.equal(validation.recoveredIdentityRelationships, 1);
    assert.ok(result.relationships.some(item => [item.from, item.to].includes('Caelen Veyr')
        && [item.from, item.to].includes('Lucas Alcazar') && item.status === 'ended'));
    assert.equal(result.threads.find(item => item.targetId === 'thread_apprentice')?.status, 'resolved');
    assert.equal(result.threads.some(item => /^Unresolved circumstances surrounding Lucas Alcazar$/u.test(item.title)), false);
});

test('another character asking a question cannot become the topic character knowledge', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
    );
    result.facts.push({
        subject: 'Caelen Veyr', predicate: 'knowledge of Lucas Alcazar',
        value: 'Toska begins questioning why Caelen concealed her potential and asks Lucas what he sensed.',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.discardedMisownedQuestionKnowledge, 1);
    assert.equal(result.facts.length, 0);
});

test('knowledge prose about a different established entity cannot keep an unrelated topic label', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
        { name: 'Hidden moon base', type: 'place', aliases: ['moon base'] },
    );
    result.facts.push({
        subject: 'Toska', predicate: 'knowledge of Hidden moon base',
        value: 'Toska recalls Caelen restricting her training to restraint and begins questioning his motives.',
        category: 'knowledge', importance: 4, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.discardedMismatchedKnowledgeTopics, 1);
    assert.equal(result.facts.length, 0);
});

test('implicit knowledge wording restores the predicate topic as the actual holder', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
        { name: 'Toska', type: 'person', aliases: [] },
    );
    result.facts.push({
        subject: 'Lucas Alcazar', predicate: 'belief about Toska — knowledge of Lucas Alcazar',
        value: 'Knows Lucas says she cannot leave safely; she rejects this as coercion.',
        category: 'character belief', importance: 3, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.repairedTopicKnowledgeHolders, 1);
    assert.equal(result.facts[0].subject, 'Toska');
    assert.equal(result.facts[0].predicate, 'knowledge of Lucas Alcazar');
    assert.equal(result.facts[0].category, 'knowledge');
});

test('a later sentence about another holder is trimmed from an attributed fact', () => {
    const result = extraction();
    result.entities.push(
        { name: 'Lucas Alcazar', type: 'person', aliases: ['Lucas'] },
        { name: 'Toska', type: 'person', aliases: [] },
        { name: 'Caelen Veyr', type: 'person', aliases: ['Caelen'] },
    );
    result.facts.push({
        subject: 'Lucas Alcazar', predicate: 'belief about Caelen Veyr — history',
        value: 'Lucas claims Caelen held a Council seat. Toska now hears Lucas discuss an unrelated hidden base.',
        category: 'character belief', importance: 4, persistence: 'persistent',
    });
    const validation = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    });

    assert.equal(validation.trimmedCrossHolderAttributedClauses, 1);
    assert.equal(result.facts[0].value, 'Lucas claims Caelen held a Council seat.');
});
