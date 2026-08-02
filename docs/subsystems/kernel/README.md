# Kernel subsystem

## Status

The kernel is a provider- and tool-neutral conversation engine implemented by
`@harness/protocol`, `@harness/core`, and `@harness/service`. One `Engine` may
drive several loaded conversation runtimes, while each conversation has at most
one active turn and one ordered inbox. The production TUI limits that loaded set
to one top-level conversation plus its concurrent descendants and reaches it only
through `HarnessService`.

The kernel does not import providers, workspace tools, sandboxes, approval,
activities, agents, or subagents. Those capabilities enter through plugins.

## Responsibilities

- Define canonical conversation, item, model, tool, store, event, delivery,
  request, policy, runner, and plugin contracts.
- Accept input using `send`, `queue`, `steer`, or `interrupt` and map those
  intents onto one per-conversation inbox.
- Run model steps, persist emitted items in order, dispatch tool-call batches,
  and continue until the model completes without calls.
- Compose tool, model, and request middleware around their terminal handlers.
- Resolve per-turn tool rosters from model capabilities and conversation scopes.
- Expose typed events and a service façade without placing control state in the
  UI.
- Reconcile stale persisted turns when a conversation is loaded after a crash.

## Turn and delivery model

`deliver` acknowledges acceptance rather than turn completion. A detached drain
loop owns the conversation until its inbox is empty. Work already waiting in the
inbox is drained as one batch into a single turn; later `queue` input waits for
the next turn, while `steer` is the only delivery intent that may be pulled into
the active turn at an after-tool-result boundary.

Each turn then:

1. Resolve a turn-boundary snapshot of conversation configuration and tools.
2. Assemble and record the model context.
3. Stream reasoning, assistant text, and tool calls in provider emission order.
4. Pair every accepted tool call with exactly one result, including interrupted
   calls, then append any middleware-staged context after the whole result batch.
5. Pull `steer` input at the after-tool-result boundary and continue.
6. Record completed model usage, finish the turn, and drain queued work.

`interrupt` aborts the active provider stream and tools. Partial model output is
kept, every persisted call remains paired, and non-empty interrupt content seeds
the next turn. A failure ends only its turn; it does not stop the process or
strand later inbox work.

`whenIdle` waits for conversation quiescence: no active drain and no queued
inbox work. It is not merely a promise for the turn that happened to be active
when the caller started waiting.

The loop bounds one turn to 100 model steps. A provider stream must terminate
with a `completed` event before its usage can be recorded.

## Plugin surface

`PluginHost` accepts:

- Model providers and capability-dependent tool contributors.
- Ordered tool, model, and request middleware.
- Cache-stable context sources.
- Per-conversation services exposed through `ctx.service(key)`.
- One compaction policy contribution.
- Read-only observers and typed plugin events.

Duplicate plugin ids and service keys fail fast. Tool-middleware ordering
dependencies must name a contributor already registered outside the dependent
plugin. Multiple compaction policies are rejected because no composition rule is
currently implemented.

Tool middleware owns execution-time transformation, approval, output handling,
and context staging. Model middleware sees every model call, including agent,
compaction, subagent, and auto-approval calls. Request middleware wraps correlated
host interactions such as approval and may short-circuit before the UI transport.

## State and ownership

Per-conversation `Runtime` state is intentionally process-local and discardable:
inbox entries, turn liveness, abort controller, pending requests, and lazily built
plugin services. Durable conversation truth belongs to the store. Runtime
services are shared while loaded and optionally disposed in reverse provider
order when the loaded set is deactivated. The production TUI performs that
deactivation on switch/reload, so none of its conversation-local service
instances survive. A running turn holds a configuration snapshot; ordinary
model/plugin changes apply at the next turn boundary.

`HarnessService` owns configuration resolution and presents the client API for
conversation creation/load, family deactivation, delivery, responses, rewind,
compaction, models, usage, events, plugin state, and per-conversation services.
It contains no agent control loop of its own.

## Accepted invariants

- Kernel packages remain independent of provider and execution implementations.
- Every persisted tool call has exactly one result before an aborted turn exits.
- Cancellation propagates to model, tool, request, compaction, and subagent
  boundaries without erasing canonical output already observed.
- Middleware cannot call `next` twice unless its contract explicitly permits it;
  model retries may only re-enter before yielding output.
- Plugin output becomes typed items/events or opaque plugin state, never hidden
  mutation of engine control state.
- Clients render events and durable state; they do not decide turn semantics.

## Source map

- `packages/protocol`: public contracts and validation helpers.
- `packages/core`: engine, middleware composition, plugin host, delivery,
  reconciliation, and built-in policies.
- `packages/service`: configuration-aware client façade and runner interface.
- `packages/testkit`: deterministic providers, tools, and shared contracts.

## Verification

Engine tests cover delivery intents, cancellation, tool ordering, parallel calls,
middleware composition, requests, rewind, compaction, context building, model
switching, usage, and reconciliation. Service tests cover configuration-aware
creation/load and event-facing behavior. Full validation is `npm run check`.
