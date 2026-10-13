# Kernel subsystem

## Status

The kernel is a provider- and tool-neutral conversation engine implemented by
`@harness/protocol`, `@harness/core`, and `@harness/service`. One `Engine` may
drive several loaded conversation runtimes, while each conversation has at most
one active turn and one ordered inbox. The TUI shows one conversation while the
public client connection may own several active root trees. Clients reach the
server through the JSON-RPC boundary.

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
3. Display ephemeral text/reasoning previews and append explicitly finalized
   messages, reasoning, local calls and provider activity hints in emission order.
4. Pair every accepted tool call with exactly one result, including interrupted
   calls, then append any middleware-staged context after the whole result batch.
5. Pull `steer` input at the after-tool-result boundary and continue.
6. Record the terminal invocation and its reported or explicitly unknown usage;
   dispatch valid calls or fail a terminal-error outcome, then finish the turn and
   drain queued work.

`interrupt` aborts the active provider stream and tools. Partial model output is
kept, every persisted call remains paired, and non-empty interrupt content seeds
the next turn. A failure ends only its turn; it does not stop the process or
strand later inbox work.

`whenIdle` waits for conversation quiescence: no active drain and no queued
inbox work. It is not merely a promise for the turn that happened to be active
when the caller started waiting.

The loop bounds one turn to 100 model steps. A provider stream must terminate
with a `completed` event. Its usage is normalized tokens or `null`; a terminal
error is recorded before the turn fails and never dispatches provider-invalid
calls.

Further normalized events after completion fail the invocation without overwriting
its first accounting or dispatching recorded calls.

Assistant phases are presentation metadata. Provider activity hints are durable
display text only; they never enter model context or control the loop. Finalized
native protocol history remains opaque provider metadata on ordinary items.
Hosted search has no kernel resumption state or extra loop. Only local tool calls
control continuation.

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
Their `active()` capability returns the compacted active branch by default;
`active({includeCompacted: true})` includes earlier items on that branch. Request
owners choose any additional selection, including auto-approval's bounded evidence.

Generic request options may specify a positive finite `timeoutMs`, bounded by
Node's timer range. The pending-request owner starts the timer after request
middleware, clears it on answer/cancellation, and settles expiry once with
`InteractionTimeoutError` plus the ordinary resolution event. RPC clients only
project and answer requests; detachment does not own the timer.

## Tool modes and programmatic execution

The host resolves one scoped catalog per turn, then applies contract resolvers
before either provider declarations or discovery. A contract is the public tool
description and input schema, plus its output schema when known. Resolvers enrich schemas
or withhold a tool; activity background options and subagent catalogs use this
shared path. Tool identity and direct/code exposure remain host-owned. Exposure
is presentation and entry-point eligibility; the conversation allowlist still
defines authority. Omitted exposure means both interfaces.

Function inputs can supply Zod or an already-authored JSON Schema with a parser.
Core preserves the advertised JSON Schema and invokes its parser at the ordinary
argument boundary, so external tool adapters do not need lossy schema conversion.

The shared server defaults `tools.mode` to `hybrid`; explicit settings win. The
bare engine retains `direct` when no mode is supplied. `hybrid` offers essential
direct-enabled tools and the core `eval` entry point; other tools use discovery
and eval. `direct` still offers all direct-enabled tools. The ordinary core
`tool_search` and `tool_describe` tools are
immediately available in every mode. `code-only` runs capabilities through `eval`
and rejects guessed ordinary direct calls, including after discovery. Deferred
tools have code exposure only. The evaluator itself is
direct-only and cannot recurse. Enabling code mode without an injected evaluator
fails explicitly. The server injects `@harness/code-mode`; core imports only its
protocol contract.

Workspace tools mark themselves `essential`: the agent needs them for basic work
without discovery. In code-only, their scoped resolved contracts are included
inside eval's instructions and remain unavailable as direct calls. Hybrid declares
them normally, without repeating contracts inside eval. Rebuilding request context
after compaction preserves this upfront information. Context sources receive only
currently scoped callable tool names; MCP owns the short available-server hint.
Core contains no MCP server registry or search filter.

Search takes `queries`, one to eight keyword strings of at most 512 characters.
Words within each query are ANDed; queries are ORed. There are at most 32 terms
across queries. Blank/punctuation-only queries fail instead of browsing the catalog.

Search excludes initially declared names and paired successful discovery results
in the context since the latest compaction. Rewind and reload derive the set from
the active branch. Describe always returns the current full definition, including
output information and changed plugin enrichment. There is no separate loaded-tool
registry or promotion into direct calls. Search filters known names before ranking
and packs up to twelve complete definitions under 64 KiB; oversized names are
reported without being marked known. Describe of an oversized definition fails
explicitly. These reserved metadata-only operations use core parsing, cancellation
and recording with their own complete-output budget, outside plugin execution,
approval and generic output-cropping middleware. They cannot execute capabilities
and are not callable from guest code; the guest exposes only `tools.call`.

Nested operations receive host-generated ids and `parentCallId`, then pass through
ordinary validation, middleware, approval, execution, output handling, events, and
canonical call/result recording. A result is persisted before guest code receives
it. The main model sees outer source and selected output; reviewers and clients
retain canonical descendants. Mandatory cancellation admission is checked at the
terminal execution boundary after middleware returns.

JavaScript controls child ordering: sequential `await` orders calls; concurrent
submissions overlap through the same governed invocation path. Direct model batches
retain their sequential loop. Body completion cancels unawaited work;
descendants are paired before the outer result. Evaluator cancellation awaits
worker termination and preserves emitted output. No heaps, cells, workflow
resumption, rollback, or automatic script replay are persisted.

## State and ownership

Per-conversation `Runtime` state is intentionally process-local and discardable:
inbox entries, turn liveness, abort controller, pending requests, and lazily built
plugin services. Durable conversation truth belongs to the store. Runtime
services are reused within their runtime and disposed in reverse provider order
when that root tree is deactivated. Closing/reloading one root preserves other
roots. Services can react to persisted inputs through `onInput`, using the
captured conversation and model capability. Session cancellation calls their
optional `cancel` hook; services own background work and drain it in `dispose`.
Model requests use the turn's captured configuration; plugin configuration
readers may observe the current effective policy. Model selection is pinned in
durable overrides by HarnessService.

Plugin emission, delivery, requests, and service creation are bound to the Runtime
that supplied their context. Old callbacks cannot act on a replacement activation
of the same durable conversation. Cached services remain available during their
own teardown; constructing new services requires an active runtime.

`HarnessService` owns configuration resolution and presents the client API for
conversation creation/load, conversation-tree deactivation, delivery, responses, rewind,
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
