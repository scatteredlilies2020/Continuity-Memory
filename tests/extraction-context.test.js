import assert from 'node:assert/strict';
import test from 'node:test';
import { formatExtractionMessages, isAuthoritativeUserMetaMessage, precedingUserAttributionContext } from '../extension/extraction-context.js';

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
        assert.match(formatExtractionMessages([message]), /AUTHORITATIVE USER OOC\/META ASSERTION — STORE DURABLE ASSERTIONS AS CANON/u);
    }
    assert.equal(isAuthoritativeUserMetaMessage({ text: 'Meta: generated panel', isUser: false }), false);
    assert.equal(isAuthoritativeUserMetaMessage({ text: 'OOC: Is Caelen the commander?', isUser: true }), true);
});
