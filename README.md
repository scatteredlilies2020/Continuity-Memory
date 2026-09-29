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

## Installation

1. In SillyTavern, open **Extensions** and choose **Install Extension**.
2. Enter this repository URL:

   ```text
   https://github.com/scatteredlilies2020/Continuity-Memory.git
   ```

The browser extension works on its own; the server plugin is not required to save or recall memory. The bundled `plugin` directory is optional and enables server-side memory jobs that can continue after the browser tab closes, as long as SillyTavern remains running. To use it, install it as the SillyTavern server plugin `continuity-memory`, enable server plugins, and restart SillyTavern.

## Useful to know

- **Model usage and cost.** Extraction and Chronicle summarization make additional model requests, which may incur API costs. Extraction uses your active SillyTavern model by default; you can choose separate models for extraction, summarization, and AI-assisted retrieval. Local retrieval itself makes no AI requests.
- **When memory updates.** Automatic processing is on by default, with 8 messages per Digest. Incomplete groups remain raw until the group is complete, so memory does not update after every message.
- **Context reduction is not deletion.** Older processed messages can be left out of requests to the response model to make room for summaries and recalled details. They remain in your saved chat and on screen.
- **Review before saving.** You can require approval of each Digest extraction and Chronicle promotion before it is saved. This is off by default; enabling it pauses processing for you to save, regenerate, or discard the result.
- **Processing privacy.** Storing memory on your SillyTavern server does not mean model processing stays local. Chat excerpts used for extraction and memory used for summarization are sent to the model provider you configure.
- **Where memory is stored.** Continuity saves its own JSON files on the SillyTavern server, not just in browser storage or in a Lorebook. Within your SillyTavern user data directory (normally `data/default-user`), it uses `user/files` without the server plugin, or `continuity-memory/worlds` with it.
- **Memory also travels with the chat.** **Keep portable memory in chat files** is on by default. It saves a matching memory snapshot in the chat file's metadata and includes it in SillyTavern JSONL chat exports, without rewriting chat messages. Turning it off excludes the portable copy from saved chats and exports; the separate memory files remain. Exported chats can therefore contain remembered details as well as messages, so treat them as private.
- **Transferring memory.** Use JSONL chat exports to move a chat with its embedded memory, or **Export memory** / **Import memory** to transfer memory separately for the same conversation history. To carry memory into a different chat, use **Continue in new chat**, then **Start continuation arc** in the destination. Embedding vectors are stored separately and are not included in portable memory or exports.

## Development

Development link installers are included for Windows (`install-windows.ps1`) and Termux (`install-termux.sh`). Run the project checks with `npm test`.

## License

Continuity Memory is licensed under the [GNU Affero General Public License v3.0](LICENSE).
