# Configuration and interface subsystem

## Status

Harness ships one headless runtime and an Ink TUI over a language-neutral
JSON-RPC client boundary. They may share a process or communicate over bounded
NDJSON stdio, directly or through SSH. Configuration is a validated cascade
resolved by the server; clients own presentation and user interaction but no
agent-loop or durable conversation semantics.

## Configuration

The settings document contains kernel model/instruction/tool fields, opaque
plugin slices, optional named profiles, and credential-store selection. Top-level
plugin keys, and custom provider/model entries are validated strictly; typos and
unknown configured plugins fail with their source layer.

The resolution order is:

```text
service defaults
< global ~/.harness/settings.json
< project <root>/.harness/settings.json
< local <root>/.harness/settings.local.json
< selected profile
< durable conversation overrides
```

The project root is the nearest `.harness` directory, then Git root, then starting
directory, while the Harness home itself is never treated as a project. Shared and
local project settings remain separate layers. Plugin definitions contribute
their own Zod schemas and defaults; core configuration code treats their values as
opaque after central validation.

Conversation records persist workspace root and overrides. The complete model
and preset selection is pinned there at creation and survives resume/reload.
Legacy records without a selection are pinned once on first activation using
the current cascade. Explicit model/preset changes update that conversation and
the global default for new conversations; other existing pinned conversations
keep their selection. Other settings retain the cascade, including intentionally
global approval policy. Configuration mutations are serialized by the service;
settings writers coordinate by canonical file path and atomically replace files.
Sandbox changes deactivate and reload
the current conversation so its execution backend is rebuilt immediately.
Every complete `{provider, model, preset?}` selection is atomic wherever it
appears in the configuration tree, including named profiles and plugin-owned
reviewer models. Identity changes use a model-only API that clears the old
preset; preset changes use a separate API scoped to the current identity.

Named profiles exist in the resolver/schema, but the current CLI does not expose a
profile-selection workflow.

## Authentication UX

The auth registry discovers provider login methods and builds plugins only when
credentials are available. `harness auth login` supports API-key methods and Codex
OAuth. Provider build failures are reported and skipped; Harness never silently
uses a different configured provider. Without credentials/configuration the CLI
uses a deterministic demo provider and explains how to sign in.

Credential-store selection is pinned in global settings. Unsupported Windows
file/keyring combinations fail and direct the user to DPAPI rather than falling
back to plaintext.

Config-defined providers are the explicit exception: their pre-release schema
requires an inline key literal in global settings (or a dummy value for a keyless
server). That path does not use the auth registry or secure store.

## Session lifecycle

The client can create, attach, resume, reload, close, or list conversations. One
connection may keep multiple root scopes active while the TUI
shows one. A new conversation records its server-side workspace root and resolved
overrides. Empty conversations created by the client are removed on exit;
non-empty history remains durable.

Switching visible roots does not stop either conversation tree. A same-root reload is blocked
by a running turn and confirmed when background activities exist; acceptance
closes only that root and its descendants, aborts pending work, disposes its
plugin services, then attaches a fresh activation. Connection close force-closes
all of its root scopes and server-owned processes. Other roots are unaffected by
closing or reloading one root.

`conversation.detached` reports that an activation is gone even when cleanup or
replacement fails. Clients discard its buffered events and plugin caches;
failure before teardown preserves the attachment. Attachment config comes from
the live runtime alongside fresh durable history/head state.

The service/protocol supports independent simultaneous roots. Parallel TUI
presentation is outside the current product scope; the existing screen shows one
conversation. Shared Docker controls surface their warning in that screen.

## TUI model

The TUI reduces typed events plus a durable resume seed into presentation cells.
It renders:

- Streaming/final assistant Markdown and chronological semantic stages. Compact
  mode groups consecutive unapproved reads/searches under a stable `Explored`
  tree; narration or any other action starts a new stage. Streamed reasoning
  settles as a timed `Thought` when timing was observed. Verbose mode retains raw
  reasoning and tool detail.
- Tool calls, arguments, result summaries, and approval progress. Failures,
  approved calls, edits, and unfamiliar/plugin tools remain visible in compact
  mode.
- Dedicated edit cards for Harness file-mutation dialects, with bounded colored
  patches in compact mode and the complete available patch in verbose mode.
- Context markers and compaction markers; verbose mode renders the complete
  persisted fold summary.
- Turn failures with nested provider error causes.
- One bottom-of-transcript `Working…` footer for the running turn. A terminal
  event replaces it with a session-local `Worked for …` row; reload/resume does
  not reconstruct historical work footers.
- Background activity state, pending input, sandbox progress, usage, cost, and
  context fill. If any completed invocation omitted accounting, totals are marked
  incomplete and no stale request is shown as the latest context checkpoint.

Visible conversation blocks are separated by one blank line. The maximal
finalized prefix advances into Ink static scrollback immediately; the suffix from
the first mutable entry stays live. Oversized live output clips from the top so
the work footer and input controls remain at the bottom. Toggling verbose mode
clears/reprints the static transcript so expanded reasoning/tool/compaction
content is coherent rather than layered over prior output.

The composer provides multiline input, cross-session history, command completion,
model/preset selection, delivery intents, approval prompts, and overlays for
resume/reload, activities, models, and sandbox configuration. `!command` uses the same
prepared execution backend as model-issued commands.

## Client boundary

The reusable boundary is the [v1 bidirectional JSON-RPC protocol](../../protocol/client-v1.md),
authored as strict Zod schemas with committed JSON Schema for non-TypeScript
clients. `@harness/client` coordinates initialization, attachment, bounded
history, and presentation-domain conversion. `@harness/service` owns dispatch
and connection-owned root-scope lifetime.

Attachment returns a bounded snapshot, then ordered semantic notifications;
history is fetched independently through anchored byte-bounded pages. Plugins use
ordinary namespaced requests/notifications and optional bounded snapshots. The
TUI receives no service, runtime, process, activity-manager, sandbox, or raw
plugin-state object. Web/mobile/IDE clients and reconnecting daemons remain
unimplemented rather than simulated.

## Accepted invariants

- Configuration is validated at the source boundary and resolved, not stored as
  a second canonical copy.
- The TUI renders canonical items/events and never decides agent control flow.
- A configured provider/backend failure is visible; fallbacks are explicit
  product choices, not silent recovery.
- Closing/reloading one root never interrupts another attached conversation tree.
- Every transport uses the same validation, correlation, cancellation,
  attachment, and plugin messages; stdout in server mode is protocol-only.
- Terminal scrollback remains usable during long streaming output.

## Source map

- `packages/config`: settings schema, merge, discovery, resolution, and writes.
- `packages/cli`: composition root, auth commands, session lifecycle, TUI, and
  transcript reducer.
- `packages/client`: transport-neutral peer, client coordinator, domain helper,
  in-process transport, and Node NDJSON transport.
- `packages/service`: server dispatch and connection-scoped runtime ownership.
- `packages/auth`, `packages/secrets`: login methods and credential stores.

## Verification

Tests cover settings precedence/validation/writes, auth registry and screens,
credential backend selection, session creation/resume/switching, commands,
composer/history/completion, transcript reduction/grouping/rendering, compact and
verbose edit patches, overlays, streaming/static scrollback, and CLI composition.
Protocol tests additionally cover both request directions, cancellation and
closure, bounded history/item ranges, multi-root isolation, plugin controls,
remote approval, and NDJSON framing/backpressure. Platform-specific credential
tests run only on their supported systems.
