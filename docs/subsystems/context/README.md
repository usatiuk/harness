# Context and compaction subsystem

## Status

The active branch supplies one ordered list of model input. Its opening items contain the base system prompt, workspace, and initial project instructions. Subsequent turns append items to that window.

## Context assembly

1. Select the active lineage from the latest compaction's `windowStart`, or from the root.
2. Project model-visible items, attaching their provider-owned replay payloads. Display hints, plugin data, and nested execution details stay in the log.
3. Attach the scoped tool schemas and record the ordered selection before invoking the adapter.

Titles, approval reviews, and compaction use the same model interface. Their inline messages belong to the recorded invocation. SQLite stores canonical agent items by reference and auxiliary input by value.

Safe provider-owned request options are copied onto the request and recorded
with its existing context build. Model changes use the next turn's snapshot;
adapters omit foreign reasoning and render canonical text when native metadata
does not match. Required finalized native history remains adapter-owned metadata,
not a second conversation log or hosted-search continuation state.

## Programmatic context projection

Code-mode descendants stay in canonical history but are omitted from the main
agent and compactor windows. Outer source and explicitly selected output remain
ordinary tool pairs; structured payloads and full-output references are not
automatically sent. Opaque provider payloads are attached to selected items as
before. Auto-approval owns its projection of the same active chain:
ordinary current-window context, the most recent sixteen nested calls, and up to
sixteen failed nested call/result pairs across the active chain. This bound is
independent of main compaction. Caught failures remain inspectable after main
compaction. Rewind removes abandoned evidence naturally. Auto-approval bounds
arguments and results, correlates ids/parents, and reads bounded head/tail
previews of spilled structured data without duplicating durable state. Generic
request middleware receives compacted history by default; auto-approval explicitly
requests the whole active branch before selecting its bounded evidence.

## Global and hierarchical project instructions

The agents plugin reads the server home's AGENTS.md and the workspace's ancestor chain on a new window and before later turns. Each addition or edit appends a labeled context item and a model-hidden plugin data item containing the source path and content digest. Deletions append a removal notice. The plugin folds its own records from the active branch to determine what has already been supplied.

After a batch of validated, executed file tools, the plugin reconciles the targeted directories once. Confined paths remain inside the workspace after realpath resolution. Symlinked instruction files are skipped. A workspace switch retires files outside the new scope. A fork or rewind inherits the records in its ancestry.

Compaction rereads initial files and resets nested discovery. Plugins that retain state return data from `onCompact`; the engine appends those records after the summary in the same transaction. Reopening an existing window preserves its earlier input prefix.

V1 does not parse arbitrary shell commands, watch instruction files for changes,
or discover instruction trees that exist only inside a container.

## Compaction model

Ordinary tool search deduplicates against initially declared tools and successful
root search/describe result annotations after the latest active-branch compaction.
Only definitions actually delivered are annotated. A fold resets that discovered
set; rewind/reload restore the selected branch's current window. Explicit describe
remains repeatable and returns the current full definition. Discovery does not
change permissions or direct-call eligibility.

A compaction fold is an immutable item whose content represents the entire active
window before it. Model context begins at the fresh system item identified by the latest fold and includes its opening context, the summary, and subsequent items. Earlier items remain in the raw conversation graph and transcript lineage;
the fold changes model selection, not history.

The shipped model strategy supports:

- **Manual compaction:** one standalone summary-only call. Tools remain in the
  request for cache shape, but tool choice is disabled and emitted tool calls are
  rejected. Adapters forward `toolChoice: "none"` to the provider's native API.
- **Threshold compaction:** runs before an agent request when estimated input
  reaches the effective global threshold.
- **Overflow recovery:** one context-overflow path may compact and retry the agent
  request once.

Automatic compaction may emit tool calls after producing a complete summary; the
fold is appended first and calls then continue through ordinary dispatch. Manual
compaction never continues the task.

Display-only search hints are omitted from model and deterministic summaries.

Global `compaction.thresholdTokens` accepts a positive integer input-token count;
unset means automatic. The usable input limit is the smaller known bound from
`maxInputTokens` and `contextWindow - outputBudget`. Either bound alone is
sufficient; separate input/output limits do not imply a combined context window.
The output budget is the advertised output maximum, reduced by the global
`outputTokenCeiling` (128,000 by default) when the transport supports request caps.
With an input limit and an output budget, the automatic threshold is
`max(0, inputLimit - outputBudget - ceil(0.02 * inputLimit))`, reserving the
answer's capacity in the next input plus a fixed 2% estimation cushion. A zero
allowance triggers as early as possible rather than silently disabling compaction.
An explicit threshold can trigger earlier and remains usable with any missing
capacity metadata. Without either an explicit threshold or enough metadata for
automatic calculation, proactive compaction is unavailable.

When the ceiling reduces the advertised maximum, the engine also sends it on
agent and compaction requests. A known combined window can further reduce the
compaction allowance, using the same 2% cushion. Providers can apply a smaller
request default or preset.

Desktop Settings and TUI selected-host defaults expose the same nullable scalar
through `app.settings`. Clearing it removes the global setting. It cannot be set
by projects, profiles, or conversation overrides. New conversations resolve it
immediately; restart the server to apply changes to already-loaded conversations.
No compaction strategy interface or live-refresh machinery is added.

Capacity uses the latest compatible single-prompt usage checkpoint plus a local
estimate for appended items. Stable instructions, tools and provider options must
match. Cumulative hosted-search billing input cannot serve as a checkpoint; the
existing request estimate applies when no eligible checkpoint exists.
A reduced per-request compaction limit is advisory where the provider
transport cannot enforce it. The fixed 2% input cushion helps avoid waiting until the model
has no room left to summarize; local estimates and unusually large tool results
can still require the existing overflow recovery.

If automatic model compaction cannot run because context capacity is exhausted,
the engine appends a bounded deterministic fallback containing recent canonical
content. Other compaction failures are surfaced; they are not blindly retried.
An empty summary error includes the number of returned tool calls, without
exposing response text or tool arguments. The automatic prompt requires a complete
visible summary before any optional continuation tool calls; tool-only or
reasoning-only output is not a summary. No extra logger or retry is introduced.

## Cache and state invariants

- Stable instructions and tools do not change during ordinary turns merely to
  carry volatile diagnostics or nested project context.
- Context items are append-only and ordered after complete tool-result batches.
- One fold covers its complete preceding active window; the model never receives
  both that covered prefix and a separately retained copy.
- Compaction is materialized once and never re-derived during context assembly.
- Provider payloads remain attached only to selected original items.
- Manual compaction is summary-only; automatic compaction owns its single
  continuation path.

## Source map

- `packages/core/src/engine.ts`, `policies.ts`: assembly, capacity, folds, and
  model compaction.
- `packages/agents`: hierarchical project instruction source/middleware.
- `packages/protocol/src/items.ts`, `policies.ts`: canonical context and
  compaction contracts.
- `packages/store*`: durable context builds, folds, payloads, and active lineage.

## Verification

Engine regressions cover manual/threshold/overflow paths, output allowance,
fallback, tool continuation, cancellation, rewind, context-build evidence, and
one-attempt overflow recovery. Agents tests cover hierarchy, realpaths, ordering,
deduplication, batch adjacency, cancellation, resume, compaction, and subagents.
TUI tests cover compact markers and verbose fold content.
