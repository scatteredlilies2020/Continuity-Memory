import { splitScenarioNotes } from './extraction-context.js';

// This is a source-preservation channel, not another AI-generated summary.
// Keep exact text and role/scope instead of guessing facts from keywords.
export function captureScenarioContext(messages) {
    return (messages || []).flatMap(message => {
        const messageIndex = Number(message?.index);
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || message?.is_system) return [];
        const split = splitScenarioNotes(message, { preserveLabels: true });
        const spans = (split?.spans || []).filter(span => span.type === 'meta' || messageIndex === 0)
            .map(span => ({ ...span, opening: span.type !== 'meta' }));
        // An opening (including prose around labelled notes) can establish an entire setting. There is no
        // model-independent way to separate its premise from its prose, so keep
        // that source intact rather than claiming to infer the important bits.
        const opening = !spans.length && messageIndex === 0
            ? String(message.text ?? message.mes ?? '').trim() : '';
        if (opening) spans.push({ text: opening, opening: true });
        return spans.map((span, noteIndex) => ({
            messageIndex, noteIndex,
            kind: span.opening ? 'opening' : 'scenario-note',
            role: message.isUser === true || message.is_user === true ? 'user' : 'assistant',
            speaker: String(message.name || ''),
            text: span.text,
        }));
    });
}

export function collectScenarioContext(world, chatKey, options = {}) {
    const inheritedKey = world?.continuation?.inheritedChatKey;
    const keys = new Set([inheritedKey, chatKey].filter(Boolean));
    // A complete live source list wins over stored copies, including when a
    // note was edited/deleted. Never resurrect deleted canon from a Digest.
    const live = Array.isArray(options.scenarioSourceMessages);
    const candidates = [];
    for (const capsule of world?.capsules || []) {
        if (!keys.has(capsule.chatKey) || (live && capsule.chatKey === chatKey)) continue;
        if ((options.invalidSourceRanges || []).some(range => range.chatKey === capsule.chatKey
            && capsule.from <= range.to && capsule.to >= range.from)) continue;
        for (const note of capsule.sourceScenarioContext || []) candidates.push({ ...note, chatKey: capsule.chatKey });
    }
    if (live) for (const note of captureScenarioContext(options.scenarioSourceMessages)) {
        candidates.push({ ...note, chatKey });
    }
    const seen = new Set();
    return candidates.filter(note => {
        if (typeof note.text !== 'string' || !note.text.trim() || !Number.isInteger(note.messageIndex)) return false;
        const raw = options.rawTailRange;
        if (note.chatKey === chatKey && raw && note.messageIndex >= raw.from && note.messageIndex <= raw.to) return false;
        // Deduplicate copies of the same source, never collapse later repeated
        // assertions across intervening corrections into a timeless claim.
        const key = JSON.stringify([note.chatKey, note.messageIndex, note.noteIndex, note.text]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((left, right) => Number(left.chatKey !== inheritedKey) - Number(right.chatKey !== inheritedKey)
        || left.messageIndex - right.messageIndex || left.noteIndex - right.noteIndex);
}

export function renderScenarioContext(notes) {
    if (!notes.length) return '';
    const guidance = 'Source-authored setup, preserved independently of summaries. Explicit scenario-note assertions define RP canon within their stated scope and time; later explicit corrections override conflicting earlier assertions. Explicit user corrections take precedence over conflicting assistant notes. Questions, hypotheticals, and writing requests are not world facts. Scenario notes do not establish character speech or knowledge. Unlabelled opening excerpts retain their original narration/dialogue attribution, not blanket author-level authority. Do not expand ambiguous era labels using outside lore.';
    return `\nSource scenario context (verbatim):\n${guidance}\n${notes.map(note => JSON.stringify({
        source: note.chatKey, message: note.messageIndex, kind: note.kind || 'scenario-note', role: note.role,
        speaker: note.speaker, text: note.text,
    })).join('\n')}\n`;
}
