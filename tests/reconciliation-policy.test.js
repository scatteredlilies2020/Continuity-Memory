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

test('stored malformed address placeholders are also removed from replay history', () => {
    const malformed = { subject: 'Setsuko Uchiha', predicate: 'calls [canonical addressee]', value: '[canonical addressee unavailable]', category: 'form of address' };
    const world = { facts: [structuredClone(malformed)], extractions: [{ result: { facts: [structuredClone(malformed)] } }] };
    assert.equal(removeInvalidStoredAddressFacts(world), 2);
    assert.deepEqual(world.facts, []);
    assert.deepEqual(world.extractions[0].result.facts, []);
});

test('legacy and current address predicates share one directional identity', () => {
    assert.equal(
        addressFactIdentity({ subject: 'Setsuko Uchiha', predicate: 'form of address for Naruto Uzumaki', category: 'social address' }),
        addressFactIdentity({ subject: 'Setsuko Uchiha', predicate: 'calls Naruto Uzumaki.', category: 'forms of address' }),
    );
    assert.equal(mergeAddressValues('Uzumaki-kun; Uzumaki-san', '“dead last”; Uzumaki-kun'), 'Uzumaki-kun; Uzumaki-san; dead last');
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

test('normal speaker-to-addressee address remains unaffected by self-address validation', () => {
    const result = extraction();
    result.facts.push({
        targetId: '', subject: 'Naruto Uzumaki', predicate: 'calls Setsuko Uchiha',
        value: 'Suki-chan', category: 'form of address',
    });

    const sanitized = sanitizeReconciliationMetadata(result, {
        entities: [], facts: [], states: [], relationships: [], threads: [], backgrounds: [],
    }, [{ name: 'Narrator', text: 'No dialogue appears here.' }]);

    assert.equal(result.facts.length, 1);
    assert.equal(sanitized.ignored, 0);
});
