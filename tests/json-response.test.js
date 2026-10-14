import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseJsonResponse as parse } from '../extension/json-response.js';

// Both transports must use the same tested parser.
for (const file of ['extension/engine.js', 'plugin/detached-jobs.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    test(`${file}: shares the JSON parser`, () => {
        assert.match(source, /import \{ parseJsonResponse \} from ['"][^'"]*json-response\.js['"]/);
        assert.doesNotMatch(source, /^function parseJsonResponse\(/m);
    });

    test(`${file}: valid JSON after prose with an unmatched quotation mark`, () => {
        assert.equal(parse('Here is the "final answer:\n```json\n{"facts":[]}\n```').facts.length, 0);
    });

    test(`${file}: reasoning tags in JSON values are data, not removable markup`, () => {
        const expected = '<think>an in-story inscription</think>';
        assert.equal(parse(JSON.stringify({ chronicleEntry: expected })).chronicleEntry, expected);
        assert.equal(parse(`Result:\n${JSON.stringify({ chronicleEntry: expected })}`).chronicleEntry, expected);
    });

    test(`${file}: skips reasoning blocks without corrupting escaped strings or nesting`, () => {
        const result = parse('<think>Scratch { "unfinished</think>\n{"facts":[{"value":"A \\"quote\\" and } brace"}]}');
        assert.equal(result.facts[0].value, 'A "quote" and } brace');
    });

    test(`${file}: selects the final complete object rather than earlier scratch JSON`, () => {
        assert.equal(parse('{"draft":true}\nFinal answer:\n{"facts":[]}').facts.length, 0);
    });

    test(`${file}: an unfinished reasoning wrapper does not invalidate complete JSON`, () => {
        for (const tag of ['think', 'thinking', 'thought', 'reasoning']) {
            assert.deepEqual(parse(`<${tag}>Consider the source.\n{"draft":true}\nFinal answer:\n\`\`\`json\n{"facts":[]}\n\`\`\``), { facts: [] });
        }
    });

    test(`${file}: closed reasoning alone is never treated as the answer`, () => {
        assert.throws(() => parse('<think>{"facts":[]}</think>'), /without a valid JSON object/);
    });

    test(`${file}: does not salvage a nested record or scratch object from a truncated final answer`, () => {
        for (const text of ['{"facts":[{"value":"complete child"}]', '{"draft":true}\n{"facts":[', '<think>{"draft":true}\n{"facts":[', '<think>Still considering the source.']) {
            assert.throws(() => parse(text), /without a valid JSON object/);
        }
    });

    test(`${file}: malformed JSON remains rejected without exposing response contents`, () => {
        for (const text of ['private narrative only', '{"private":"value",}', '{"private":"unescaped\nnewline"}']) {
            assert.throws(() => parse(text), error => /without a valid JSON object/.test(error.message)
                && !/private|narrative|unescaped/.test(error.message));
        }
    });
}
