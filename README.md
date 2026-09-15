# Continuity Memory for SillyTavern

Structured, revisable long-term memory for roleplay and simulations.

Continuity extracts events, facts, relationships, character states, and supporting observations from a chat. It keeps those records tied to their source messages, builds a compact chronological history, and retrieves the parts that matter for the current scene.

Each chat has its own isolated memory. Continuity does not use, create, or modify SillyTavern Lorebooks or World Info, and it never edits chat messages.

## Why Continuity exists

Long chats create two different memory problems:

1. Recent events and the current scene must remain coherent.
2. Older details must return when they become relevant.

A rolling summary helps with the first problem, but gradually loses detail. Vector search helps with the second, but cannot guarantee that chronology and consequential details remain coherent.

Continuity combines several forms of memory instead:

- Recent messages remain in their original form.
- Structured records preserve facts, relationships, states, events, and supporting observations.
- Digest records retain detailed source-linked scene history.
- Recursive Chronicle nodes keep the covered narrative compact across C0, C1, C2, and higher layers.
- Retrieval selects relevant older memories for each response.
- Relevant events and supporting memories receive complete selected rows. No unconditional open-thread reminders are injected. Without a rendered Chronicle, the fallback ledger offers up to three recent event titles not already recalled; with the Chronicle, that extra recap is omitted.
- Reviewed corrections remain authoritative when extraction gets something wrong.

This produces a compact working context backed by a searchable and traceable history.

The Chronicle is a lossy narrative backbone; structured records remain its detailed, retrievable support. Prompt assembly avoids repeating the same record across entity canon, facts, supporting recall, and the fallback ledger. This is presentation-only: records and source links are not deleted or merged, Chronicle coverage is not evidence that a detail is redundant, and similar wording alone never justifies discarding different conditions, timelines, or character perspectives. Duplicate suppression happens only after a complete row is actually packed, so a budget-excluded row cannot hide its other retrieval path.

Supporting continuity requires a topical/contextual connection or an explicit record reference; sharing a source batch or temporal anchor and a character name alone is insufficient. Its one-hop envelope is capped at 24 records (smaller for tight budgets), not a fill target. Records outside that envelope remain directly retrievable. Supporting memories are historical evidence with source ranges, not claims that a plan remains open or has closed. A later outcome does not suppress the earlier conditions. Similar headings alone never justify merging distinct observations.

### Historical memory and the raw-chat handoff

The aim is to approximate access to the whole conversation: older history is carried by the Chronicle and retrievable structured detail, while the retained recent messages provide verbatim continuation. Context reduction removes eligible, fingerprint-matched extracted messages from the outgoing prompt, not from the saved chat; unprocessed or changed messages stay available. Compression and retrieval remain imperfect, not lossless replacements for the original history.

The Chronicle describes what was established **at each point in history**, not a live list of open or closed tasks. For example, an earlier entry can say “Aster planned to inspect the bridge before dawn, if Beryl consented”; a later entry can describe consent, the inspection, and its result. Neither entry assigns a current lifecycle status. Uncertainty, conditions, deadlines, consequences, and character knowledge remain explicit. Supporting memories follow the same historical policy.

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
- supporting memories: historical plans, questions, knowledge gaps, and non-focal developments
- chronological Digest and Recursive Chronicle history

The built-in memory viewer lets you search and inspect these records, including the message ranges from which they were created. **Supporting memories** combines the former Open threads and Background developments views.

The legacy `threads` and `backgrounds` storage channels remain compatible; new observations use `status: "recorded"`. Old lifecycle labels remain available for audit but never control supporting recall. Updates preserve prior observations, certainty and source ranges; matching whole observations share their provenance, while different details remain separate. Earlier versions still present in saved extraction replay are also available without rebuilding. Continuation handoffs retain this history. Explicit corrections supersede the corrected record and keep its prior history in the correction audit, not as competing truth. Source deletion, range replacement and Undo remove the corresponding invalidated observations.

This does not recover text already absent from both saved records and extraction replay; recovering that requires the original source. Retrieval is selective, not a promise that every stored detail appears in every reply.

Saved source excerpts remain available in Digests and continuation exports for provenance. Prompt assembly no longer appends the automatic **Source scenario context (verbatim)** block of openings and labelled notes. The Chronicle supplies the continuity overview; current conversation and relevant structured records supply supporting detail. No OOC, director, or other special labels are required for retrieval, and unrelated excerpts do not fill empty categories.

Extraction distinguishes the current focus from other continuity-bearing strands. Focused characters, goals, decisions, relationships, and directly consequential subplots receive normal detailed records. Each meaningful non-focused theater or process receives a source-grounded supporting observation with its condition at that point and certainty. This applies equally to simulation and ordinary roleplay; it does not assume that geographic or political material is background when it directly affects the active story.

## Corrections and revisions

Memory extraction is not treated as infallible.

The **Correct memory** box accepts an OOC correction and proposes the smallest matching changes to structured memory. You see an exact before-and-after preview before anything is saved.

Applied corrections are recorded as authoritative revisions. If a historical event changes, Continuity updates the affected Digest chronology and rebuilds only the Chronicle nodes that depended on it. Corrected records are also protected from stale extraction replay.

Continuity detects edits, deletions, swipes, and branch changes. A checkpoint is withheld whenever newer or changed messages are waiting to be processed, which keeps the recent raw chat authoritative.

When a SillyTavern branch or checkpoint is created, Continuity verifies and locally replays the parent chat's unchanged Digest prefix into a separate memory for the new chat. Only the Digest containing the fork point and the later suffix need fresh extraction; the two-message stability buffer is still preserved.

Mutable state is fail-closed. Scene-local locations, activities, emotions, and plans expire when the next Digest range advances. Longer-running conditions are stored for reconciliation, but are injected as current only when the newest Digest reconfirms them. Predicted or scheduled events are retained as historical plans; later outcomes add evidence rather than erasing those plans. Legacy state records without lifecycle metadata are never injected as current.

When the narrative later identifies an earlier unknown, disguised, or descriptive reference, Continuity migrates matching structured references to the canonical entity and merges duplicates. The identification must be supported by the chat; outside franchise knowledge, resemblance, suspicion, and unconfirmed claims do not establish identity.

Relevant existing mutable records are supplied to each extraction with stable IDs. Repeated facts are omitted, genuine changes update the existing ID even when phrased differently, and clearly redundant facts, states, relationships, or threads can be consolidated while retaining every source range. This process follows the current scenario's semantics rather than hardcoded genres, characters, or predicate vocabularies; ambiguous records remain separate.

## Memory retrieval

Replies and previews use the selected retrieval mode: local matching, AI-assisted search with local matching, or semantic embeddings with local matching. All three retrieve structured categories and supporting memories alongside the Chronicle. Optional provider lookups have a ten-second deadline and fall back to contextual local recall on failure or timeout. Semantic lookup also falls back when the index is incomplete; it never waits for index building. Automatic embedding updates are triggered only by actual structured-memory revisions, not by every visible reply.

Retrieval supplements the active Recursive Chronicle frontier rather than replacing it. Each Digest extraction returns a source-linked C0 Chronicle entry in the same response as structured memory, so normal processing does not need a second request for that entry. Older nodes are recursively promoted into compact parents while their source-linked children remain available for inspection. The complete active frontier is included without token clipping, in addition to the soft structured-recall target. Layer capacity and promotion group size control when older nodes are summarized; neither is a hard token limit.

### Local matching

Deterministic multilingual text matching with no additional model request. It runs in all three modes. The latest user message and coherent passages from the immediate exchange supply relevance, so a short reply can still retrieve details about the subject being discussed. An explicit change of named topic limits carryover from the previous exchange. A speaker name alone does not select their entire inventory, and incidental words scattered across messages do not form a supporting-memory query. The recent-message setting controls the conversation available to retrieval. Decorative status panels and background-update blocks are excluded from query text. HTML styling, scripts, and attributes are removed while visible table contents and paragraph boundaries remain searchable. Common filler words and partial name substrings do not establish relevance.

### AI-assisted search with local matching

Select **AI-assisted search + local matching** to ask a model for relevant search phrases from recent conversation. These phrases supplement local evidence across the same structured categories and supporting memories. This mode does not query embeddings. Its model can inherit Extraction or use a separate connection profile or direct endpoint; reasoning and search prompts are configurable. Failed or late requests leave local recall available. Saved AI mode selections are preserved.

### Semantic embeddings with local matching

Select **Semantic embeddings + local matching** to retrieve by meaning as well as wording. Queries use the existing configured provider and index; repeated identical queries for the same memory revision reuse cached ranks. Maximum semantic candidates and minimum similarity control the candidate pool. The strongest eight semantic hits may introduce details without exact keyword overlap; lower-ranked hits need independent evidence from the current topic or participants. This keeps room for useful discoveries without filling every category from a long vector-result list. Search-hit titles and names never become new query terms. Results map back to current canonical records, with normal invalid-source, raw-tail, freshness, deduplication and packing rules still applied. With auto-sync enabled, memory revisions update the index in the background. Retrieval diagnostics distinguish selected candidates from records actually injected, including facts supplied inside entity rows. Supporting details accompany the Chronicle in the roleplay prompt; they are not another generated summary. Identical facts with different storage IDs share one rendered occurrence, including facts supplied inside entity rows. Distinct conditions, holders, certainty, and temporal evidence remain separate. Source labels use short message ranges; full IDs and canonical embedding text remain unchanged in storage. Empty entity rows are omitted, and incidental entity mentions do not automatically append unrelated canon.

Embeddings are optional. The vector index is derived from canonical Continuity memory, stored separately, and never included in memory exports or portable chat snapshots. It can be deleted or rebuilt at any time. Indexing failures never affect visible roleplay, which already uses local matching.

When the optional Continuity server plugin is available, CM uses its detached vector store. If no detached index exists yet, CM copies the exact legacy SillyTavern `index.json`, reads the detached copy back for verification, and only then retires the original. An already verified detached cache also retires a no-larger old cache left by an earlier standalone build; a larger old cache is preserved. Without the server plugin, CM automatically keeps using SillyTavern's native vector API instead of interrupting indexing. Syncthing conflict copies and other similarly named files are never selected for automatic import.

Existing records are embedded once. New and revised records are synchronized incrementally.

Supporting memories are retrieved only when the current conversation matches their topic, participants, or meaning. They are not inserted into every response merely because they were retained.

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

Relative wording such as “yesterday,” “tomorrow,” “last year,” and “the last 300 days” is preserved and bound to the anchor where it was stated. When one of those memories is retrieved later, Continuity adds its short anchor reference so the phrase cannot silently drift with the current scene. Supporting observations always carry source-bound historical labels; other non-relative memories need no additional relative-time wording, and promoted Chronicle nodes retain compact anchor spans rather than copying every timestamp.

## Context handling

Continuity reduces old raw chat only after it has been safely covered by memory.

Recent conversation remains verbatim. Extracted records sourced wholly from that visible raw tail are not injected beside it, so an interpretation of recent events cannot compete with the original messages. Older messages are represented by retrieved structured memory and chronology while remaining unchanged and readable in the chat.

If extraction fails or coverage is incomplete, Continuity keeps the uncovered messages in context. Stored ranges whose source messages were edited, swiped, hidden, or deleted are excluded from retrieval immediately and repaired before later use.

Roleplay never waits for extraction, hierarchy building, or embedding synchronization. In either optional retrieval mode, only the bounded search lookup can delay prompt assembly (up to ten seconds); local mode makes no retrieval provider request. Unfinished memory and revision-triggered indexing continue in the background, while recent unprocessed messages remain available as raw chat.

## Models and connections

Digest extraction, correction review, Chronicle promotion, and AI retrieval can each independently use:

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
