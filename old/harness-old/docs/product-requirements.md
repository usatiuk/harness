# Modular Agent Harness PRD

## Purpose

Build a local-first AI coding-agent harness that can support projectless chats, project-bound coding work, configurable model providers, tool use, context experiments, task tracking, subagents, and future UI surfaces without locking the product into one provider, one interface, or one execution environment.

## Goals

- Let users run coding-agent conversations with or without a project attached.
- Let users choose and configure model providers without changing the engine.
- Let model providers use their native capabilities, such as web search, reasoning, or code execution, when available.
- Let users configure reasoning/thinking level, provider options, tool budgets, and model behavior per profile or conversation.
- Track usage and cost in a way users can inspect through the conversation record, including provider events, context builds, turns, and provider metadata.
- Make context easy to inspect, tune, compact, replace, and experiment with.
- Make tools extensible enough for code editing, shell execution, file reads, language-server support, indexers, screenshots, PDFs, images, and other multimodal workflows.
- Provide one service API that can support CLI now and TUI, web, desktop, daemon, or remote clients later.

## Users

- Developers using the harness as a local coding assistant.
- Power users who want profiles for different models, tools, approval policies, and projects.
- Plugin authors adding tools, context strategies, model adapters, task systems, or UI contributions.
- Future UI clients that need a stable service API instead of direct storage access.

## Requirements

### Model Provider Configuration

- Users can configure provider, model, model settings, provider-specific options, reasoning/thinking level, and provider-native tools.
- Users can switch providers/models without changing tools, profiles, UI, or conversation history.
- Provider-native tools are configured as model capabilities, not as normal harness tools.
- Provider responses expose text, tool calls, reasoning/metadata, usage, cost, and provider-native events when available.

### Profiles

- Users can create, list, select, and override profiles.
- Profiles can define model defaults, enabled harness tools, plugin-scoped config, context preferences, approval behavior, execution defaults, and UI preferences.
- MCP server configuration lives under the MCP plugin config instead of a top-level profile field.
- A conversation can use a profile without being tied to a project.
- A project can have multiple conversations using different profiles.

### Conversations

- **Conversation**: The public durable root for one assistant session. It is the complete record of what happened durably: messages, inputs, turns, tool calls/results, activities, interactions, provider events, usage/cost, context, state, assets, artifacts, turn state, and exposed reasoning metadata.
- **ConversationInput**: Durable input into a conversation. Inputs can come from users, activities, system, or plugins, with delivery options (`asap`, `after_active`, `manual`). Input persists safely and never disappears due to turn transitions.
- **Turn**: An internal control-loop execution unit that consumes pending conversation inputs and runs model calls, tool executions, waits, current state updates, and resumptions. It is inspectable but not the primary user interaction target.
- Users can start a projectless conversation.
- Users can start a project-bound coding conversation.
- Users can add or change execution context later.
- Users can continue, steer, interrupt, and resume active work.
- Users can steer an active conversation at explicit turn-state boundaries.

### Tool Executions

- **ToolExecution**: A first-class durable record for one model-requested tool call. It stores the request context, tool parameters, status, pending interactions, resume state, results, created activity IDs, and timestamps.
- Approval and user-input pauses resume through the tool execution ID.
- Synchronous tools complete without creating visible Activities.
- The architecture supports future parallel tool-call execution by making tool executions batch-friendly, while the first slice may execute tool calls sequentially.

### Activities

- **Activity**: A durable, parent-visible work handle used for long-running, inspectable, messageable, or cancellable work (e.g. background bash processes, subagents). It does not include quick synchronous tool calls or model calls.
- Activity behavior is routed by owner plugin and activity kind. Core owns persistence, status transitions, events, interaction linkage, runtime output lookup, and routing; the owner driver owns status details, cancellation, resume behavior, and completion summaries.
- **Subagents**: Subagents are represented as Activities of kind `plugin.subagents.run` backed by a child conversation. Subagent start/delegate, send, peek, wait, and cancel are activities mapped through the subagent activity driver.
- **Background / Detached Activities**: Long-running shell commands or processes can run in the background as Activities, letting the main conversation turn continue while runtime-owned live output remains visible while the process is active.
- **Activity Completion Steering**: When an Activity completes, it emits events and can automatically enqueue a `ConversationInput` (using plugin-supplied content/summary and configured delivery) to steer and wake the agent immediately.

### Context Management

- Users can inspect what context was sent to the model.
- Users can see why context was included, summarized, adapted, or dropped.
- Users can run compaction/summarization explicitly.
- Conversation compaction is synchronous, blocking context work and is not modeled as an Activity.
- Context experiments can be added without replacing the model loop.
- Context can include messages, tool results, file observations, state, assets, summaries, provider metadata, and user responses.
- Model-incompatible content is preserved as references instead of being silently discarded.

### Tools

- Tools can read, write, search, patch, and run commands through the active execution environment.
- Tool output can include concise text, structured data, file references, image/PDF/audio references, logs, and generated artifacts.
- Long-running or high-output tools can emit runtime-only progress and output frames.
- Tools can ask for user input, approval, confirmation, review, or credentials.
- Tools can expose hooks for validation, policy checks, context contribution, state updates, LSP/indexer integration, and future UI actions.
- Tools cannot bypass execution policy.

### Execution Environments

- The first version supports local host execution.
- The product should leave room for Docker, worktrees, SSH, devcontainers, remote daemons, and sandbox policies.
- Projectless conversations must remain valid when no execution environment is attached.
- Execution-provider-specific policy semantics stay owned by the concrete provider/tool rather than a global permission taxonomy.

### MCP And Plugins

- MCP servers are configurable through profiles.
- MCP tools and user-input requests map into the same tool and interaction flow as built-in features.
- Task tracking is plugin-driven and visible as conversation state.
- Plugins can add model context, tools, policy hooks, task state, UI renderers, and workflow behavior.
- Model-assisted auto approval is a plugin hook contribution and handles approval interactions unless explicitly configured for broader user-input handling.

### Multimodal Support

- Users can attach images, PDFs, audio, and files as conversation input.
- The system preserves attached media through provider switches and model capability differences.
- Tools can produce multimodal outputs such as screenshots, binary file reads, rendered pages, generated files, or media assets.
- Deep OCR, PDF parsing, image analysis, and audio transcription are future capabilities, not required in the first slice.

### UI And Inspection

- The CLI can inspect profiles, conversations, turns, events, activities, runtime live output, pending user requests, context, state, assets, artifacts, and effective config.
- Future UI clients use the same service API as the CLI.
- Unknown plugin data remains inspectable through raw JSON or fallback renderers.

### Developer Experience

- Local development runs from TypeScript source.
- Running the CLI or tests does not require rebuilding packages first.
- Package boundaries should not create stale generated-output problems.
- The first implementation should stay small, explicit, and easy to refactor.

## First Slice Acceptance Criteria

- The workspace installs, typechecks, builds, and tests successfully.
- The CLI runs from source in development.
- Users can create/list/select profiles.
- Users can start projectless and project-bound conversations.
- A fake model can emit text and tool calls.
- Basic tools can execute through the active environment.
- Command output can be inspected live while runtime state exists.
- Events and live output can be inspected incrementally without persisting raw output chunks.
- File/image attachments are preserved as inspectable references.
- Provider-native tool configuration reaches the fake provider and is inspectable.
- Context builds and compaction output are inspectable.
- A tool can pause for user input and resume after an answer.
- Task tracking updates conversation state.
- Subagent delegation creates a child conversation and parent-visible Activity.
- The same service API works with in-memory and SQLite-backed test stores.

## Non-Goals For The First Slice

- Polished TUI, web UI, desktop app, or daemon.
- Real provider API calls in tests.
- Full OCR, PDF parsing, image analysis, or audio transcription.
- Real external web search implementation.
- Large planning framework.
- Provider lock-in.
- UI-owned control-loop state.
