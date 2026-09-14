import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalMemorySubject, stateIdentity } from '../extension/state-lifecycle.js';

test('a recurring role does not resolve to an earlier named holder of that role', () => {
    const world = { entities: [{ name: 'Warden Oddo', aliases: ['Oddo', 'the warden', 'road-warden'] }] };
    for (const name of ['road-warden', 'checkpoint road-warden', 'Tur Bridge road-warden', 'the warden', 'warden']) {
        assert.equal(canonicalMemorySubject(world, name), name);
        assert.notEqual(stateIdentity(world, { subject: name, attribute: 'location' }),
            stateIdentity(world, { subject: 'Oddo', attribute: 'location' }));
    }
    assert.equal(canonicalMemorySubject(world, 'Oddo'), 'Warden Oddo');
    assert.equal(canonicalMemorySubject(world, 'Warden Oddo'), 'Warden Oddo');
});

test('name matching preserves aliases and unique short names without dropping identifying qualifiers', () => {
    const world = { entities: [
        { name: 'Caelen Veyr', aliases: ['Silver Fox'] },
        { name: 'Toska', aliases: [] },
    ] };
    assert.equal(canonicalMemorySubject(world, 'Caelen'), 'Caelen Veyr');
    assert.equal(canonicalMemorySubject(world, 'Silver Fox'), 'Caelen Veyr');
    for (const name of ['Caelen Veyr impersonator', 'Toska’s master', 'Silver Fox statue', 'Caelen Veyr group']) {
        assert.equal(canonicalMemorySubject(world, name), name);
    }
    world.entities.push({ name: 'Caelen Ren', aliases: ['Silver Fox'] });
    assert.equal(canonicalMemorySubject(world, 'Caelen'), 'Caelen');
    assert.equal(canonicalMemorySubject(world, 'Silver Fox'), 'Silver Fox');
});
