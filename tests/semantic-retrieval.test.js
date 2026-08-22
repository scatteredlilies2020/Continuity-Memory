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
