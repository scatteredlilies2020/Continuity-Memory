import assert from 'node:assert/strict';
import test from 'node:test';
import { splitScenarioNotes } from '../extension/extraction-context.js';
import { assertAuthoritativeMetaProvenance, authoritativeMetaBoundaries, formatExtractionMessages, isAuthoritativeUserMetaMessage, precedingUserAttributionContext, splitAuthoritativeUserMeta } from '../extension/extraction-context.js';

test('an assistant-led range receives the preceding user turn as attribution-only context', () => {
    const chat = [
        { mes: '"Go buy your own, dead last," Setsuko says.', name: 'Setsuko', is_user: true },
        { mes: 'Her voice catches while Naruto watches.', name: 'Naruto', is_user: false },
    ];
    const messages = [{ index: 1, name: 'Naruto', text: chat[1].mes }];
    const context = precedingUserAttributionContext(chat, messages);
    assert.deepEqual(context, { index: 0, name: 'Setsuko', text: chat[0].mes, isUser: true });
    const formatted = formatExtractionMessages(messages, context);
    assert.match(formatted, /ATTRIBUTION CONTEXT ONLY/);
    assert.match(formatted, /EXCERPT TO EXTRACT/);
    assert.match(formatted, /Go buy your own, dead last/);
});

test('user-led ranges and consecutive assistant turns do not borrow attribution context', () => {
    const userLed = [{ mes: 'Continue.', name: 'User', is_user: true }];
    assert.equal(precedingUserAttributionContext(userLed, [{ index: 0, name: 'User', text: 'Continue.' }]), null);

    const assistants = [
        { mes: 'First narration.', name: 'Narrator', is_user: false },
        { mes: 'Second narration.', name: 'Narrator', is_user: false },
    ];
    assert.equal(precedingUserAttributionContext(assistants, [{ index: 1, name: 'Narrator', text: 'Second narration.' }]), null);
});

test('explicit user OOC and meta assertions are marked as authoritative extraction evidence', () => {
    for (const text of [
        'OOC: Caelen commanded the fleet.',
        '[Meta] Caelen commanded the fleet.',
        "Author's note — Caelen commanded the fleet.",
        '(Canon note) Caelen commanded the fleet.',
    ]) {
        const message = { index: 4, name: 'User', text, isUser: true };
        assert.equal(isAuthoritativeUserMetaMessage(message), true);
        assert.match(formatExtractionMessages([message]), /<AUTHOR_OOC_META_SPAN>/u);
    }
    assert.equal(isAuthoritativeUserMetaMessage({ text: 'Meta: generated panel', isUser: false }), false);
    assert.equal(isAuthoritativeUserMetaMessage({ text: 'OOC: Is Caelen the commander?', isUser: true }), true);
});

test('mixed dialogue and OOC messages explicitly keep author canon out of character speech', () => {
    const formatted = formatExtractionMessages([{
        index: 1,
        name: 'Lucia',
        text: '"The name is Lucia."\nOOC: Lucia has a historically exceptional midichlorian count.',
        isUser: true,
    }]);
    assert.match(formatted, /<IN_WORLD_SPAN>\n"The name is Lucia\."\n<\/IN_WORLD_SPAN>/u);
    assert.match(formatted, /<AUTHOR_OOC_META_SPAN>\nLucia has a historically exceptional midichlorian count\./u);
    assert.match(formatted, /is not Lucia's speech, action, disclosure, or knowledge/u);
});

test('mixed IC and OOC spans are separated deterministically', () => {
    assert.deepEqual(splitAuthoritativeUserMeta({
        name: 'Lucia', isUser: true,
        text: '"Uhm... Lucia. The name is Lucia."\nOoc: I have an abnormally high Midichlorian count.',
    }), {
        inWorld: '"Uhm... Lucia. The name is Lucia."',
        meta: 'I have an abnormally high Midichlorian count.',
    });
});

test('author-only canon cannot be persisted as the persona speech or knowledge', () => {
    const messages = [{
        index: 17, name: 'Lucia', isUser: true,
        text: '"The name is Lucia."\nOOC: I have an abnormally high midichlorian count.',
    }];
    const boundaries = authoritativeMetaBoundaries(messages);
    assert.throws(
        () => assertAuthoritativeMetaProvenance({ chronicleEntry: 'Lucia asserted her abnormally high midichlorian count.' }, boundaries),
        /OOC provenance violation/u,
    );
    assert.throws(
        () => assertAuthoritativeMetaProvenance({ chronicleEntry: 'Vekk learned that her midichlorian count was abnormally high.' }, boundaries),
        /OOC provenance violation/u,
    );
    assert.throws(
        () => assertAuthoritativeMetaProvenance({ chronicleEntry: 'She revealed her abnormally high midichlorian count.' }, boundaries),
        /OOC provenance violation/u,
    );
    assert.doesNotThrow(() => assertAuthoritativeMetaProvenance({
        chronicleEntry: 'Author-level context established Lucia’s abnormally high midichlorian count; Lucia did not disclose it in-world.',
    }, boundaries));
});

test('neutral institutional narration does not trip provenance on an OOC scheduling term', () => {
    const boundaries = authoritativeMetaBoundaries([{
        index: 591, name: 'Lucia', isUser: true,
        text: 'OOC: Advance to the petition filing time',
    }]);
    assert.doesNotThrow(() => assertAuthoritativeMetaProvenance({
        chronicleEntry: 'Lucia’s petition and Nim’s placement materials were formally submitted, with separate tracking and review paths established.',
    }, boundaries));
});

const greetingNote = '**Note: This is Pre-mages flight, Pre-Zoltraak, Pre modern-magic, Pre-Demon King and Seven Sages of Destruction defeat';
const greetingSetup = `**Timeline:** The Ten-Year Journey (Pre-Series)\r\n**Scene:** One Day After the King's Decree\r\n**Location:** The Outskirts of the Royal Capital\r\n${greetingNote}`;

test('greeting setup includes the exact unclosed-bold era note without swallowing narration', () => {
    const message = {
        index: 0, name: 'Frieren', isUser: false,
        text: `${greetingSetup}\r\n\r\nHimmel smiles.\r\n"Who are you?"`,
    };
    const split = splitScenarioNotes(message);
    assert.equal(split.meta, greetingSetup.replaceAll('\r\n', '\n'));
    assert.equal(split.inWorld, 'Himmel smiles.\n"Who are you?"');
    const formatted = formatExtractionMessages([message]);
    assert.match(formatted, /PROVENANCE-SEGMENTED MESSAGE/u);
    assert.match(formatted, /<AUTHOR_OOC_META_SPAN>[\s\S]*Pre-mages flight, Pre-Zoltraak, Pre modern-magic, Pre-Demon King and Seven Sages of Destruction defeat\n<\/AUTHOR_OOC_META_SPAN>/u);
    assert.match(formatted, /<IN_WORLD_SPAN>\nHimmel smiles\.\n"Who are you\?"\n<\/IN_WORLD_SPAN>/u);
    assert.doesNotMatch(formatted, /PROVENANCE-SEGMENTED USER MESSAGE/u);
    assert.equal(isAuthoritativeUserMetaMessage(message), false);
});

test('notes support plain, bracketed, and Markdown labels in both roles at any index', () => {
    for (const header of [
        'Note: Flight is unavailable.', '**Note:** Flight is unavailable.',
        '**Note: Flight is unavailable.**', '__Note__: Flight is unavailable.',
        '[OOC] Flight is unavailable.', '(Meta) Flight is unavailable.',
        "Author's note — Flight is unavailable.", '### Setting: Before powered flight.',
    ]) {
        for (const isUser of [false, true]) for (const index of [0, 8, 45]) {
            const split = splitScenarioNotes({ index, isUser, text: `The party arrives.\n${header}\n\nThe party departs.` });
            assert.match(split?.meta, /Flight is unavailable|Before powered flight/u);
            assert.equal(split?.inWorld, 'The party arrives.\nThe party departs.');
            assert.deepEqual(split.spans.map(span => span.type), ['inWorld', 'meta', 'inWorld']);
        }
    }
});

test('quoted dialogue, blockquotes, code and ordinary narration are not author notes', () => {
    for (const message of [
        { index: 0, isUser: false, is_system: true, text: greetingNote },
        ...[
            '"Note: Flight is unavailable," she says.',
            'He reads "(OOC: Flight is unavailable.)" aloud.',
            '> Note: Flight is unavailable.',
            '```\nNote: Flight is unavailable.\n```',
            'The narrator describes a road.',
        ].map(text => ({ index: 0, isUser: false, text })),
    ]) {
        assert.equal(splitScenarioNotes(message), null);
        assert.doesNotMatch(formatExtractionMessages([message]), /AUTHOR_OOC_META_SPAN/u);
    }
});

test('multiple notes and inline OOC spans preserve intervening and trailing narrative', () => {
    for (const isUser of [false, true]) {
        const text = 'The party stops. (OOC: Flight is unavailable.) They walk.\nNote: The war has not ended.\nThe sun sets.\nMeta: Nobody knows the hidden route.';
        const split = splitScenarioNotes({ index: 26, isUser, text });
        assert.deepEqual(split.spans.map(span => span.type), ['inWorld', 'meta', 'inWorld', 'meta', 'inWorld', 'meta']);
        assert.match(split.inWorld, /They walk/u);
        assert.doesNotMatch(split.meta, /They walk|The sun sets/u);
        assert.match(split.meta, /Flight is unavailable/u);
        assert.match(split.meta, /war has not ended/u);
    }
});

test('line-opening bracketed notes do not absorb trailing narration', () => {
    for (const isUser of [false, true]) for (const note of [
        '(OOC: Flight is unavailable.)', '[Note: The war has not ended.]', '[Timeline: Before powered flight.]',
    ]) {
        const split = splitScenarioNotes({ index: 32, isUser, text: `${note} The party walks.` });
        assert.equal(split.meta, note);
        assert.equal(split.inWorld, 'The party walks.');
        assert.deepEqual(split.spans.map(span => span.type), ['meta', 'inWorld']);
    }
});

test('scenario restrictions are role-independent across fantasy, science fiction, and simulations', () => {
    for (const text of [
        greetingNote,
        '**Note:** This is before hyperdrive; the Empire has not formed.',
        '[GM note] The ceasefire has not been signed; sanctions remain in effect.',
        'OOC:\n- Powered flight is unavailable.\n- The treaty has not been signed.\n  Nobody knows the secret route.',
    ]) for (const isUser of [true, false]) {
        const message = { index: 47, name: isUser ? 'Player' : 'Narrator', isUser, text: `${text}\n\nThe meeting begins.` };
        const split = splitScenarioNotes(message);
        assert.ok(split?.meta);
        assert.equal(split.inWorld, 'The meeting begins.');
        assert.match(formatExtractionMessages([message]), /<AUTHOR_OOC_META_SPAN>/u);
        assert.equal(authoritativeMetaBoundaries([message]).length, 1);
        if (text.startsWith('OOC:')) assert.match(split.meta, /treaty[\s\S]*secret route/u);
    }
});

test('greeting setup enters the same provenance checks as author OOC without making characters learn it', () => {
    const boundaries = authoritativeMetaBoundaries([
        { index: 0, name: 'Frieren', isUser: false, text: `${greetingSetup}\n\nHimmel smiles.` },
    ]);
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].messageIndex, 0);
    assert.throws(() => assertAuthoritativeMetaProvenance({
        chronicleEntry: 'Frieren revealed that Zoltraak was unavailable.',
    }, boundaries), /OOC provenance violation/u);
    assert.doesNotThrow(() => assertAuthoritativeMetaProvenance({
        chronicleEntry: 'The scenario predates Zoltraak and modern magic. Himmel smiles.',
    }, boundaries));
});
