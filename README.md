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
- L1, L2, and L3 records maintain a chronological history.
- A compact story-so-far spine keeps the whole covered narrative, from its beginning through its independently stored raw-chat boundary, in working context by default.
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
- chronological L1, L2, and L3 history

The built-in memory viewer lets you search and inspect these records, including the message ranges from which they were created.

Extraction distinguishes the current focus from other continuity-bearing strands. Focused characters, goals, decisions, relationships, and directly consequential subplots receive normal detailed records. Each meaningful non-focused theater or process receives one compact, source-grounded background record with its current condition and certainty. This applies equally to simulation and ordinary roleplay; it does not assume that geographic or political material is background when it directly affects the active story.

## Corrections and revisions

Memory extraction is not treated as infallible.

The **Correct memory** box accepts an OOC correction and proposes the smallest matching changes to structured memory. You see an exact before-and-after preview before anything is saved.

Applied corrections are recorded as authoritative revisions. If a historical event changes, Continuity updates the affected L1 chronology and rebuilds only the L2 and L3 records that depended on it. Corrected records are also protected from stale extraction replay.

Continuity detects edits, deletions, swipes, and branch changes. A checkpoint is withheld whenever newer or changed messages are waiting to be processed, which keeps the recent raw chat authoritative.

When a SillyTavern branch or checkpoint is created, Continuity verifies and locally replays the parent chat's unchanged L1 prefix into a separate memory for the new chat. Only the L1 containing the fork point and the later suffix need fresh extraction; the two-message stability buffer is still preserved.

Mutable state is fail-closed. Scene-local locations, activities, emotions, and plans expire when the next L1 range advances. Longer-running conditions are stored for reconciliation, but are injected as current only when the newest L1 reconfirms them. Predicted or scheduled events remain plans or open threads until they actually occur. Legacy state records without lifecycle metadata are never injected as current.

When the narrative later identifies an earlier unknown, disguised, or descriptive reference, Continuity migrates matching structured references to the canonical entity and merges duplicates. The identification must be supported by the chat; outside franchise knowledge, resemblance, suspicion, and unconfirmed claims do not establish identity.

Relevant existing mutable records are supplied to each extraction with stable IDs. Repeated facts are omitted, genuine changes update the existing ID even when phrased differently, and clearly redundant facts, states, relationships, or threads can be consolidated while retaining every source range. This process follows the current scenario's semantics rather than hardcoded genres, characters, or predicate vocabularies; ambiguous records remain separate.

## Memory retrieval

Continuity offers three retrieval modes.

Retrieval supplements the default story-so-far overview rather than replacing it. Story So Far is persisted as the chronological narrative spine and is returned inside the same L1 extraction response as the structured memory, so normal processing does not make a second Story request. It is built from completed L1 scene summaries and keeps premise, chronology, durable state, unresolved matters, and knowledge boundaries within the configured allowance. Build / Continue and Rebuild remain available as explicit manual recovery actions; Delete removes only Story So Far. Story never reads L2, L3, retrieved records, or other recall output. The main Build action also advances Story through the same L1 processing queue, and Erase everything & start over reconstructs it after structured memory.

### Local matching

Deterministic multilingual text matching with no additional model request. This is the simplest option and a good place to start.

### AI-expanded matching

A model generates related search terms before Continuity performs local matching. This helps with indirect references, alternative names, and callbacks that do not use the original wording.

### Embedding hybrid

Semantic vector retrieval is combined with local text matching. This works well for large memories and paraphrased references without requiring an LLM retrieval request.

Embeddings are optional. The vector index is derived from canonical Continuity memory, stored separately, and never included in memory exports or portable chat snapshots. It can be deleted or rebuilt at any time. If indexing or retrieval fails, Continuity falls back to local matching.

When the optional Continuity server plugin is available, CM uses its detached vector store. If no detached index exists yet, CM copies the exact legacy SillyTavern `index.json`, reads the detached copy back for verification, and only then retires the original. An already verified detached cache also retires a no-larger old cache left by an earlier standalone build; a larger old cache is preserved. Without the server plugin, CM automatically keeps using SillyTavern's native vector API instead of interrupting indexing. Syncthing conflict copies and other similarly named files are never selected for automatic import.

Existing records are embedded once. New and revised records are synchronized incrementally.

Background developments are retrieved only when the current conversation matches their topic, participants, or meaning. They are not inserted into every response merely because they were retained.

## Chronological memory

Continuity builds three levels of chronological memory:

- **L1** records detailed events and scene developments.
- **L2** condenses groups of L1 records into larger arcs.
- **L3** preserves long-running eras and developments.

By default, Continuity creates one L1 from each complete group of 8 messages, one L2 from 24 L1 records, and one L3 from 6 L2 records. A smaller recent message tail stays raw until the next L1 group is complete. The newest AI reply remains provisional raw chat and is excluded from every CM extraction, backlog count, and catch-up calculation until a later message confirms it was kept, so an immediate swipe or regeneration never enters memory.

Once a complete L1 group accumulates, Continuity starts extracting it in the background. When the optional Continuity server plugin is active, an accepted L1 job runs and saves on the SillyTavern server even if the browser tab is discarded. Reopening the chat reconnects to any active job. CM extraction jobs are isolated from ordinary roleplay generation; they use a separate queue and never create or replace chat replies.

Generated L1, L2, and L3 review is off by default. Enable it in extension settings to inspect each result in a centered popup before it is saved. The memory pipeline waits while the popup is open. You can unlock manual editing, regenerate temporary swipe candidates from the same source, revert a draft, or save the selected candidate and continue. Discarding stops processing without saving the candidate; the source messages or lower-level records remain available for a later build.

Roleplay can continue with up to one additional group of uncovered messages because every uncovered message remains verbatim in the prompt. If the uncovered backlog reaches two complete groups (16 messages by default), Continuity catches up before starting the next roleplay response. An extraction request already using the active SillyTavern connection is also allowed to settle first so its temporary request settings cannot leak into roleplay.

Relevant chronology is retrieved alongside structured facts and current state. Overlapping records from different levels are de-duplicated before they are added to the prompt.

This preserves broad narrative continuity without injecting the entire history on every turn.

### Narrative time

Message counts and L1 boundaries record source order, never elapsed story time. Every new L1 receives an immutable temporal anchor and links only to the preceding anchor in the same subjective time frame. Explicit time skips are retained; unstated dates, durations, day boundaries, and synchronization between dreams, flashbacks, alternate timelines, or other local clocks are never inferred.

Relative wording such as “yesterday,” “tomorrow,” “last year,” and “the last 300 days” is preserved and bound to the anchor where it was stated. When one of those memories is retrieved later, Continuity adds its short anchor reference so the phrase cannot silently drift with the current scene. Ordinary non-relative memories carry no extra prompt text, and L2/L3 summaries retain compact anchor spans rather than copying every timestamp.

## Context handling

Continuity reduces old raw chat only after it has been safely covered by memory.

Recent conversation remains verbatim. Extracted records sourced wholly from that visible raw tail are not injected beside it, so an interpretation of recent events cannot compete with the original messages. Older messages are represented by retrieved structured memory and chronology while remaining unchanged and readable in the chat.

If extraction fails or coverage is incomplete, Continuity keeps the uncovered messages in context. Stored ranges whose source messages were edited, swiped, hidden, or deleted are excluded from retrieval immediately and repaired before later use.

When a roleplay request must wait for queued memory work, Continuity shows a single status notification with the pending message count, active range, and queued-job count. Generation resumes automatically when memory is ready.

## Models and connections

L1 extraction (including Story So Far), optional retrieval expansion, correction review, and L2/L3 summarization can each independently use:

- the active SillyTavern connection
- a SillyTavern Connection Profile
- a direct OpenAI-compatible endpoint or proxy, with its own URL and password/key
- OpenRouter, with its own saved key and model

Each category has its own direct provider, endpoint, credential, and model settings. Leaving a category on “Same as extraction model” still inherits Extraction. Embeddings retain their separate proxy/OpenRouter configuration. This allows each memory task to use an appropriate model without changing the main roleplay connection.

Reasoning controls are translated independently for each selected provider. Story So Far follows the L1 extraction request, while AI retrieval keeps its own selector. OpenRouter Auto explicitly preserves reasoning so endpoints that require it are not accidentally disabled by SillyTavern's missing-value fallback; if an endpoint reports that reasoning is mandatory, Continuity retries with reasoning enabled rather than removing the control.

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
