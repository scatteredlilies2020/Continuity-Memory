import assert from 'node:assert/strict';
import test from 'node:test';
import { recentRetrievalQuery, retrievalMessageText } from '../extension/retrieval-query.js';
import { parseExpandedTerms } from '../extension/semantic-terms.js';

test('parses and deduplicates concise AI-expanded retrieval terms', () => {
    const terms = parseExpandedTerms('<think>brief</think> {"terms":["doctor","physician","doctor","medical professional"]}');
    assert.deepEqual(terms, ['doctor', 'physician', 'medical professional']);
});

test('recovers complete AI-expanded terms when the final JSON string is truncated', () => {
    const terms = parseExpandedTerms('{"terms":["Anakin and Obi-Wan rivalry","Dooku duel outcome","unfinished');
    assert.deepEqual(terms, ['Anakin and Obi-Wan rivalry', 'Dooku duel outcome']);
});

test('AI terms use the final JSON answer among prose, fences, drafts, and reasoning', () => {
    for (const raw of [
        'Here is the "answer:\n```json\n{"terms":["rail clamps"]}\n```',
        '<think>Draft { "unfinished</think>\n{"terms":["rail clamps"]}',
        '{"terms":["draft"]}\nFinal answer:\n{"terms":["rail clamps"]}',
        '<think>Unclosed provider wrapper\n{"terms":["rail clamps"]}',
        '["rail clamps","rail clamps"]',
    ]) assert.deepEqual(parseExpandedTerms(raw), ['rail clamps']);
});

test('reasoning tags inside a search phrase are data rather than removable wrappers', () => {
    const phrase = 'inscription <think>remember the bridge</think>';
    assert.deepEqual(parseExpandedTerms(JSON.stringify({ terms: [phrase] })), [phrase]);
});

test('invalid AI term output has a private, typed diagnostic instead of a native JSON error', () => {
    for (const raw of [
        '', 'PRIVATE_SENTINEL narrative instead of JSON', 'null', 'true', '"text"', '{}',
        '{"terms":null}', '{"terms":"PRIVATE_SENTINEL"}', '{"terms":[{},42,null]}',
        '{"terms":["PRIVATE_SENTINEL" "missing comma"]}', '{"terms":["PRIVATE_SENTINEL"],}',
        '{"metadata":{"terms":["PRIVATE_SENTINEL"]}',
        '<think>{"terms":["PRIVATE_SENTINEL"]}</think>',
        '<think>{"terms":["PRIVATE_SENTINEL","unfinished',
        '{"terms":["PRIVATE_SENTINEL"]}\n{"terms":[',
    ]) assert.throws(() => parseExpandedTerms(raw), error => error.code === 'CONTINUITY_INVALID_RETRIEVAL_OUTPUT'
        && !/PRIVATE_SENTINEL|JSON\.parse/.test(error.message));
});

test('truncated term recovery ignores closed reasoning and requires a simple terms response', () => {
    assert.deepEqual(parseExpandedTerms('<think>{"terms":["wrong"]}</think>\n```json\n{"terms":["rail clamps","unfinished'), ['rail clamps']);
    assert.deepEqual(parseExpandedTerms('{"terms":["rail clamps"]'), ['rail clamps']);
});

test('empty AI term arrays remain valid and normalized output stays bounded', () => {
    assert.deepEqual(parseExpandedTerms('{"terms":[]}'), []);
    assert.deepEqual(parseExpandedTerms('[]'), []);
    const raw = JSON.stringify({ terms: ['  rail\n clamps  ', 'rail clamps', '', ...Array.from({ length: 30 }, (_, i) => `term ${i}`)] });
    const terms = parseExpandedTerms(raw);
    assert.equal(terms[0], 'rail clamps');
    assert.equal(terms.length, 20);
});

test('AI retrieval keeps the selected number of complete messages', () => {
    const longReply = `opening-${'country-state '.repeat(3000)}-statbox-ending`;
    const messages = Array.from({ length: 8 }, (_, index) => ({ name: index % 2 ? 'AI' : 'User', mes: `message-${index}` }));
    messages[5].mes = longReply;

    const query = recentRetrievalQuery(messages, 3);

    assert.doesNotMatch(query, /message-4/);
    assert.match(query, /opening-/);
    assert.match(query, /-statbox-ending/);
    assert.match(query, /message-6/);
    assert.match(query, /message-7/);
});

test('retrieval ignores generated stat and background-update blocks while preserving narrative', () => {
    const message = {
        mes: '<stat>HELD: barrier sabotage; fear of abandonment</stat>\n'
            + '<background_updates>- [Elsa]: watches the fountain</background_updates>\n'
            + 'Subaru remembers Felt from the trading house.',
    };

    const text = retrievalMessageText(message);

    assert.equal(text, 'Subaru remembers Felt from the trading house.');
});
