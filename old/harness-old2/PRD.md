# Harness PRD

## Purpose

Harness is a local-first conversation runtime. V0 is intentionally small: durable conversations, model providers, context inspection, compaction, profiles, SQLite storage, and a CLI/TUI shell.

V0 does not include tools, plugins, activities, approvals, subagents, MCP, sandbox execution, output redirection, or output transforms. Those should be added only after the conversation layer is stable.

## Core Principles

- One conversation has one ordered `conversation_items` log.
- Conversation items are immutable canonical truth.
- Run state is not conversation content. It lives in `agent_runs`.
- The model sees only items selected by a recorded `context_build`.
- Queued input is ephemeral v0 state. It gets no sequence until promoted into a real user message.
- Compaction is a conversation item because it is future model context.
- `model_error` is a conversation item because users need ordered failure context.
- Provider-native payloads are optional wire-fidelity for exact selected items, not memory and not a parallel transcript.

## V0 Scope

Harness supports:

- profiles with model config and prompt fragments;
- projectless conversations;
- typed `conversation_items`;
- one non-reentrant model pump per conversation;
- fake model provider, OpenAI Responses provider, and ChatGPT/Codex-backed OpenAI provider;
- final assistant message persistence;
- typed provider response identity;
- per-item `provider_payloads`;
- typed model accounting for usage and future cost estimates;
- `context_builds` for inspecting prompt selection;
- deterministic compaction with sequence cursors;
- input delivery: `send`, ephemeral `queue`, and `interrupt`;
- SQLite and in-memory stores;
- CLI commands for profiles, auth, conversations, items, runs, context, and compaction;
- a minimal readline TUI.

## Conversation Items

Current item types:

- `message`: canonical `system | user | assistant` content with `complete | interrupted` status.
- `model_change`: explicit future context marker when model config changes.
- `compaction`: summary content plus `coversThroughItemSequence`.
- `model_error`: ordered error context for a failed model run.

There are no audit notes, run lifecycle events, manual notes, queued-input items, or UI-only control items in the v0 conversation log.

## Runtime

Sending input requests the pump. The pump:

1. creates one active `agent_run` if none exists;
2. builds context from prompt fragments, latest compaction, and uncovered messages;
3. attaches matching provider payloads for selected items;
4. streams the selected model provider;
5. commits assistant message, provider payload, provider response identity, accounting, and run completion transactionally;
6. promotes any queued input after the active assistant message and continues.

If a model stream or commit fails, Harness persists no partial assistant message. It appends a `model_error` item and marks the run failed.

## Input Delivery

- `send`: if idle, append a user message and run; if active, behaves like `queue`.
- `queue`: while active, store ephemeral pending input; after the active assistant response, promote it to a user message and run.
- `interrupt`: cancel the active run, abandon that run's selected unresponded input, clear pending queued input, append the new user message, and start a fresh run.

There is no current-run injection in v0.

## Model Providers

Core defines a `ModelProvider` interface:

- `provider`: stable provider id.
- `capabilities()`: supported input/output content types and provider-payload support.
- `validateModelConfig(config)`.
- `stream(request)`: emits `text_delta` events and exactly one `completed` event.

`ModelRequest` contains instructions, selected context items, model config, and optional provider payloads for those selected items.

Harness v0 has no tool protocol. If a provider returns tool/function calls, that provider must fail the stream explicitly; core must not persist an assistant message for that run.

## Provider Payloads

`provider_payloads` are stored per canonical item:

- conversation id;
- item id and sequence;
- provider;
- model id;
- payload `type`;
- payload `version`;
- provider-native JSON payload.

A payload is usable only when the canonical item is selected into the current context build and the provider/model/type/version match what the provider implementation understands. If the model/provider changes, the selected item renders from canonical content instead.

For OpenAI Responses, the payload type is `responses.output_items`. It preserves assistant output items, including encrypted reasoning, without text matching.

Provider response identity, such as request id and response id, is response provenance on the run, not an audit event stream.

## Non-Goals For V0

Do not implement yet:

- tool calls or tool results;
- plugin host or capability registry;
- activities or waits;
- approvals/interactions;
- subagents;
- MCP;
- sandbox execution;
- output peek/follow/redirection/transforms;
- durable raw output chunks;
- old Harness DB compatibility.

## Future Roadmap

Future work should ship in phases. Every phase must preserve the v0 invariants: one canonical item log, explicit context builds, bounded compaction, exact per-item provider payloads, and a non-recursive pump.

1. Recovery hardening
   Reconcile stale `running` runs after restart, including interrupted input and pending queued input. Recovery must fail or resume from an explicit durable boundary.

2. Multimodal providers
   Add provider renderers for image/file content across OpenAI, Anthropic, Google Gemini, and local providers. Unsupported blocks must fail clearly instead of being stringified.

3. Tool execution core
   Add assistant tool-call items, `tool_executions`, and tool-result obligations. Every assistant tool call must eventually have exactly one tool result.

4. Plugin host
   Add plugins for tools, policy hooks, context contributors, durable plugin state, and named capabilities. Plugins own domain behavior; core owns ordering, contracts, and prompt legality.

5. Approval and steering
   Implement approvals as transactional tool gates. Add steering only at legal model/tool boundaries; never inject user input between a tool call and its required result.

6. Activities and output
   Add activity and output plugins for long-running work, status, cancellation, output preview/follow, redaction, transforms, and explicit file redirection. Raw output chunks are not conversation history.

7. Execution, bash, and subagents
   Build bash and subagents as plugins on top of tools, activities, output, and child conversations. Parent prompts must not accidentally absorb child transcripts.

8. MCP, tasks, and richer UI
   Add MCP, elicitation, task workflows, and richer TUI/web/daemon surfaces as plugin-backed features.

## Acceptance Criteria

- `harness` installs, lints, typechecks, tests, and builds.
- Simple fake-model conversation creates ordered user and assistant messages.
- Failed model call persists no partial assistant message and appends `model_error`.
- Queued input is not persisted until promoted after the active assistant message.
- Interrupt cancels the active run and persists only fresh output.
- Compaction keeps old items inspectable and future prompts use compaction plus newer messages.
- Provider payloads attach only to selected matching items.
- OpenAI stores/reuses per-item output item payloads and rejects function calls.
- Tests cover async scheduler behavior with explicit timeouts.
