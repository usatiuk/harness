# Transport-agnostic client/server boundary

**Status:** Complete

## Outcome

Harness has one headless runtime and interchangeable clients. The Ink TUI uses
the same language-neutral protocol when client and server share a process, when
the server is a local stdio child, and when it runs through SSH. Future web,
mobile, IDE, native, or automation clients can implement the contract without
TypeScript.

The server remains authoritative for conversations, configuration, providers,
tools, approvals, execution, activities, subagents, and persistence. Multiple
root conversations may run concurrently; closing, reloading, or viewing one must
not disturb another. No backwards compatibility is required for the former
private TUI/service boundary.

## Delivered design

### One bidirectional protocol

JSON-RPC 2.0 supplies requests, responses, errors, notifications, correlation,
and cancellation. Both peers may initiate requests. Core methods use
`conversation.*`; plugins use `plugin.<id>.*`. One flat set of typed message
definitions drives validation on both sides. There is no remote object proxy,
generic `extension.invoke`, interaction framework, or transport-specific API.

`initialize` requires exact protocol version `1` and exchanges peer identity plus
supported plugin contract versions. Request IDs follow JSON-RPC and may be
strings or integers; each requester owns its outstanding ID space. Cancellation
uses `$/cancelRequest` and error `-32800`. Errors crossing the boundary are safe
and contain no stack, credential, provider body, or opaque provider payload.

`@harness/protocol` owns neutral DTO schemas, `@harness/client` owns peer/client
coordination and transports, and `@harness/service` owns server dispatch. The
in-process transport JSON-round-trips values so it has no privileged semantics.
The Node transport is bounded NDJSON: 4 MiB frames and an 8 MiB writer queue,
with stdout reserved for protocol frames.

### Authority, attach, and history

Store owns immutable items; Engine owns live turns, accepted input, and request
resolvers; plugin services own their live objects. Clients reduce presentation
state. There is no generic server UI reducer or replay-built authority.

`conversation.attach` owns its root before preparation, then reads bounded store
facts and captures the live core/plugin snapshot without another await. Failure
or shutdown cleans any prepared runtime. No global barrier, engine pause, history
read, or asynchronous plugin hook exists. The client buffers during attach,
applies the snapshot, then releases early notifications. The snapshot and suffix
each have a 2 MiB bound. Runtime-mutating requests require attachment.

History is independent: the first byte-bounded page fixes an immutable head;
later newest-first pages follow parent item IDs. Large items become stable
`itemRef` values and are fetched in frame-safe base64 ranges. Conversation lists
use stable `(createdAt,id)` cursors. The current TUI walks all bounded pages;
future clients may render them incrementally. Usage notifications replace a
constant-size aggregate. Live durable appends use the history item DTO; clients
deduplicate by item ID and reconcile any overlapping transient draft.

### Conversation trees and plugins

The engine records explicit parent/root ownership before a child can load. A
small connection-owned gate admits attached root operations. Close/reload stops
new admission; forced teardown requests cancellation before waiting, then
disposes only that root and its descendants. Connection shutdown cleans every owned root, including
an in-flight attachment.

Plugins use ordinary namespaced messages plus an optional bounded synchronous
attach snapshot of already-created state. Activities, workspace shell, sandbox,
subagent list filtering, and approval now cross this boundary. Shell processes
and activities are server-owned. Approval is a server-to-client request owned by
the connection rather than the visible screen, including approvals from hidden
children. Shell IDs are connection-wide and duplicate active activity IDs fail
fast. An unsupported approval contract fails closed.

Zod is the TypeScript authoring/runtime source. Committed JSON Schema Draft
2020-12 is the cross-language shape contract; normative Markdown owns ordering,
cancellation, attachment, pagination, and lifetime. Wire schemas use only strict
JSON-compatible values—no transforms, dates, bigint, maps, sets, classes,
functions, or `undefined`.

### Process modes and trust

The TUI defaults to an in-process server, `--connect-stdio` spawns a local server,
and `--ssh user@host` spawns:

```text
ssh -T -- user@host harness server --stdio
```

Only a validated destination varies; workspace paths stay in JSON params. The
server uses its host's store, settings, credentials, tools, and execution
environment. This is a trusted OS-account boundary, not an unauthenticated
network service.

## Delivery checklist

### Protocol and core

- [x] Symmetric JSON-RPC peer, initialization, strict validation, safe errors,
      cancellation, closure, and JSON-equivalent in-process transport.
- [x] Root ownership and root-scoped shutdown with two-root isolation.
- [x] Semantic item/state events, bounded store pages and aggregates, stable
      item references/range reads, and client-coordinated attach ordering.
- [x] TUI core/session/history paths moved to the public client boundary.

### Plugins and transports

- [x] Approval, activities, shell, sandbox, and subagent presentation moved to
      named plugin messages and bounded snapshots.
- [x] TUI access to `HarnessService`, runtime services, process handles, raw
      plugin state, and concrete sandbox/activity objects removed.
- [x] Bounded NDJSON server mode, local child mode, fixed SSH launcher, stdout
      purity, EOF cleanup, and signal cleanup implemented.
- [x] Zod-generated JSON Schema, fixtures, and normative protocol documentation
      committed.

### Completion evidence

- [x] Focused protocol, store, engine, service, TUI, plugin, approval, shell, and
      NDJSON tests pass.
- [x] Local `server --stdio` initialize smoke returns one clean protocol frame.
- [x] `npm run check` passes: 86 test files passed, 5 skipped; 793 tests
      passed, 28 skipped.
- [x] Independent architecture, correctness, and simplicity reviews approved.
- [x] SSH boundary recorded: no configured remote host was available; fixed
      launcher argv is unit-tested.

## Non-goals

Persistent daemon/reconnect/replay, exactly-once delivery, multiple-client
arbitration, HTTP/WebSocket/TLS, discovery, auth/tenancy, generated language SDKs,
schema-driven UI, universal plugin UI, remote object proxies, event sourcing, and
a workflow scheduler remain out of scope. A second client should be built from
the published contract rather than anticipated with fake platform layers.
Shipped plugin contract metadata stays explicit; consolidate its few registries
only when another client-visible plugin demonstrates the payoff.
