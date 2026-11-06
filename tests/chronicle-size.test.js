import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { activeChronicleNodes, addChroniclePromotion, chronicleCompressionGuide, chronicleSize, chronicleSizeStatus, chronicleTokenTarget, nextChroniclePromotion, renderChronicleFrontier, validateChronicleCompression } from '../extension/chronicle.js';
import { retryChroniclePromotion } from '../extension/chronicle-retry.js';

const node = (id, level, from, chatKey = 'chat') => ({ id, level, from, to: from + 9, chatKey, childIds: [], text: `${id} ${'Consequential history. '.repeat(160)}` });

test('compression validates the complete rendered parent without changing sources', () => {
    const children = [node('a', 0, 0), node('b', 0, 10)];
    const before = JSON.stringify(children);
    const sizes = validateChronicleCompression({ summary: 'A promise changed their plans.' }, children);
    assert.ok(sizes.parentCharacters < sizes.sourceCharacters);
    assert.throws(() => validateChronicleCompression({ summary: 'Short.', closingState: 'Hidden bloat. '.repeat(1000) }, children), { code: 'CONTINUITY_COMPRESSION_NOT_SMALLER' });
    assert.equal(JSON.stringify(children), before);
});

test('expanding parents get bounded correction feedback, never endless retries', async () => {
    const children = [node('a', 1, 0), node('b', 1, 10)];
    let attempts = 0;
    await assert.rejects(retryChroniclePromotion(previous => {
        if (attempts++) assert.equal(previous.code, 'CONTINUITY_COMPRESSION_NOT_SMALLER');
        validateChronicleCompression({ summary: 'Expansion. '.repeat(1000) }, children);
    }, { wait: async () => {} }), { code: 'CONTINUITY_INVALID_RESPONSE' });
    assert.equal(attempts, 3);
});

test('Story target has safe defaults and finite bounds', () => {
    for (const value of [undefined, 0, -1, 'bad', Infinity]) assert.equal(chronicleTokenTarget({ chronicleTokenTarget: value }), 8000);
    assert.equal(chronicleTokenTarget({ chronicleTokenTarget: 5 }), 1000);
    assert.equal(chronicleTokenTarget({ chronicleTokenTarget: 999999 }), 64000);
});

test('token estimates never promote partially filled layers', () => {
    const world = { chronicle: [node('old-a', 1, 0), node('old-b', 1, 10), node('new-a', 0, 20), node('new-b', 0, 30)] };
    assert.equal(nextChroniclePromotion(world, { chronicleTokenTarget: 1000 }), null);
});

test('59 C0 entries retain a full recent tail without premature C2 or C3', () => {
    const world = { chronicle: Array.from({ length: 59 }, (_, i) => node('entry-' + i, 0, i * 8)) };
    for (let children; (children = nextChroniclePromotion(world));) addChroniclePromotion(world, {summary:'Compact history.'}, children);
    const frontier = activeChronicleNodes(world, 'chat');
    assert.equal(frontier.filter(n => n.level === 0).length, 19);
    assert.equal(frontier.filter(n => n.level === 1).length, 4);
    assert.equal(world.chronicle.some(n => n.level > 1), false);
    assert.equal(world.chronicle.filter(n => n.level === 0).length, 59);
});

test('every layer promotes only its oldest group on overflow, including above C2', () => {
    for (const level of [0,1,2,3,4]) {
        const world = {chronicle:Array.from({length:24}, (_,i)=>node('n'+i,level,i*8))};
        assert.equal(nextChroniclePromotion(world),null);
        world.chronicle.push(node('overflow',level,192));
        const children=nextChroniclePromotion(world);
        assert.deepEqual(children.map(n=>n.id),Array.from({length:10},(_,i)=>'n'+i));
        addChroniclePromotion(world,{summary:'Compact.'},children);
        assert.equal(activeChronicleNodes(world,'chat').filter(n=>n.level===level).length,15);
        assert.equal(nextChroniclePromotion(world),null);
    }
});

test('token pressure never mixes chats or layers and counts retained parent details', () => {
    const world = { chronicle: [node('a', 0, 0), node('b', 1, 10), node('c', 0, 20, 'other')] };
    assert.equal(nextChroniclePromotion(world, { chronicleTokenTarget: 1000 }), null);
    const record = node('details', 1, 0);
    const basic = chronicleSize([record]);
    record.closingState = 'Only A knows. '.repeat(200);
    assert.ok(chronicleSize([record]) > basic);
    assert.match(chronicleSizeStatus({ chronicle: [record] }, 'chat'), /C1: ~/);
    assert.match(chronicleSizeStatus(null, 'chat'), /~0 tokens/);
});

test('shared compression guidance targets all fields without imposing truncation', () => {
    const guide = chronicleCompressionGuide([node('a', 0, 0), node('b', 0, 10)]);
    assert.match(guide, /30%/);
    assert.match(guide, /TOTAL across all parent prose fields/);
    assert.match(guide, /not a wire output limit/);
    assert.match(guide, /Original children remain stored/);
    const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
    const detached = readFileSync(new URL('../plugin/detached-jobs.js', import.meta.url), 'utf8');
    assert.match(engine, /chronicleCompressionGuide\(nodes, settings\)/);
    assert.match(engine, /chronicleTokenTarget: settings.chronicleTokenTarget/);
    assert.match(detached, /chronicleCompressionGuide\(records, job.hierarchy\?\.settings\)/);
    for (const source of [engine, detached]) {
        const format = source.match(/function formatChronicleNodes\([^]*?^}/m)[0];
        const record = { ...node('source', 1, 0), title: 'A promise', emotionalArc: 'Trust became conditional.', closingState: 'Only A knew.' };
        const output = JSON.parse(runInNewContext(`${format}\nformatChronicleNodes([record]);`, { record }));
        assert.equal(output.title, record.title);
        assert.equal(output.emotionalArc, record.emotionalArc);
        assert.equal(output.closingState, record.closingState);
    }
});
