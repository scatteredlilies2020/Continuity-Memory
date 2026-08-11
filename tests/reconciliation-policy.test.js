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
    result.facts.push({ targetId: 'fact_real', subject: 'Canal', predicate: 'status' });
    result.recordMerges.push({ category: 'facts', canonicalId: 'fact_real', duplicateIds: ['fact_missing'], evidence: 'Same status.' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], states: [], relationships: [], threads: [],
        facts: [{ id: 'fact_real' }],
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

test('fact target IDs may update wording while retaining the same category', () => {
    const result = extraction();
    result.facts.push({ targetId: 'fact_canal', subject: 'Canal', predicate: 'priority', category: 'infrastructure' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], states: [], relationships: [], threads: [], backgrounds: [],
        facts: [{ id: 'fact_canal', subject: 'North Canal', predicate: 'maintenance objective', category: 'infrastructure' }],
    });
    assert.equal(result.facts[0].targetId, 'fact_canal');
    assert.equal(sanitized.ignored, 0);
});

test('background strands reuse only valid stable target IDs', () => {
    const result = extraction();
    result.backgrounds.push({ targetId: 'background_qing', topic: 'Qing White Lotus suppression' });
    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [],
        backgrounds: [{ id: 'background_qing' }],
    });
    assert.equal(result.backgrounds[0].targetId, 'background_qing');
    assert.equal(sanitized.ignored, 0);
});

test('missing optional reconciliation arrays are restored for older or non-strict providers', () => {
    const result = extraction();
    delete result.identityResolutions;
    delete result.recordMerges;
    sanitizeReconciliationMetadata(result, { entities: [], facts: [], states: [], relationships: [], threads: [] });
    assert.deepEqual(result.identityResolutions, []);
    assert.deepEqual(result.recordMerges, []);
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

    assert.equal(removeInvalidStoredAddressFacts(world), 1);
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
            text: '"Hmph, as if test scores matter. Pinky." I then look at Kakashi.',
        },
        {
            index: 21,
            name: 'Naruto',
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
            text: '"Hmph, as if test scores matter. Pinky." I then look away.',
        },
        {
            index: 21,
            name: 'Narrator',
            text: 'Sakura says “Pinky?” in disbelief.',
        },
    ]);

    assert.equal(sanitized.repairedAddresses, 0);
    assert.equal(sanitized.discardedAddressValues, 1);
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

test('source-supported durable L1 beats warn when no structured record covers them', () => {
    const result = extraction();
    result.sceneCapsule = { beats: ['Alice vows to protect the northern bridge permanently.'] };
    const messages = [{ name: 'Alice', text: 'I vow to protect the northern bridge permanently.' }];

    const missing = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, messages);
    assert.equal(missing.warnings.length, 1);
    assert.match(result.sceneCapsule.coverageWarnings[0], /northern bridge/);

    result.threads.push({ title: 'Protect the northern bridge', detail: 'Alice vows to protect the northern bridge permanently.' });
    const covered = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, messages);
    assert.deepEqual(covered.warnings, []);
});
