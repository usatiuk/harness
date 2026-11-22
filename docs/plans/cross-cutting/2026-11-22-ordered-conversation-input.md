# Ordered conversation input and plugin data

Status: Complete

The conversation log records what happened in order. Core selects the active branch and window. Plugins interpret their own data. Provider adapters receive ordered model input and translate it into wire format.

## Log and request contracts

- Keep the existing item envelope (ID, conversation, turn, parent, sequence, timestamp) and item kinds: message, reasoning, tool call, tool result, provider output, context, compaction. Add one kind, `{ type: "plugin_data", plugin: string, data: JsonValue }`. Core stamps the emitting plugin's registered name. The plugin defines the payload.
- Model-visible instructions use ordinary items. A system message opens each new window. A context item holds instructions from a file, an update, or a removal notice. These are immutable once appended.
- Keep the summary on the compaction item. Add `windowStart: ItemId` pointing to the first item in its new window. Append `[system, opening context…, compaction(summary, windowStart=system.id), carried plugin items…]` in one transaction. Select from the latest compaction's window start on the active branch, inclusive. This preserves log order and puts the fresh system message first. Before the first compaction, select from the branch root.
- Use one ordered input list on both `NewContextBuild` and `ModelRequest`. Remove the separate `instructions` and `prompt` fields. An entry is either an existing eligible item with its optional replay payload or an inline message for an auxiliary call. Record the former by item reference and the latter by value. Core resolves the recorded selection before calling an adapter. Preserve tool schemas, model options, reasoning payloads, and originating tool-call identities.
- Exclude plugin data and display-only provider output before recording model input or estimating its tokens. Render the compaction summary in place. The raw log remains inspectable. Auxiliary prompts for titles, reviews, and compaction belong to their own recorded request.

## Plugin interface

A plugin reads the active window through the existing history API and folds its own data in log order. A fork sees its ancestry. Reopening the same branch gives the same result.

Hooks that contribute conversation items return an ordered list. Each entry is either a context item with `key` and `content`, or `{ type: "plugin_data", data: JsonValue }`. Core fills in the plugin name and appends the returned items together at the hook's boundary. For a file-tool batch, that happens after all sibling results. Returning an empty list adds nothing.

For example, when AGENTS.md changes, the hook returns two items together: the context notice for the model and the path and digest for the plugin. The plugin reconciles all paths in the batch before returning that list.

The optional `onCompact` hook reads the old window and returns the data items the plugin wants to keep. Core includes them after the summary in the transaction that opens the new window. Omitting the hook resets the plugin's state.

## AGENTS.md flows

The plugin uses records shaped like `{ path, digest }`, where the path is a normalized source identity and the digest covers the file text supplied to the model. A null digest records removal. Its local fold builds a map of active paths to digests, deleting a path on a removal record. The full text lives in the visible context item. An empty file has a digest and is distinguishable from a missing file.

1. **First turn.** Before the first user item, append a system message built from current Harness rules and configured prompt, then append the current workspace and applicable fixed plugin guidance in deterministic order. The AGENTS.md plugin reads the global and initial project files and returns a context item and a plugin-data item for each. The system guidance says the latest notice for a given instruction source governs its scope. Resume and fork continue from their inherited head.
2. **Later user turn.** Recheck the global file and initial project chain before handling the new input. Compare against the plugin's map. A new or changed file produces one notice containing the path, scope, and full current text, plus one data item. A previously supplied file that disappeared produces one removal notice and receipt. An unchanged file produces nothing. Treat access errors as errors, distinct from absence.
3. **Nested files and workspace changes.** At the existing file-tool discovery boundary, reconcile applicable nested paths with the same function. Preserve path containment and platform normalization. Process overlapping discoveries once after sibling tool results are complete. On workspace switch append the workspace notice, retire previously supplied paths outside the new scope, and reconcile the new initial chain. Other nested paths are checked when revisited.
4. **Compaction.** Summarize the old model-visible window. Reuse first-turn context construction with current configuration and freshly read initial files. Commit the batch in the order above. Failed or cancelled compaction leaves the previous window active. Continue any compactor output after the batch. AGENTS.md omits the carry hook: new initial files are already recorded and nested files will be rediscovered on access.
5. **Retry.** Replay the recorded request for the same logical invocation. A retry never rereads files or regenerates committed opening context. Changes to the configured base prompt take effect when opening the next window.

## Provider boundary

Core hands every adapter the same ordered items. A fresh window starts with the system message and the initial workspace and file notices. An ordinary turn simply extends that sequence with user input, assistant output, and tool calls and results as they occur. An instruction edit adds a context item where the change was observed.

Render every AGENTS.md notice as user content labeled with its source and scope, at the point it enters the log. This applies equally to initial reads, edits, and removals. Only the wire representation of the Harness base prompt varies.

- **OpenAI Responses.** Put the base in `input[0]` with role `developer` and leave top-level `instructions` unset. Endpoints configured to require system-role input use that role for the opening message. File notices are user messages in `input[]`. [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- **Chat Completions.** Put the base in the opening `messages[]` entry, using `system` for the supported compatible endpoints. Append file notices as user content. Remove the adapter's current hoisting of context into the opening message. [Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- **Anthropic Messages.** Put the base in top-level `system`. Render file notices as text in user messages. A notice discovered during a tool batch follows its tool-result blocks. [Anthropic Messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)

Verify the serialized prefix across completed turns with fixed settings and tools, including tool-result grouping, deferred images, assistant phases, and native replay.

## Delivery and acceptance

- [x] **1. Protocol and storage.** Add plugin data, ordered request entries, recording of inline entries, and atomic window writes to both stores. In a one-time SQLite migration, insert an opening message using the conversation’s configured instructions before each old window. Preserve branch ancestry, item IDs, and historical request snapshots. Verify opening a populated database, reading its history, and starting a new conversation without clearing it. Keep compatibility work in the migration.
- [x] **2. Core and plugins** (after 1). Implement shared opening context construction, post-compaction plugin output, and the AGENTS.md fold. Remove activation-cached instruction text and path-key scans of visible context. Exercise edit, removal, recreation, overlapping tools, reopen, fork, workspace switch, and cancelled compaction. Verify fresh initial instructions and nested rediscovery after compaction. A test plugin that carries state should observe its own ordinary post-boundary record.
- [x] **3. Adapters and auxiliary callers** (after 1, integrating with 2). Move every caller to ordered input and remove the old prompt assembly paths. Capture actual serialized requests across a normal turn, a tool batch, and an instruction edit. Assert the previous completed prefix survives, the update occurs exactly once at the tail, plugin data never reaches the wire, and native reasoning and tool replay still round-trip.
- [x] **4. Integration** (after 2–3). Verify context-build inspection and usage reporting against the sent input. Update owning subsystem docs and testing guidance, then run `npm run check`.

Validation on Windows passed with `npm run check -- --maxWorkers=4` (2,108 tests passed, 83 skipped). The Mistral fixture exercised stateless HTTP replay across SQLite reopen. Chat Completions and Anthropic tests compared successive serialized requests after an instruction edit. Anthropic moves its ephemeral cache marker as the request grows. Actual provider cache hits require live traffic.
