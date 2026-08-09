# Configuration and interface subsystem

## Status

Harness ships one Node CLI and Ink TUI over `HarnessService`. Configuration is a
validated cascade resolved per conversation; the TUI owns presentation and user
interaction but no agent-loop or durable conversation semantics.

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

Conversation records persist workspace root and overrides. Resolved configuration
is derived again on load. Model and plugin changes update the conversation's top
layer and may also update global defaults. Sandbox changes deactivate and reload
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

The CLI can create a conversation, resume by id, reload the current id, or open
the resume picker. It owns exactly one active top-level conversation plus that
conversation's subagent runtimes. A new conversation records its canonical
workspace root and resolved overrides. Empty conversations created by the current
process are removed on exit; non-empty history remains durable.

A running or queued root turn blocks switching and reload without changing any
state. When the root is idle but its runtime family has background work, the TUI
confirms before proceeding. An accepted transition closes the whole family to
new input, aborts descendants, discards queued work, awaits settlement, disposes
activities and execution resources, clears ephemeral registries, and only then
loads the target. Docker containers are stopped and removed. Same-id reload uses
an activation generation to rebuild the transcript, resolved config,
instructions, and services. Process exit uses the same cleanup with forced root
cancellation.

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

`HarnessService` and the typed event stream are the reusable client boundary.
Another client should create/load conversations, deliver input, answer requests,
read durable items/usage, and subscribe to events through that façade. It should
not import engine runtime state or duplicate transcript legality rules.

There is no web, desktop, daemon, ACP, or remote-control surface. Diagnostic
support export and stronger service-boundary evidence should precede another
client.

## Accepted invariants

- Configuration is validated at the source boundary and resolved, not stored as
  a second canonical copy.
- The TUI renders canonical items/events and never decides agent control flow.
- A configured provider/backend failure is visible; fallbacks are explicit
  product choices, not silent recovery.
- Session switching/reload never overlaps two top-level runtime families and
  disposes all ephemeral work/resources owned by the previous activation.
- Terminal scrollback remains usable during long streaming output.

## Source map

- `packages/config`: settings schema, merge, discovery, resolution, and writes.
- `packages/cli`: composition root, auth commands, session lifecycle, TUI, and
  transcript reducer.
- `packages/service`: reusable client façade and event subscription.
- `packages/auth`, `packages/secrets`: login methods and credential stores.

## Verification

Tests cover settings precedence/validation/writes, auth registry and screens,
credential backend selection, session creation/resume/switching, commands,
composer/history/completion, transcript reduction/grouping/rendering, compact and
verbose edit patches, overlays, streaming/static scrollback, and CLI composition.
Platform-specific credential tests run only on their supported systems.
