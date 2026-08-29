import assert from 'node:assert/strict';
import test from 'node:test';
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
