# Harness PRD

## Purpose

Build a clean local-first agent runtime from first principles. The first product is not a coding-agent mega-system. It is a robust conversation engine with durable conversation items, model providers, context inspection, compaction, profiles, and a small CLI/TUI shell.

The first version intentionally has no tools, plugins, activities, approvals, subagents, MCP, sandbox execution, or live-output system. Those features should be added only after the conversation layer is boring and correct.

## Product Principles

- One conversation is one durable append-only item log.
- `ConversationItem` is immutable truth. If content changes, it is a new item.
- The model sees only items selected by a `ContextBuild`.
- Provider events, audit notes, run lifecycle, and UI notes stay inspectable but are not prompt material by default.
- Provider-specific fidelity is stored as optional `ProviderEncoding` rows attached to exact conversation items.
- Provider encodings are not memory or a parallel transcript. They are API wire encodings for selected immutable items.
- Provider encodings are usable only when they match the selected item id, conversation id, sequence, provider, adapter, and model.
- Compaction bounds future prompt input by selecting a projection item instead of older items.
- No legacy schema, no compatibility shims, no old stream/checkpoint/tool/activity concepts in `harness`.

## V0 Scope

`harness` supports:

- profiles with model config and prompt fragments;
- projectless conversations;
- ordered durable `conversation_items`;
- one non-reentrant model-run pump per conversation;
- fake model, OpenAI Responses, and ChatGPT/Codex-backed OpenAI adapter;
- final assistant message persistence;
- provider events and per-item provider encoding storage;
- typed model accounting for usage and future cost estimates;
- context builds for inspecting model input selection;
- deterministic compaction projections with sequence cursors;
- basic input delivery: `send`, `queue`, `manual`, `interrupt`;
- SQLite and in-memory test stores;
- CLI commands for profiles, auth, conversations, items, runs, context, and compaction;
- a minimal readline TUI.

## Core Records

`conversation_items` are the canonical log:

- `class`: `transcript | control | provider | projection | audit`
- `kind`: `user_message | assistant_message | system_message | model_error | provider_event | context_projection | run_event | audit_note`
- `role`: `system | user | assistant` when applicable
- `visibility`: `model | ui | audit`
- `sequence`, `runId`, source refs, content blocks, data, timestamps

Other durable records:

- `conversations`: metadata, profile/config, status, title
- `agent_runs`: one active run per conversation
- `context_builds`: selected items and diagnostics for each model call
- `context_projections`: summary content plus `coversThroughItemSequence`
- `provider_encodings`: provider/adapter/model/format payload for one exact conversation item
- `profiles`: reusable model and prompt defaults

## Runtime Behavior

Sending model-visible input requests the conversation pump. The pump:

1. creates a running `agent_run` if none is active;
2. builds bounded context from prompt fragments, latest projection, and uncovered model-visible transcript;
3. attaches compatible provider encodings for selected items;
4. calls the selected model adapter;
5. commits the final assistant item, provider events, optional assistant provider encoding, and run completion in one store operation;
6. continues if queued input still needs a model response.

If the model stream or assistant-response commit fails, no assistant message from that failed run is persisted. A visible `model_error` item and failed run record are written.

## Steering V0

- `send`: append model-visible user input and run immediately when possible.
- `queue`: if idle, append model-visible user input and run; if active, append a UI-visible control item immediately, then promote it to model-visible transcript after the active run finishes.
- `manual`: append UI-visible note only; it is inspectable but not prompt-selected.
- `interrupt`: cancel the active run, abandon that run's selected unresponded input for future prompt selection, append model-visible input, and start a fresh run.

There is no current-run injection yet. Without tools, the only safe model boundary is after the current model stream finishes or is interrupted.

## Provider Rules

Model adapters receive `ModelRequest` containing instructions, selected immutable items, matching provider encodings for the current provider/adapter/model, model config, and context build id.

Model adapters expose only `stream(request)`. Every adapter emits `text_delta`, `provider_event`, and exactly one `completed` event; non-native-streaming providers emit one final text delta and completion.

Harness v0 has no tool protocol. If a provider returns function calls, the adapter fails the model stream explicitly and core persists no assistant message.

OpenAI adapters keep `store:false`, request encrypted reasoning when supported, and validate streaming terminal events. Streams must end in a completed terminal response. OpenAI reasoning continuity is preserved by storing each assistant response's Responses output items as a provider encoding attached to that assistant item.

Provider switching is mechanical:

- Same provider/adapter/model: selected items may use compatible encodings.
- Different provider/adapter/model: old encodings are ignored and selected items render from canonical content.
- Compacted-away items are not selected, so their encodings are not sent.

## Explicit Non-Goals For V0

Do not implement yet:

- tool calls or tool results;
- plugin host or capability registry;
- activities or waits;
- approvals/interactions;
- subagents;
- MCP;
- sandbox execution;
- output peeking, streaming, redirection, or transforms;
- assets/artifacts beyond future design space;
- old Harness DB compatibility.

## Future Roadmap

Future work should ship in small phases. Each phase must keep the v0 invariants: one canonical item log, explicit prompt selection, bounded compaction, per-item provider encodings, and a non-recursive conversation pump.

1. Recovery hardening
   Add startup/reopen reconciliation for stale `running` runs, queued input promotion, interrupted input, and provider encodings after a crash. Recovery must either resume from a valid durable boundary or fail the stale run explicitly; it must not silently continue from ambiguous in-memory state.

2. Tool execution core
   Add assistant tool-call items, `tool_executions`, and tool-result transcript obligations. Every assistant tool call must eventually produce exactly one tool result. Pending means only that the result obligation is unresolved; it is not a separate wait system.

3. Canonical tool and multimodal items
   Add provider-neutral item kinds/content blocks for tool calls, tool results, multimodal payloads, reasoning summaries, citations, and server-side tool metadata. Provider encodings can preserve exact OpenAI/Gemini/Anthropic wire fidelity, but canonical items must still contain enough truth to inspect and render history without the original provider.

4. Plugin host and capability registry
   Add plugin registration for tools, policy hooks, context contributors, durable plugin state, and named capabilities. Core validates contracts and ordering. Plugin context must be durable/model-visible or projection-backed, recorded in `context_builds`, and compatible with provider encoding selection. Plugins own domain behavior. No untyped side effects, hidden schedulers, or parallel transcripts.

5. Approval, policy, and steering
   Implement approvals as transactional tool gates: append an approval request, mark the target tool execution pending, and store continuation state together. Deny/block is terminal and immediately resolves the tool call with a denial result.

    Extend steering only at legal boundaries: model boundary, next run, manual promotion, or interrupt. Interrupt must define what happens to active model calls, pending tool obligations, approvals, and activity-backed work without injecting user input between an assistant tool call and its required tool result.

6. Activities and output plugins
   Activities own long-running work, activity records, drivers, status, cancellation, and activity-backed tool result obligations. Output owns runtime streaming frames, peek/follow/subscribe, UI preview, redaction, transforms, and explicit file redirection. Runtime output is not durable transcript or prompt material unless a plugin explicitly converts a bounded result into a model-visible item or projection. SQLite must not store raw output chunks.

7. Execution, bash, and subagents
   Bash should create activities through the activities capability, use execution/sandbox capability for processes, and use output capability for stdout/stderr. Subagents should be normal plugin tools backed by child conversations and optional activities; parent prompts must not absorb child transcripts accidentally.

8. MCP, tasks, and richer UI
   MCP tools, elicitation, task workflows, and richer TUI/web/daemon surfaces should be plugins on top of the same tool/activity/output contracts. UI support should display pending approvals, activity status, output preview/follow, redirection state, and plugin-owned lifecycle items without making those concepts core.

Roadmap rule: a phase is not accepted unless it includes focused regression tests, preserves prompt legality, has crash/recovery behavior for its durable records, and deletes obsolete paths instead of carrying compatibility shims.

## Acceptance Criteria

- `harness` installs, typechecks, tests, and builds.
- CLI runs from source and from built `dist`.
- Simple fake-model conversation creates ordered user/run/assistant records.
- Failed model call persists no partial assistant text.
- Manual input is inspectable but excluded from model context.
- Queued input is handled after the active run.
- Interrupt cancels active run and persists only the fresh assistant output.
- Compaction keeps old items inspectable and future prompts use projection plus newer transcript.
- Provider encodings attach only to selected matching items.
- OpenAI adapter stores and reuses per-item output item encodings without text matching.
- OpenAI adapter rejects function calls and enforces terminal completed streams.
- Tests use explicit timeouts for scheduler and async model cases.
