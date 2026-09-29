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

The browser extension works on its own. The bundled `plugin` directory is optional and enables server-side memory jobs that can continue after the browser tab closes. To use it, install it as the SillyTavern server plugin `continuity-memory`, enable server plugins, and restart SillyTavern.

## Development

Development link installers are included for Windows (`install-windows.ps1`) and Termux (`install-termux.sh`). Run the project checks with `npm test`.

## License

Continuity Memory is licensed under the [GNU Affero General Public License v3.0](LICENSE).
