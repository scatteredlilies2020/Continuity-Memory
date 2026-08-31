# Continuity Memory for SillyTavern

Structured, revisable long-term memory for roleplay and simulations.

Continuity extracts events, facts, relationships, character states, open threads, and compact background developments from a chat. It keeps those records tied to their source messages, builds a compact chronological history, and retrieves the parts that matter for the current scene.

Each chat has its own isolated memory. Continuity does not use, create, or modify SillyTavern Lorebooks or World Info, and it never edits chat messages.

## Why Continuity exists

Long chats create two different memory problems:

1. Recent events and the current scene must remain coherent.
2. Older details must return when they become relevant.

A rolling summary helps with the first problem, but gradually loses detail. Vector search helps with the second, but cannot guarantee that current state and unresolved threads remain visible.

Continuity combines several forms of memory instead:

- Recent messages remain in their original form.
- Structured records preserve facts, relationships, states, events, and compact background developments.
- Digest records retain detailed source-linked scene history.
- Recursive Chronicle nodes keep the covered narrative compact across C0, C1, C2, and higher layers.
- Retrieval selects relevant older memories for each response.
- Relevant events and open threads receive full detail, while a small always-present continuity ledger retains strong completed-event and unresolved-thread titles through unrelated scenes.
- Reviewed corrections remain authoritative when extraction gets something wrong.

This produces a compact working context backed by a searchable and traceable history.

Continuity also exposes the already-prepared prompt through a small read-only browser bridge for compatible extensions such as Tale Fairy. The bridge never starts retrieval or extraction, exposes no mutation methods, and marks its snapshot stale as soon as the active chat changes.

## What it remembers

Continuity maintains structured records for:

- checkpoints
- entities
- facts
- character and world states
- relationships
- events
- open threads
- background developments outside the current focus
- chronological Digest and Recursive Chronicle history

The built-in memory viewer lets you search and inspect these records, including the message ranges from which they were created.

Extraction distinguishes the current focus from other continuity-bearing strands. Focused characters, goals, decisions, relationships, and directly consequential subplots receive normal detailed records. Each meaningful non-focused theater or process receives one compact, source-grounded background record with its current condition and certainty. This applies equally to simulation and ordinary roleplay; it does not assume that geographic or political material is background when it directly affects the active story.

## Corrections and revisions

Memory extraction is not treated as infallible.

The **Correct memory** box accepts an OOC correction and proposes the smallest matching changes to structured memory. You see an exact before-and-after preview before anything is saved.

Applied corrections are recorded as authoritative revisions. If a historical event changes, Continuity updates the affected Digest chronology and rebuilds only the Chronicle nodes that depended on it. Corrected records are also protected from stale extraction replay.

Continuity detects edits, deletions, swipes, and branch changes. A checkpoint is withheld whenever newer or changed messages are waiting to be processed, which keeps the recent raw chat authoritative.

When a SillyTavern branch or checkpoint is created, Continuity verifies and locally replays the parent chat's unchanged Digest prefix into a separate memory for the new chat. Only the Digest containing the fork point and the later suffix need fresh extraction; the two-message stability buffer is still preserved.

Mutable state is fail-closed. Scene-local locations, activities, emotions, and plans expire when the next Digest range advances. Longer-running conditions are stored for reconciliation, but are injected as current only when the newest Digest reconfirms them. Predicted or scheduled events remain plans or open threads until they actually occur. Legacy state records without lifecycle metadata are never injected as current.

When the narrative later identifies an earlier unknown, disguised, or descriptive reference, Continuity migrates matching structured references to the canonical entity and merges duplicates. The identification must be supported by the chat; outside franchise knowledge, resemblance, suspicion, and unconfirmed claims do not establish identity.

Relevant existing mutable records are supplied to each extraction with stable IDs. Repeated facts are omitted, genuine changes update the existing ID even when phrased differently, and clearly redundant facts, states, relationships, or threads can be consolidated while retaining every source range. This process follows the current scenario's semantics rather than hardcoded genres, characters, or predicate vocabularies; ambiguous records remain separate.

## Memory retrieval

Continuity retains three retrieval configurations. Visible roleplay generation always uses latency-safe local matching, so an LLM or vector provider can never hold the reply open. Automatic embedding updates are triggered only by actual structured-memory revisions, not by every visible reply.

Retrieval supplements the active Recursive Chronicle frontier rather than replacing it. Each Digest extraction returns a source-linked C0 Chronicle entry in the same response as structured memory, so normal processing does not need a second request for that entry. Older nodes are recursively promoted into compact parents while their source-linked children remain available for inspection. The active frontier keeps chronological continuity in working context within its separate configured allowance.

### Local matching

Deterministic multilingual text matching with no additional model request. This is the simplest option and a good place to start.

### AI-expanded matching

This configuration is retained for memory tooling and future enhanced retrieval. It is not called on the visible roleplay path.

### Embedding hybrid

The optional vector index is retained for memory tooling and future enhanced retrieval. Vector queries are not called on the visible roleplay path. When auto-sync is enabled, changed structured or Chronicle records are embedded after a memory revision; unchanged replies do not request or retry embeddings.

Embeddings are optional. The vector index is derived from canonical Continuity memory, stored separately, and never included in memory exports or portable chat snapshots. It can be deleted or rebuilt at any time. Indexing failures never affect visible roleplay, which already uses local matching.

When the optional Continuity server plugin is available, CM uses its detached vector store. If no detached index exists yet, CM copies the exact legacy SillyTavern `index.json`, reads the detached copy back for verification, and only then retires the original. An already verified detached cache also retires a no-larger old cache left by an earlier standalone build; a larger old cache is preserved. Without the server plugin, CM automatically keeps using SillyTavern's native vector API instead of interrupting indexing. Syncthing conflict copies and other similarly named files are never selected for automatic import.

Existing records are embedded once. New and revised records are synchronized incrementally.

Background developments are retrieved only when the current conversation matches their topic, participants, or meaning. They are not inserted into every response merely because they were retained.

## Chronological memory

Continuity builds chronological memory from detailed **Digest** records and a **Recursive Chronicle**. Each Digest creates one source-linked C0 node. When a Chronicle layer exceeds its configured capacity (24 by default), the oldest eligible nodes are summarized into a parent at the next level; groups of 10 are promoted by default. The same rule recursively creates C1, C2, C3, and higher layers without a fixed maximum depth or deletion of their sources.

By default, Continuity creates one Digest from each complete group of 8 messages. A smaller recent message tail stays raw until the next Digest group is complete. The newest AI reply remains provisional raw chat and is excluded from every CM extraction, backlog count, and catch-up calculation until a later message confirms it was kept, so an immediate swipe or regeneration never enters memory.

Once a complete Digest group accumulates, Continuity starts extracting it in the background. When the optional Continuity server plugin is active, an accepted Digest job runs and saves on the SillyTavern server even if the browser tab is discarded. Reopening the chat reconnects to any active job. Hung model requests time out, and temporary connection or rate-limit failures retry in the background with capped exponential backoff until they succeed or you explicitly stop processing. CM extraction jobs are isolated from ordinary roleplay generation; they use a separate queue and never create or replace chat replies.

Generated Digest and Chronicle review is off by default. Enable it in extension settings to inspect each result in a centered popup before it is saved. The memory pipeline waits while the popup is open. You can unlock manual editing, regenerate temporary swipe candidates from the same source, revert a draft, or save the selected candidate and continue. Discarding stops processing without saving the candidate; the source messages or lower-level records remain available for a later build.

Roleplay can continue with up to one additional group of uncovered messages because every uncovered message remains verbatim in the prompt. If the uncovered backlog reaches two complete groups (16 messages by default), Continuity catches up before starting the next roleplay response. An extraction request already using the active SillyTavern connection is also allowed to settle first so its temporary request settings cannot leak into roleplay.

The complete active Chronicle frontier is injected alongside retrieved structured facts and current state. Covered child nodes remain stored but are not duplicated in the active prompt.

This preserves broad narrative continuity without injecting the entire history on every turn.

### Narrative time

Message counts and Digest boundaries record source order, never elapsed story time. Every new Digest receives an immutable temporal anchor and links only to the preceding anchor in the same subjective time frame. Explicit time skips are retained; unstated dates, durations, day boundaries, and synchronization between dreams, flashbacks, alternate timelines, or other local clocks are never inferred.

Relative wording such as “yesterday,” “tomorrow,” “last year,” and “the last 300 days” is preserved and bound to the anchor where it was stated. When one of those memories is retrieved later, Continuity adds its short anchor reference so the phrase cannot silently drift with the current scene. Ordinary non-relative memories carry no extra prompt text, and promoted Chronicle nodes retain compact anchor spans rather than copying every timestamp.

## Context handling

Continuity reduces old raw chat only after it has been safely covered by memory.

Recent conversation remains verbatim. Extracted records sourced wholly from that visible raw tail are not injected beside it, so an interpretation of recent events cannot compete with the original messages. Older messages are represented by retrieved structured memory and chronology while remaining unchanged and readable in the chat.

If extraction fails or coverage is incomplete, Continuity keeps the uncovered messages in context. Stored ranges whose source messages were edited, swiped, hidden, or deleted are excluded from retrieval immediately and repaired before later use.

Roleplay never waits for extraction, hierarchy building, embedding synchronization, or an embedding query. Continuity injects the latest safe snapshot using local matching on the generation path; unfinished memory and revision-triggered vector work continues in the background, while recent unprocessed messages remain available as raw chat.

## Models and connections

Digest extraction, optional retrieval expansion, correction review, and Chronicle promotion can each independently use:

- the active SillyTavern connection
- a SillyTavern Connection Profile
- a direct OpenAI-compatible endpoint or proxy, with its own URL and password/key
- OpenRouter, with its own saved key and model

Each category has its own direct provider, endpoint, credential, and model settings. Leaving a category on “Same as extraction model” still inherits Extraction. Embeddings retain their separate proxy/OpenRouter configuration. This allows each memory task to use an appropriate model without changing the main roleplay connection.

Reasoning controls are translated independently for each selected provider. Chronicle entry creation follows the Digest extraction request, while promotion and AI retrieval keep their own selectors. OpenRouter Auto explicitly preserves reasoning so endpoints that require it are not accidentally disabled by SillyTavern's missing-value fallback; if an endpoint reports that reasoning is mandatory, Continuity retries with reasoning enabled rather than removing the control.

## Storage and portability

Memory is isolated per chat. The browser-only installation stores it through SillyTavern's authenticated user-file API. When the optional server plugin is installed, CM automatically migrates file-backed worlds without changing their IDs or revisions. It reads each detached world back and compares its full canonical content before retiring the exact active source files. Divergent same-ID worlds, Syncthing conflict copies, and failed migrations are preserved for manual resolution rather than guessed or deleted.

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
   https://github.com/scatteredlilies2020/Continuity-Memory.git
   ```

The browser extension works without another dependency. Tab-independent extraction additionally requires the bundled `plugin` directory to be installed as the SillyTavern server plugin `continuity-memory`, with `enableServerPlugins: true`, followed by a SillyTavern restart. The included Termux and Windows link installers install both halves for development checkouts.

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

Continuity Memory is licensed under the [GNU Affero General Public License v3.0](LICENSE).
