# Continuity Memory for SillyTavern

Structured, revisable long-term memory for roleplay and simulations.

Continuity extracts events, facts, relationships, character states, and open threads from a chat. It keeps those records tied to their source messages, builds a compact chronological history, and retrieves the parts that matter for the current scene.

Each chat has its own isolated memory. Continuity does not use, create, or modify SillyTavern Lorebooks or World Info, and it never edits chat messages.

## Why Continuity exists

Long chats create two different memory problems:

1. Recent events and the current scene must remain coherent.
2. Older details must return when they become relevant.

A rolling summary helps with the first problem, but gradually loses detail. Vector search helps with the second, but cannot guarantee that current state and unresolved threads remain visible.

Continuity combines several forms of memory instead:

- Recent messages remain in their original form.
- Structured records preserve facts, relationships, states, and events.
- L1, L2, and L3 records maintain a chronological history.
- Retrieval selects relevant older memories for each response.
- Reviewed corrections remain authoritative when extraction gets something wrong.

This produces a compact working context backed by a searchable and traceable history.

## What it remembers

Continuity maintains structured records for:

- checkpoints
- entities
- facts
- character and world states
- relationships
- events
- open threads
- chronological L1, L2, and L3 history

The built-in memory viewer lets you search and inspect these records, including the message ranges from which they were created.

## Corrections and revisions

Memory extraction is not treated as infallible.

The **Correct memory** box accepts an OOC correction and proposes the smallest matching changes to structured memory. You see an exact before-and-after preview before anything is saved.

Applied corrections are recorded as authoritative revisions. If a historical event changes, Continuity updates the affected L1 chronology and rebuilds only the L2 and L3 records that depended on it. Corrected records are also protected from stale extraction replay.

Continuity detects edits, deletions, swipes, and branch changes. A checkpoint is withheld whenever newer or changed messages are waiting to be processed, which keeps the recent raw chat authoritative.

Mutable state is fail-closed. Scene-local locations, activities, emotions, and plans expire when the next L1 range advances. Longer-running conditions are stored for reconciliation, but are injected as current only when the newest L1 reconfirms them. Predicted or scheduled events remain plans or open threads until they actually occur. Legacy state records without lifecycle metadata are never injected as current.

## Memory retrieval

Continuity offers three retrieval modes.

### Local matching

Deterministic multilingual text matching with no additional model request. This is the simplest option and a good place to start.

### AI-expanded matching

A model generates related search terms before Continuity performs local matching. This helps with indirect references, alternative names, and callbacks that do not use the original wording.

### Embedding hybrid

Semantic vector retrieval is combined with local text matching. This works well for large memories and paraphrased references without requiring an LLM retrieval request.

Embeddings are optional. The vector index is derived from canonical Continuity memory, stored separately, and never included in memory exports or portable chat snapshots. It can be deleted or rebuilt at any time. If indexing or retrieval fails, Continuity falls back to local matching.

Existing records are embedded once. New and revised records are synchronized incrementally.

## Chronological memory

Continuity builds three levels of chronological memory:

- **L1** records detailed events and scene developments.
- **L2** condenses groups of L1 records into larger arcs.
- **L3** preserves long-running eras and developments.

By default, Continuity creates one L1 from each complete group of 8 messages, one L2 from 24 L1 records, and one L3 from 6 L2 records. A smaller recent message tail stays raw until the next L1 group is complete.

Relevant chronology is retrieved alongside structured facts and current state. Overlapping records from different levels are de-duplicated before they are added to the prompt.

This preserves broad narrative continuity without injecting the entire history on every turn.

### Narrative time

Message counts and L1 boundaries record source order, never elapsed story time. Every new L1 receives an immutable temporal anchor and links only to the preceding anchor in the same subjective time frame. Explicit time skips are retained; unstated dates, durations, day boundaries, and synchronization between dreams, flashbacks, alternate timelines, or other local clocks are never inferred.

Relative wording such as “yesterday,” “tomorrow,” “last year,” and “the last 300 days” is preserved and bound to the anchor where it was stated. When one of those memories is retrieved later, Continuity adds its short anchor reference so the phrase cannot silently drift with the current scene. Ordinary non-relative memories carry no extra prompt text, and L2/L3 summaries retain compact anchor spans rather than copying every timestamp.

## Context handling

Continuity reduces old raw chat only after it has been safely covered by memory.

Recent conversation remains verbatim. Extracted records sourced wholly from that visible raw tail are not injected beside it, so an interpretation of recent events cannot compete with the original messages. Older messages are represented by retrieved structured memory and chronology while remaining unchanged and readable in the chat.

If extraction fails or coverage is incomplete, Continuity keeps the uncovered messages in context.

## Models and connections

L1 extraction, L2 and L3 summarization, and optional retrieval expansion can use:

- the active SillyTavern connection
- a SillyTavern Connection Profile
- a direct OpenAI-compatible endpoint
- OpenRouter

Extraction and summarization can use different models. This allows routine memory processing to use a smaller model without changing the main roleplay connection.

## Storage and portability

Memory is isolated per chat and stored through SillyTavern's authenticated user-file API.

Continuity supports:

- memory export and import
- optional portable memory inside exported chats
- revisions and source fingerprints
- independent rebuilding of the embedding index
- transparent splitting of large memories into smaller internal files

Exports still produce one portable JSON file. Imports are accepted only for a fingerprint-matching copy of the same conversation, including a transferred chat on another device. Unrelated chats and changed branches are rejected.

## Installation

1. In SillyTavern, open **Extensions** and choose **Install Extension**.
2. Enter this repository URL:

   ```text
   https://codeberg.org/scatteredlilies2020/Continuity_Memory.git
   ```

No server plugin, terminal command, additional dependency, or user-managed folder is required.

Continuity creates no memory files merely from browsing an untouched chat.

## Development

Windows and Termux development-link installers are included:

- `install-windows.ps1`
- `install-termux.sh`

Run the project checks with:

```bash
npm test
```

## License

See [LICENSE](LICENSE).
