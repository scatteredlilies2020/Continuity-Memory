import assert from 'node:assert/strict';
import test from 'node:test';
import { retrievalMessageText, recentRetrievalQuery } from '../extension/retrieval-query.js';
import { buildEmbeddingQuery, buildEmbeddingDocuments } from '../extension/embedding-index.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { compactPromptProvenance } from '../extension/prompt-provenance.js';

const world = () => ({ entities: [], facts: [], events: [], states: [], relationships: [], threads: [], backgrounds: [], capsules: [], chronicle: [], corrections: [] });
const messages = [
    { mes: 'Rolf displays the axle pin. Rolf checks a bridge clamp in the furnace.' },
    { name: 'Visitor', is_user: true, mes: 'Those are fine craftsmanship. You are already having enough trouble with it.' },
];

test('retrieval keeps displayed table facts and boundaries but removes HTML, CSS, scripts and comments', () => {
    const message = { mes: '<style>.forge { color: red }</style><script>tracking()</script><!-- hidden -->'
        + '<div style="color:red">Finished work</div><table><tr><td>Axle pins</td><td>Iron &amp; copper</td></tr>'
        + '<tr><td>Maker&#39;s stamp</td><td>&#x2605;</td></tr></table><p>Rolf is waiting.</p>' };
    const text = retrievalMessageText(message);
    assert.match(text, /Finished work\nAxle pins Iron & copper\nMaker's stamp ★\nRolf is waiting\./);
    for (const query of [text, recentRetrievalQuery([message]), buildEmbeddingQuery([message])]) {
        assert.doesNotMatch(query, /<\/?(?:div|table|tr|td)|color:red|tracking|hidden|\.forge/);
        assert.match(query, /Axle pins/);
    }
    assert.equal(message.mes.includes('style='), true, 'cleaning must not change saved chat');
});

test('generic pronouns and auxiliary phrases do not retrieve an unrelated belief', () => {
    const target = world();
    target.entities = [{ id: 'rolf', name: 'Rolf' }, { id: 'himmel', name: 'Himmel' }];
    target.facts = [{ id: 'trust', subject: 'Himmel', category: 'belief', predicate: 'trust', value: 'The others already trust him enough to sleep while he keeps watch, despite having barely known one another.' }];
    const result = buildMemoryPrompt(target, messages, 8000);
    assert.doesNotMatch(result.prompt, /already trust him|Himmel — trust/);
});

test('name matching does not find Ende inside unattended', () => {
    const target = world();
    target.entities = [{ id: 'ende', name: 'Ende', description: 'UNRELATED_TOWN' }];
    assert.doesNotMatch(buildMemoryPrompt(target, [{ mes: 'The unattended forge glows.' }, messages[1]], 8000).prompt, /UNRELATED_TOWN/);
});

test('a broad vector pool does not fill categories with old topics or same-actor tangents', () => {
    const target = world();
    target.entities = [{ id: 'rolf', name: 'Rolf' }, { id: 'visitor', name: 'Visitor' }];
    target.facts = [{ id: 'clamp', subject: 'Rolf', predicate: 'bridge reinforcement', value: 'The clamp must cool in brine before installation.' }];
    target.threads = [
        { id: 'old-bandits', title: 'Raider tally', detail: 'UNRELATED_BANDITS', participants: ['Visitor'], status: 'recorded' },
        { id: 'old-actor', title: 'Family holiday', detail: 'UNRELATED_HOLIDAY', participants: ['Rolf'], status: 'recorded' },
    ];
    const ranks = new Map([['thread:old-bandits', 40], ['thread:old-actor', 41], ['fact:clamp', 42]]);
    const result = buildMemoryPrompt(target, messages, 12000, '', [], undefined, ranks);
    assert.match(result.prompt, /cool in brine/);
    assert.doesNotMatch(result.prompt, /UNRELATED_BANDITS|UNRELATED_HOLIDAY/);
});

test('an isolated query also rejects the weak tail of a vector pool', () => {
    const target = world();
    target.facts = [{ id: 'old', subject: 'Past council', predicate: 'decision', value: 'UNRELATED_COUNCIL' }];
    const result = buildMemoryPrompt(target, [messages[1]], 12000, '', [], undefined, new Map([['fact:old', 90]]));
    assert.doesNotMatch(result.prompt, /UNRELATED_COUNCIL/);
});

test('strong semantic discoveries can recall synonyms without literal keyword overlap', () => {
    const target = world();
    target.facts = [{ id: 'signature', subject: 'Artisan', predicate: 'hallmark', value: 'A squared arch identifies the workshop.' }];
    const result = buildMemoryPrompt(target, [{ mes: 'What does the maker’s signature mean?' }], 8000, '', [], undefined, new Map([['fact:signature', 1]]));
    assert.match(result.prompt, /squared arch identifies/);
});

test('a semantic discovery does not unlock unrelated records merely sharing its source', () => {
    const target = world();
    const sources = [{ chatKey: 'chat', from: 0, to: 7 }];
    target.events = [{ id: 'repair', title: 'Ironwork repair', summary: 'The ironwork was repaired with a new wedge.', participants: ['Rolf'], sources }];
    target.facts = [{ id: 'holiday', subject: 'Rolf', predicate: 'holiday', value: 'UNRELATED_HOLIDAY beside the ironwork display.', sources }];
    const result = buildMemoryPrompt(target, messages, 8000, 'chat', [], undefined, new Map([['event:repair', 1]]));
    assert.match(result.prompt, /new wedge/);
    assert.doesNotMatch(result.prompt, /UNRELATED_HOLIDAY/);
});

test('AI-expanded recall does not unlock unrelated records merely sharing its source', () => {
    const target = world();
    const sources = [{ chatKey: 'chat', from: 0, to: 7 }];
    target.events = [{ id: 'repair', title: 'Ironwork repair', summary: 'The ironwork was repaired with a new wedge.', participants: ['Rolf'], sources }];
    target.facts = [{ id: 'holiday', subject: 'Rolf', predicate: 'holiday', value: 'UNRELATED_HOLIDAY beside the ironwork display.', sources }];
    const result = buildMemoryPrompt(target, messages, 8000, 'chat', ['Rolf ironwork repairs'], undefined, new Map());
    assert.match(result.prompt, /new wedge/);
    assert.doesNotMatch(result.prompt, /UNRELATED_HOLIDAY/);
});

test('prompt references stay unambiguous across chats without rewriting storage or ordinary prose', () => {
    const target = world();
    target.capsules = [
        { chatKey: 'chat', from: 0, to: 7, temporal: { anchorId: 'Digest-aaaaaaaa-0-7' } },
        { chatKey: 'old[chat]', from: 0, to: 7, temporal: { anchorId: 'Digest-bbbbbbbb-0-7' } },
    ];
    const before = JSON.stringify(target);
    const text = compactPromptProvenance('They chat at the forge. chat messages 0–7; old[chat] messages 0–7; tomorrow (relative to Digest-aaaaaaaa-0-7); after Digest-bbbbbbbb-0-7.', target, 'chat');
    assert.match(text, /^They chat at the forge\. this chat messages 0–7; chat 2 messages 0–7;/);
    assert.match(text, /tomorrow \(relative to this chat messages 0–7\); after chat 2 messages 0–7/);
    assert.equal(JSON.stringify(target), before);
    assert.equal(compactPromptProvenance('Digest-aaaaaaaa-0-79', target, 'chat'), 'Digest-aaaaaaaa-0-79');
});

test('compact prompt formatting leaves canonical embedding documents and temporal scope intact', () => {
    const target = world();
    target.capsules = [{ id: 'c', chatKey: 'chat', from: 0, to: 7, temporal: { anchorId: 'Digest-aaaaaaaa-0-7' } }];
    target.threads = [{ id: 'repair', title: 'Rolf bridge clamp', detail: 'The clamp should cool overnight before installation tomorrow.',
        temporalAnchorId: 'Digest-aaaaaaaa-0-7', temporal: { frame: 'flashback', relation: 'before', referenceId: 'Digest-aaaaaaaa-0-7', elapsed: 'one day', certainty: 'explicit' },
        sources: [{ chatKey: 'chat', from: 0, to: 7 }], status: 'recorded' }];
    const docs = buildEmbeddingDocuments(target);
    const prompt = buildMemoryPrompt(target, [{ is_user: true, mes: 'Rolf bridge clamp installation' }], 8000, 'chat').prompt;
    assert.doesNotMatch(prompt, /Digest-aaaaaaaa|"referenceId"|"certainty"/);
    assert.match(prompt, /flashback/);
    assert.match(prompt, /interval one day/);
    assert.match(prompt, /tomorrow.*relative to this chat messages 0–7/);
    assert.deepEqual(buildEmbeddingDocuments(target), docs);
});


test('context mentions do not append unrelated entity canon or empty entity rows', () => {
    const target = world();
    target.entities = [{ id: 'rolf', name: 'Rolf', description: 'A village smith.', sources: [{ chatKey: 'chat', from: 0, to: 7 }] },
        { id: 'jannik', name: 'Jannik' }];
    target.facts = [{ id: 'mission', subject: 'Rolf', predicate: 'mission', value: 'UNRELATED_EXPEDITION', importance: 5, persistence: 'persistent' }];
    const result = buildMemoryPrompt(target, [{ mes: 'Rolf and Jannik show their ironwork.' }, messages[1]], 8000, 'chat');
    assert.match(result.prompt, /A village smith\. \[profile source: this chat messages 0–7\]/);
    assert.doesNotMatch(result.prompt, /UNRELATED_EXPEDITION|^- Jannik.*:\s*$/m);
    assert.match(result.prompt, /newer evidence governs mutable conditions/);
    assert.ok(!result.retrievalDiagnostics.selections.find(row => row.id === 'jannik')?.injected);
});

test('a small semantic discovery allowance retains useful facts without literal matches', () => {
    const target = world();
    target.facts = [{ id: 'hallmark', subject: 'Artisan', predicate: 'hallmark', value: 'The squared arch identifies a licensed workshop.' }];
    const result = buildMemoryPrompt(target, messages, 8000, '', [], undefined, new Map([['fact:hallmark', 6]]));
    assert.match(result.prompt, /squared arch identifies/);
});

test('identical facts with different storage IDs appear once across inline canon and fact rows', () => {
    const target = world();
    target.entities = [{ id: 'rolf', name: 'Rolf', description: 'A village smith.' }];
    const evidence = { subject: 'Rolf', predicate: 'clamp cooling', value: 'The clamp must cool in brine.', persistence: 'persistent', importance: 5 };
    target.facts = [{ ...evidence, id: 'first', sources: [{ chatKey: 'chat', from: 0, to: 7 }] },
        { ...evidence, id: 'copy', sources: [{ chatKey: 'chat', from: 8, to: 15 }] }];
    const before = JSON.stringify(target);
    const result = buildMemoryPrompt(target, [{ is_user: true, mes: 'Rolf clamp cooling' }], 8000, 'chat');
    assert.equal(result.prompt.split(evidence.value).length - 1, 1);
    for (const id of ['first', 'copy']) assert.ok(result.retrievalDiagnostics.selections.some(row => row.id === id && row.injected));
    assert.equal(JSON.stringify(target), before);
});

test('deduplication preserves facts with different conditions, certainty, or temporal anchors', () => {
    const target = world();
    const evidence = { subject: 'Rolf', predicate: 'clamp cooling', value: 'The clamp must cool in brine.', persistence: 'persistent' };
    target.facts = [{ ...evidence, id: 'today', temporalAnchorId: 'source-today' },
        { ...evidence, id: 'reported', certainty: 'reported' },
        { ...evidence, id: 'yesterday', temporalAnchorId: 'source-yesterday' },
        { ...evidence, id: 'condition', value: 'The clamp must cool in brine unless the alloy contains copper.' }];
    const result = buildMemoryPrompt(target, [{ is_user: true, mes: 'Rolf clamp cooling' }], 8000);
    for (const fact of target.facts) assert.ok(result.retrievalDiagnostics.selections.some(row => row.id === fact.id && row.injected), fact.id);
    assert.match(result.prompt, /unless the alloy contains copper/);
});


test('unanchored relative facts from different excerpts are not assumed to share a date', () => {
    const target = world();
    target.facts = [0, 8].map(from => ({ id: `promise-${from}`, subject: 'Rolf', predicate: 'clamp delivery',
        value: 'Rolf will deliver the clamp tomorrow.', sources: [{ chatKey: 'chat', from, to: from + 7 }] }));
    const result = buildMemoryPrompt(target, [{ is_user: true, mes: 'Rolf clamp delivery' }], 8000, 'chat');
    for (const fact of target.facts) assert.ok(result.retrievalDiagnostics.selections.some(row => row.id === fact.id && row.injected));
});
