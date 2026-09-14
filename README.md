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
- Relevant events and open threads receive full detail. The fallback ledger offers up to six unresolved reminders (four priority slots, then latest), packed individually without clipping conditions or deadlines. Without a rendered Chronicle it also offers up to three recent event titles; with the Chronicle, that extra event recap is omitted. Only records not already supplied by full recall qualify.
- Reviewed corrections remain authoritative when extraction gets something wrong.

This produces a compact working context backed by a searchable and traceable history.

The Chronicle is a lossy narrative backbone; structured records remain its detailed, retrievable support. Prompt assembly avoids repeating the same record across entity canon, facts, supporting recall, and the fallback ledger. This is presentation-only: records and source links are not deleted or merged, Chronicle coverage is not evidence that a detail is redundant, and similar wording alone never justifies discarding different conditions, timelines, or character perspectives. Duplicate suppression happens only after a complete row is actually packed, so a budget-excluded row cannot hide its other retrieval path.

Supporting continuity requires a topical/contextual connection or an explicit record reference; sharing a source batch or temporal anchor and a character name alone is insufficient. Its one-hop envelope is capped at 24 records (smaller for tight budgets), not a fill target. Records outside that envelope remain directly retrievable. Open-thread retrieval, support, and the ledger all use the newest same-title lifecycle record, so a newer resolved record cannot resurrect an older open copy. These are read-only prompt policies, not semantic corrections to saved records: differently titled stale threads still need evidence-backed reconciliation, and ambiguous reminder details are preserved rather than guessed or shortened.

### Historical memory and the raw-chat handoff

The aim is to approximate access to the whole conversation: older history is carried by the Chronicle and retrievable structured detail, while the retained recent messages provide verbatim continuation. Context reduction removes eligible, fingerprint-matched extracted messages from the outgoing prompt, not from the saved chat; unprocessed or changed messages stay available. Compression and retrieval remain imperfect, not lossless replacements for the original history.

The Chronicle describes what was established **at each point in history**, not a live list of open or closed tasks. For example, an earlier entry can say “Aster planned to inspect the bridge before dawn, if Beryl consented”; a later entry can describe consent, the inspection, and its result. Neither entry assigns a current lifecycle status. Uncertainty, conditions, deadlines, consequences, and character knowledge remain explicit. Structured threads and their ledger own lifecycle status separately.

Existing Chronicle `openThreads` fields remain readable for compatibility and are presented as **Context at that point**, never as an “Open” list. New generation uses that field only for historical context not already carried by the narrative. Identical whole fields within one rendered node appear once; stored nodes and their source links are not rewritten or deleted. Default and custom prompt builders apply the historical policy on future requests, but do not automatically rewrite old prose or rebuild saved history.

Durable lore and Chronicle nodes are excluded as raw-message duplicates only when all their sources are inside the retained interval in this chat. Mixed-source records and nodes crossing the boundary stay eligible, because a recent mention does not prove their older details are present verbatim. Some overlap is preferable to a missing condition or cause. Transient states/checkpoints keep their separate latest-source freshness rules.

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

Explicit scenario notes anywhere in the chat—including greetings, assistant messages, and user messages, with Markdown-formatted `Note:`, `Timeline:`, `Premise:`, and OOC/meta labels—are preserved directly from source, independently of what the extraction model remembers to write. Each Digest stores those source excerpts, roles, and message positions; opening-message prose is also retained, including prose around labelled notes. This uses generic source structure, not hard-coded settings or lore.

Prompt assembly includes this **Source scenario context (verbatim)** separately from the lossy Chronicle and budgeted structured recall. Copies of the same source appear once, and excerpts already present in the retained raw-message tail are omitted. Distinct later corrections and reassertions retain their order. Labels, conditions, and source wording are not semantically deduplicated or clipped; whitespace around spans and line endings are normalized. Explicit user corrections override conflicting assistant notes. Unlabelled opening prose retains its narration/dialogue attribution; quoted documents, questions, hypotheticals, and writing requests are not blanket world facts or character knowledge.

Existing memory does not require a rebuild: when the original chat remains available, injection reads its source excerpts directly, also respecting source edits and deletions. This does not rewrite old generated prose or reconstruct source text already deleted before it was stored; existing exports missing these excerpts still need the original chat or a new scan before transfer. Newly stored excerpts survive Chronicle promotion, hierarchy rebuilds, and continuation exports. Reload the updated extension and restart SillyTavern to load the updated server extraction worker.

This channel prevents model omissions from erasing recognized scenario notes or the opening message from assembled continuity context. It does not guarantee perfect downstream AI compliance or lossless recall of every unlabelled detail later in the conversation. Large openings or many notes add to the prompt outside the soft recall budget; the model/provider's finite context window still applies.

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

Replies and previews use latency-safe local matching by default, so an LLM or vector provider can never hold the reply open. The optional embedding-index maintenance mode does not change reply retrieval. Automatic embedding updates are triggered only by actual structured-memory revisions, not by every visible reply.

Retrieval supplements the active Recursive Chronicle frontier rather than replacing it. Each Digest extraction returns a source-linked C0 Chronicle entry in the same response as structured memory, so normal processing does not need a second request for that entry. Older nodes are recursively promoted into compact parents while their source-linked children remain available for inspection. The complete active frontier is included without token clipping, in addition to the soft structured-recall target. Layer capacity and promotion group size control when older nodes are summarized; neither is a hard token limit.

### Local matching

Deterministic multilingual text matching with no additional model request. This is the active retrieval method for both selectable modes. The recent-message setting controls how much conversation local matching considers, including when optional index maintenance is enabled.

### Legacy AI-expanded settings

The inactive AI-expanded mode and its model, reasoning, and prompt controls are no longer shown. Existing installations using that mode migrate to local matching. Saved provider configuration is preserved; no credentials or memory are deleted.

### Optional embedding index maintenance

Select **Local matching + optional embedding index maintenance** to build or maintain the derived vector index. This does not enable vector queries or improve reply retrieval in this version, and provider calls for indexing may incur costs. Unused vector-query tuning controls are no longer shown. When auto-sync is enabled, changed structured or Chronicle records are embedded after a memory revision; unchanged replies do not request or retry embeddings. Existing index opt-ins remain enabled after updating.

Embeddings are optional. The vector index is derived from canonical Continuity memory, stored separately, and never included in memory exports or portable chat snapshots. It can be deleted or rebuilt at any time. Indexing failures never affect visible roleplay, which already uses local matching.

When the optional Continuity server plugin is available, CM uses its detached vector store. If no detached index exists yet, CM copies the exact legacy SillyTavern `index.json`, reads the detached copy back for verification, and only then retires the original. An already verified detached cache also retires a no-larger old cache left by an earlier standalone build; a larger old cache is preserved. Without the server plugin, CM automatically keeps using SillyTavern's native vector API instead of interrupting indexing. Syncthing conflict copies and other similarly named files are never selected for automatic import.

Existing records are embedded once. New and revised records are synchronized incrementally.

Background developments are retrieved only when the current conversation matches their topic, participants, or meaning. They are not inserted into every response merely because they were retained.

## Retired features and older memory

Standalone Rolling Story generation, refinement, and deletion have been retired in favor of Digest and Recursive Chronicle. Stale callers receive an explicit error instead of starting the old generation pipeline. If old controls still appear, update Continuity Memory and reload SillyTavern. Use **Build** for missing Digest/C0 entries, or **Rebuild every Chronicle layer** to regenerate chronology from existing Digest without erasing structured memory.

Supported saved snapshots, attributed-belief migration, and source-edit recovery remain supported; older fields alone do not require a rescan. If memory lacks the stored Digest replay data needed for **Undo latest Digest**, export it first and explicitly choose **Erase everything & start over** to rescan the chat. That action clears reviewed corrections too; a Chronicle-only rebuild cannot restore missing Digest replay data.

An unsupported storage version requires updating the extension and optional server plugin, not erasing memory. The reader leaves the files untouched and does not replace an unsupported newer server manifest with an older Syncthing conflict copy.

## Chronological memory

Continuity builds chronological memory from detailed **Digest** records and a **Recursive Chronicle**. Each Digest creates one source-linked C0 node. When a Chronicle layer exceeds its configured capacity (24 by default), the oldest eligible nodes are summarized into a parent at the next level; groups of 10 are promoted by default. The same rule recursively creates C1, C2, C3, and higher layers without a fixed maximum depth or deletion of their sources.

Pending promotions can run as server jobs without extracting another Digest. Connection failures and invalid parent responses remain pending and retry with delays capped at one minute; validation failures receive correction feedback. Stop cancels pending retries. Authentication or configuration errors remain visible for correction. When the chat is open, idle checks also recover an over-capacity Chronicle after interrupted work or a server restart. Parent validation permits attribution already supported by the child text while still checking new claims against author-note boundaries.

By default, Continuity creates one Digest from each complete group of 8 messages. A smaller recent message tail stays raw until the next Digest group is complete. The newest AI reply remains provisional raw chat and is excluded from every CM extraction, backlog count, and catch-up calculation until a later message confirms it was kept, so an immediate swipe or regeneration never enters memory.

Once a complete Digest group accumulates, Continuity starts extracting it in the background. When the optional Continuity server plugin is active, an accepted Digest job runs and saves on the SillyTavern server even if the browser tab is discarded. Reopening the chat reconnects to any active job. Hung model requests time out, and temporary connection or rate-limit failures retry in the background with capped exponential backoff until they succeed or you explicitly stop processing. CM extraction jobs are isolated from ordinary roleplay generation; they use a separate queue and never create or replace chat replies.

Generated Digest and Chronicle review is off by default. Enable it in extension settings to inspect each result in a centered popup before it is saved. The memory pipeline waits while the popup is open. You can unlock manual editing, regenerate temporary swipe candidates from the same source, revert a draft, or save the selected candidate and continue. Discarding stops processing without saving the candidate; the source messages or lower-level records remain available for a later build.

Roleplay is not blocked by a fixed Digest-backlog threshold. Continuity prepares the latest safe local snapshot and leaves uncovered messages raw for SillyTavern's normal context handling while memory processing continues in the background. There is no 16-message catch-up gate.

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

Digest extraction, correction review, and Chronicle promotion can each independently use:

- the active SillyTavern connection
- a SillyTavern Connection Profile
- a direct OpenAI-compatible endpoint or proxy, with its own URL and password/key
- OpenRouter, with its own saved key and model

Each category has its own direct provider, endpoint, credential, and model settings. Leaving a category on “Same as extraction model” still inherits Extraction. Embeddings retain their separate proxy/OpenRouter configuration. This allows each memory task to use an appropriate model without changing the main roleplay connection.

Reasoning controls are translated independently for each selected provider. Chronicle entry creation and correction follow the extraction reasoning control, while Chronicle promotion has its own selector. OpenRouter Auto explicitly preserves reasoning so endpoints that require it are not accidentally disabled by SillyTavern's missing-value fallback; if an endpoint reports that reasoning is mandatory, Continuity retries with reasoning enabled rather than removing the control.

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
