# Persistence subsystem

## Status

Harness persists production conversations in SQLite and uses an in-memory store
for deterministic tests. Both implement the same `Store` contract. The durable
model is an append-only item graph with a movable conversation head; resolved
configuration and live runtime state are not stored.

## Durable model

A conversation record stores:

- Its id and creation time.
- A nullable display title, updated independently of immutable history.
- A workspace root, or `null` for a projectless conversation.
- A durable settings-override object.
- `head`, the current leaf item or `null` before the first append.

Appending an item assigns a monotonic conversation sequence, links `parent` to
the current head, and advances head atomically. Rewind moves head to an earlier
item. Continuing afterward appends another child while the abandoned tail remains
in the raw log. `listActiveItems` follows the selected head's ancestry; model
context and TUI resume use that active chain.

Canonical item types are user/assistant messages, reasoning, tool calls, tool
results, display-only provider activity hints, compaction folds, and
plugin-injected context. Assistant messages retain optional phase strings/null.
Items are immutable after append. Streaming deltas stay in memory; finalization
appends once. Graceful interruption preserves partial readable content, while a
hard crash may lose an unfinalized preview.

## Related records

Tool calls and results may carry `parentCallId` linking a computed operation to
its evaluator, independently of the item's graph `parent`. Results retain
optional structured JSON and full-output references; structured JSON above
64 KiB is stored once in the blob store as `structuredRef`. Public RPC preserves
these fields, including a structured scalar `null`. SQLite range reads select
only requested blob bytes. Crash reconciliation pairs dangling descendants with
errors retaining their invocation association; no computation resumes.

- **Turns** record running/completed/failed/aborted status. Runtime liveness stays
  in memory; persisted `running` exists for crash reconciliation only.
- **Provider payloads** preserve provider/model/type/version-bound opaque data
  such as encrypted reasoning and required finalized native search history,
  without contaminating canonical content. Display-only hints have no payload.
- **Context builds** record the exact stable instructions, selected items, tool
  roster, prompt, tool choice, output request, safe provider options and purpose
  for model invocations.
- **Model usage** records provider/model token usage, optional context-build link,
  calculated cost, optional provider billing counts/incomplete-cost flag, context
  checkpoint eligibility, turn
  ownership, optional request purpose and duration. A durable
  `null` usage distinguishes omitted/unobserved accounting from a real zero-token
  report, including interrupted and failed provider attempts. Agent request rows
  are recorded before tool dispatch. Model-backed approval accounting settles
  before terminal publication and activation teardown.
- **Plugin state** gives plugins durable namespaced metadata without widening
  conversation or item schemas.
- **Blobs** preserve complete tool output or binary data behind range-readable
  references.

## SQLite guarantees

The production schema uses foreign keys, one sequence per conversation, one
persisted running turn per conversation, and a partial unique index preventing
duplicate tool results for one call. Appends and head movement are transactional.
Crash reconciliation uses those constraints so repeated load/recovery cannot
create a second result or race a completed turn transition.

The current SQLite format is version 7. Fresh databases receive the complete
schema atomically. Version 3 receives an explicit additive upgrade for nullable
request purpose/duration and indexed latest-agent, terminal-turn and turn-usage
lookups. History and billing totals remain intact; unclassified purpose/timing cannot
establish historical throughput or an agent checkpoint. Versions 3/4 then receive
nullable provider billing JSON and a false incomplete-cost flag. Versions 3/4/5
receive context-checkpoint eligibility; historical billing totals remain intact,
but their unclassified input counts cannot establish prompt size. New ordinary
invocations default to eligible; native-search billing marks them ineligible.
Versions 3–6 also receive a nullable conversation title; existing titles remain
unset and history/accounting stay intact. Other versions and unversioned populated
databases fail with compatible-upgrade
guidance before persistent journal-mode changes. Regression checks compare original
database bytes after rejection under exclusive ownership.

The [release delivery plan](../../plans/cross-cutting/2026-10-10-release-installation-updates.md)
defines preservation from the first public baseline, without compatibility for
private/pre-release installs. Concrete forward migrations and backup/recovery
checks are required when later public releases change a format. The initial
settings-file baseline is numeric version 1; profiles and RPC fragments carry no
format marker. Unknown settings versions are rejected without changing their bytes.
Release upgrade/uninstall qualification remains open.

The usage summary retains conversation totals and adds the latest agent attempt's
model-bound checkpoint plus the latest terminal turn's aggregate. The checkpoint
reports unknown context usage for an ineligible latest agent row while preserving
its billing totals. New lookups use indexes and aggregate only that selected turn.
Terminal totals cover every
purpose; speed inputs cover known agent requests only and become unavailable if
any relevant accounting/timing or historical purpose is unknown.

## Configuration boundary

The shipped server opens SQLite in exclusive mode with no busy retry before
schema initialization or runtime/provider startup. A second server for the same database
fails with a safe ownership error. The owner keeps its connection for the whole
server lifetime and closes it after runtime shutdown; process exit/crash also
releases the OS-managed SQLite lock. No separate PID lock or stale-lock recovery
is needed. Direct store tests/tools may use the ordinary nonexclusive constructor;
they must not bypass a running shipped server's ownership. This coordinates GUI
and TUI database use, not arbitrary external credential/settings writers.

The store persists workspace identity and overrides, not a resolved
`ConversationConfig`. `HarnessService` re-runs the settings cascade on creation,
load, and configuration change, so global/project settings can evolve without
rewriting stored conversations while explicit conversation overrides survive
resume.

## Accepted invariants

- Items and usage rows append; they are not rewritten to simulate editing.
- Head is the only mutable conversation-history pointer.
- The raw log preserves abandoned branches; active reads expose one selected
  lineage.
- Provider payloads never replace canonical content and are reused only for their
  bound provider/model/type/version.
- Runtime liveness, pending approvals, processes, and services are not durable.
- Store implementations satisfy shared observable behavior rather than mirror
  each other's private query sequences.

## Source map

- `packages/protocol/src/store.ts`: persistence contract.
- `packages/store`: in-memory implementation and defaults.
- `packages/store-sqlite`: current production schema and implementation.
- `packages/testkit`: shared store contract and fixtures.

## Verification

The shared store contract exercises conversation creation, append/head behavior,
active lineage, turns, payloads, usage, context builds, plugin state, blobs, and
range reads against both stores. SQLite-specific tests cover fresh-schema initialization, unsupported-format rejection,
constraints, transactions, reopen behavior, and reconciliation prerequisites.
Real stdio-server process tests establish exclusive contention, normal release,
and reopen after a crash; native desktop tests additionally exercise rejection
and retry through the UI.
