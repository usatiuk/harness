# Context and compaction subsystem

## Status

Harness builds every model request from resolved instructions, the active
conversation lineage, provider payloads, and the turn-local tool roster. Stable
instructions and tools stay ahead of the changing item tail for provider cache
reuse. Every model invocation records its exact context build and purpose.

Hierarchical project instructions and compaction use canonical conversation items
instead of hidden loaded-state flags or destructive history edits.

## Context assembly

At each agent step the engine:

1. Reads the current head's active item chain.
2. Replaces the prefix before the latest compaction fold with that durable fold.
3. Omits display-only provider activity hints and attaches provider payloads for
   the remaining selected items.
4. Resolves cache-stable conversation and plugin instructions.
5. Uses the mode's declarations from the scoped, contract-enriched tool catalog.
6. Records the resulting context build before invoking the model.

Non-agentic callers use the same model invoker and record a purpose such as
`compaction` or `auto-approval`. A caller may add a non-durable final prompt,
disable tool selection, or request an advisory output cap without changing the
canonical item log.

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

Nested `AGENTS.md` discoveries stage context after the complete outer batch;
they do not interrupt, resume, or inject instructions into a running script.

## Hierarchical project instructions

The standalone agents plugin owns `AGENTS.md` behavior independently of providers
and workspace tools.

For a conversation with a workspace:

- The first context assembly snapshots applicable files from the host filesystem
  root through the workspace root, broadest to most specific.
- The snapshot becomes stable instruction-prefix content for that loaded runtime.
- When a validated structured file tool targets a deeper or explicitly approved
  outside path, tool middleware discovers newly applicable files and stages keyed
  `context` items after the current tool-result batch.
- Keys deduplicate against the initial snapshot, current active lineage, and other
  files staged by the same batch.

Instruction files themselves are not followed through symlinks. Realpath checks
prevent intermediate directory links from escaping a confined workspace unless
the execution relationship already represents an approved outside access.
Approval middleware must be registered outside agents middleware, and plugin-host
ordering validation enforces that dependency.

Loaded state is derived from canonical context items. Rewind therefore restores
the selected branch's loaded set. Compaction removes older nested markers from the
model window; a later structured access reloads the instructions if still needed.
Subagents inherit the workspace root but build their own instruction snapshot and
lazy context.

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
window before it. Model context begins at the latest fold and includes later
items. Earlier items remain in the raw conversation graph and transcript lineage;
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
`maxInputTokens` and `contextWindow - maxOutputTokens`. Either bound alone is
sufficient; separate input/output limits do not imply a combined context window.
With an input limit and output maximum, the automatic threshold is
`max(0, inputLimit - maxOutputTokens - ceil(0.02 * inputLimit))`, reserving the
answer's capacity in the next input plus a fixed 2% estimation cushion. A zero
allowance triggers as early as possible rather than silently disabling compaction.
An explicit threshold can trigger earlier and remains usable with any missing
capacity metadata. Without either an explicit threshold or enough metadata for
automatic calculation, proactive compaction is unavailable.

Compaction's existing output allowance remains capped by known combined-window
capacity and the hard output maximum, using the same 2% cushion. Without both
combined-window and output metadata it remains unspecified. Normal agent request
caps, model defaults, manual/overflow paths and the strategy interface are unchanged.

Desktop Settings and TUI selected-host defaults expose the same nullable scalar
through `app.settings`. Clearing it removes the global setting. It cannot be set
by projects, profiles, or conversation overrides. New conversations resolve it
immediately; restart the server to apply changes to already-loaded conversations.
No compaction strategy interface or live-refresh machinery is added.

Capacity uses the latest compatible single-prompt usage checkpoint plus a local
estimate for appended items. Stable instructions, tools and provider options must
match. Cumulative hosted-search billing input cannot serve as a checkpoint; the
existing request estimate applies when no eligible checkpoint exists.
The provider/model catalog's hard output maximum is
reserved. A reduced per-request compaction limit is advisory where the provider
transport cannot enforce it. The fixed 2% input cushion helps avoid waiting until the model
has no room left to summarize; local estimates and unusually large tool results
can still require the existing overflow recovery.

If automatic model compaction cannot run because context capacity is exhausted,
the engine appends a bounded deterministic fallback containing recent canonical
content. Other compaction failures are surfaced; they are not blindly retried.

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
