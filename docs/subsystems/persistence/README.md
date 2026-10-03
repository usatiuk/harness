# Persistence subsystem

## Status

Harness persists production conversations in SQLite and uses an in-memory store
for deterministic tests. Both implement the same `Store` contract. The durable
model is an append-only item graph with a movable conversation head; resolved
configuration and live runtime state are not stored.

## Durable model

A conversation record stores:

- Its id and creation time.
- A workspace root, or `null` for a projectless conversation.
- A durable settings-override object.
- `head`, the current leaf item or `null` before the first append.

Appending an item assigns a monotonic conversation sequence, links `parent` to
the current head, and advances head atomically. Rewind moves head to an earlier
item. Continuing afterward appends another child while the abandoned tail remains
in the raw log. `listActiveItems` follows the selected head's ancestry; model
context and TUI resume use that active chain.

Canonical item types are user/assistant messages, reasoning, tool calls, tool
results, compaction folds, and plugin-injected context. Items are immutable after
append.

## Related records

- **Turns** record running/completed/failed/aborted status. Runtime liveness stays
  in memory; persisted `running` exists for crash reconciliation only.
- **Provider payloads** preserve provider/model/type/version-bound opaque data
  such as encrypted reasoning without contaminating canonical item content.
- **Context builds** record the exact stable instructions, selected items, tool
  roster, prompt, tool choice, output request, and purpose for model invocations.
- **Model usage** records provider/model token usage, optional context-build link,
  calculated cost, and turn ownership. A durable `null` usage value distinguishes
  a completed invocation whose compatible backend omitted accounting from a real
  zero-token report.
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

Schema changes use ordered `user_version` migrations. Harness is pre-release and
the database is currently disposable: migrations may intentionally clear
conversation-scoped data instead of carrying compatibility machinery when the
new invariant is simpler.

## Configuration boundary

The shipped server opens SQLite in exclusive mode with no busy retry before
migrations or runtime/provider startup. A second server for the same database
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
- `packages/store-sqlite`: production schema, migrations, and implementation.
- `packages/testkit`: shared store contract and fixtures.

## Verification

The shared store contract exercises conversation creation, append/head behavior,
active lineage, turns, payloads, usage, context builds, plugin state, blobs, and
range reads against both stores. SQLite-specific tests cover migrations,
constraints, transactions, reopen behavior, and reconciliation prerequisites.
Real stdio-server process tests establish exclusive contention, normal release,
and reopen after a crash; native desktop tests additionally exercise rejection
and retry through the UI.
