# Continuity Memory for SillyTavern

Continuity Memory automatically builds and updates memory for long SillyTavern chats. It creates rolling summaries and saves important story details in the background, then recalls relevant memories for each reply. It works without Lorebooks or World Info and does not modify them.

## What it does

- **Keeps recent chat as-is.** New and unprocessed messages remain available in their original form.
- **Builds rolling summaries.** A detailed **Digest** covers each completed group of messages. Older history is combined into a **Recursive Chronicle**, which gives the response model a compact timeline of the story.
- **Saves important details separately.** It records facts, events, relationships, character and world states, and supporting observations, with links back to their source messages.
- **Recalls relevant memories.** When a reply is being prepared, it selects older details related to the current conversation instead of adding everything it has stored. Local matching is built in; AI-assisted search and semantic embeddings are optional.
- **Handles changes.** You can review and correct memory. If chat messages are edited, deleted, swiped, or branched, Continuity checks and repairs affected memory rather than treating it as settled history.
- **Keeps chats separate.** Each chat has its own memory, and Continuity does not change saved chat messages.

Memory processing runs in the background. If part of a chat has not been processed yet, those messages remain available as raw chat. Summaries and retrieval help with continuity, but they are not a perfect replacement for the original conversation.

### What the response model receives

Memory is presented in up to four sections: **Memory constraints**, **Current context**, **Relevant details**, and **Story so far**. Empty sections are omitted. Short labels preserve distinctions such as established knowledge, subjective beliefs, historical observations, and last-known conditions; source, time, uncertainty, and conditions remain with their details.

This is a presentation grouping, not another summarization pass. Internal categories still receive their existing retrieval allowances, selected rows remain complete, and the full eligible Chronicle is retained. Stored memories and extraction categories are unchanged. The recall allowance remains a soft target, and the final token estimate includes the rendered layout.

## Installation

1. In SillyTavern, open **Extensions** and choose **Install Extension**.
2. Enter this repository URL:

   ```text
   https://github.com/scatteredlilies2020/Continuity-Memory.git
   ```

The browser extension works on its own; the server plugin is not required to save or recall memory. The optional server plugin enables server-side memory jobs that can continue after the browser tab closes, as long as SillyTavern remains running.

### Optional server plugin

Install the **whole repository**, not just its `plugin/` subdirectory, at `SillyTavern/plugins/continuity-memory`. You can clone it there, copy the repository there, or link that location to an existing repository checkout. The required layout is:

```text
SillyTavern/plugins/continuity-memory/
├── package.json          # root package: main is plugin/index.js
├── plugin/
│   ├── index.js
│   └── ...
└── extension/
    ├── storage-compaction.js
    └── ...
```

Keep the complete contents of both directories. The server plugin shares modules with the browser extension; `plugin/` is not a self-contained package. Enable `enableServerPlugins: true` in SillyTavern's configuration and restart SillyTavern. The Windows and Termux development installers link the repository root for you and refuse to overwrite an existing installation.

**Docker:** place the whole checkout in the host's mounted plugins directory as `continuity-memory`, or bind-mount the whole checkout to `/home/node/app/plugins/continuity-memory`. For example, add this entry to the SillyTavern service's Compose `volumes` list (adjust the host path):

```yaml
- /absolute/host/path/Continuity-Memory:/home/node/app/plugins/continuity-memory:ro
```

The mount source must be the repository root, not `Continuity-Memory/plugin`. Host symlink targets are not automatically available inside the container; a direct bind mount avoids that issue. Recreate the container after changing its mounts. A read-only source mount is sufficient for loading the plugin; SillyTavern's data and browser-extension directories must remain writable. Update the checkout on the host and restart the container to load new plugin code.

**Existing broken installs:** an error mentioning `plugins/extension/storage-compaction.js` means the plugin's expected sibling modules are missing from the resolved layout. With SillyTavern stopped, repoint the existing plugin link to the repository root, or replace the plugin-only copy/mount with the whole checkout above. Do not rename it to `extension` or move/delete SillyTavern's user data. Memory files are stored separately in the user data directory.

## Useful to know

- **Model usage and cost.** Extraction and Chronicle summarization make additional model requests, which may incur API costs. Extraction uses your active SillyTavern model by default; you can choose separate models for extraction, summarization, and AI-assisted retrieval. Local retrieval itself makes no AI requests.
- **When memory updates.** Automatic processing is on by default, with 8 messages per Digest. Incomplete groups remain raw until the group is complete, so memory does not update after every message.
- **Concise, not cut off.** Chronicle is the main historical account; relevant structured memories supply precise supporting detail. New Chronicle entries aim for roughly 2,400 characters or less, but this is a soft target: consequential meaning takes priority, and accepted prose is saved in full. Parent summaries and the injected Chronicle frontier are not hard-truncated either. Model output/context limits still apply. Previously clipped saved entries are not automatically rewritten by this update.
- **Context reduction is not deletion.** Older processed messages can be left out of requests to the response model to make room for summaries and recalled details. They remain in your saved chat and on screen.
- **Review before saving.** You can require approval of each Digest extraction and Chronicle promotion before it is saved. This is off by default; enabling it pauses processing for you to save, regenerate, or discard the result.
- **Processing privacy.** Storing memory on your SillyTavern server does not mean model processing stays local. Chat excerpts used for extraction and memory used for summarization are sent to the model provider you configure.
- **Where memory is stored.** Continuity saves its own JSON files on the SillyTavern server, not just in browser storage or in a Lorebook. Within your SillyTavern user data directory (normally `data/default-user`), it uses `user/files` without the server plugin, or `continuity-memory/worlds` with it.
- **Memory also travels with the chat.** **Keep portable memory in chat files** is on by default. It saves a matching memory snapshot in the chat file's metadata and includes it in SillyTavern JSONL chat exports, without rewriting chat messages. Turning it off excludes the portable copy from saved chats and exports; the separate memory files remain. Exported chats can therefore contain remembered details as well as messages, so treat them as private.
- **Transferring memory.** Use JSONL chat exports to move a chat with its embedded memory, or **Export memory** / **Import memory** to transfer memory separately for the same conversation history. To carry memory into a different chat, use **Continue in new chat**, then **Start continuation arc** in the destination. Embedding vectors are stored separately and are not included in portable memory or exports.

## Development

Development link installers are included for Windows (`install-windows.ps1`) and Termux (`install-termux.sh`). Run the project checks with `npm test`.

- `npm run test:recall` checks the actual injected prompt against fabricated long-history expectations: exact conditions, knowledge boundaries, uncertain beliefs, prerequisite recall, historical plans/outcomes, raw-tail/source invalidation, and irrelevant-memory exclusion. It also tests complete Chronicle prose across the former truncation boundary.
- `npm run benchmark:retrieval` measures cold retrieval, cooperative corpus preparation, and prepared retrieval at 500, 2,000, and 10,000 distractor records across six scenarios. Override with `npm run benchmark:retrieval -- --sizes 500,2000 --runs 3`. The JSON report includes correctness failures and estimated prompt sizes; a failed recall check exits nonzero. Timings are machine-dependent, not CI thresholds.

These fixtures represent 640 source-message positions with a promoted Chronicle and mixed memory categories. They use no private chats or model calls and do not prove real-chat extraction or creative response quality. Retrieval ranking should change only when measured recall or packing failures justify it.

## License

Continuity Memory is licensed under the [GNU Affero General Public License v3.0](LICENSE).
