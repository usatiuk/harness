# Configuration and interface subsystem

## Status

Harness ships one Node CLI and Ink TUI over `HarnessService`. Configuration is a
validated cascade resolved per conversation; the TUI owns presentation and user
interaction but no agent-loop or durable conversation semantics.

## Configuration

The settings document contains kernel model/instruction/tool fields, opaque
plugin slices, optional named profiles, and credential-store selection. Top-level
and plugin keys are validated strictly; typos and unknown configured plugins fail
with their source layer.

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
layer and may also update global defaults. A loaded execution backend remains
cached until process restart even when its settings change.

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

## Session lifecycle

The CLI can create a conversation, resume by id, or open the resume picker. A new
conversation records its canonical workspace root and resolved overrides. Empty
conversations created by the current process are removed on exit; non-empty
history remains durable.

Switching sessions prompts when the current conversation has tracked background
activities and stops its live subagent tree before leaving. An ordinary active
turn is not counted by that prompt and may continue after the TUI switches away.
Process shutdown terminates tracked activities and subagents but does not stop
Docker containers; use the explicit sandbox stop command. Idle teardown applies
only while the owning Harness process remains alive. Resuming rebuilds the
transcript from the active item chain and usage rows, then prepares the
conversation's execution service.

## TUI model

The TUI reduces typed events plus a durable resume seed into presentation cells.
It renders:

- Streaming/final assistant Markdown and optional verbose reasoning.
- Tool calls, arguments, result summaries, approval progress, and full verbose
  output.
- Context markers and compaction markers; verbose mode renders the complete
  persisted fold summary.
- Turn failures with nested provider error causes.
- Background activity state, pending input, sandbox progress, usage, cost, and
  context fill.

Finalized cells move into Ink static scrollback; the mutable frame holds only live
work. Toggling verbose mode clears/reprints the static transcript so expanded
reasoning/tool/compaction content is coherent rather than layered over prior
output.

The composer provides multiline input, cross-session history, command completion,
model/effort selection, delivery intents, approval prompts, and overlays for
resume, activities, models, and sandbox configuration. `!command` uses the same
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
- Session switching stops live subagent descendants; process shutdown also stops
  tracked activities.
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
composer/history/completion, transcript reduction/rendering, overlays, streaming
scrollback, and CLI composition. Platform-specific credential tests run only on
their supported systems.
