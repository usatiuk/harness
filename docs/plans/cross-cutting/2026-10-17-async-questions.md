# Async questions

Status: Complete

## Goal and design

Provide one async `ask_questions` tool. Each request contains one or more questions,
with optional single or multiple choice options and an always-available comment.
A comment alone is a valid answer. Empty answers are not implicit approval or
consent. Users may explicitly dismiss a request.

The tool returns immediately. The agent continues independent work or ends its
turn when an answer is required. Submission steers a running conversation at its
safe input boundary, or starts work when idle. Server-owned pending questions
survive turn cancellation, client disconnect, reconnect, and server restart.
Repeated submissions return the recorded outcome without duplicate answer input.

Reuse the existing plugin, public RPC, attachment snapshot/events, and delivery
boundaries. Keep durable answer consumption narrowly scoped to questions; no
second general messaging subsystem, synchronous tool mode, or artificial Other
option. Clients own forms; the server validates and owns lifecycle.

## Milestones and completion checks

- [x] Backend contract and persistence: bounded requests, input validation,
      durable pending state, explicit dismissal, and idempotent answer delivery.
      Verify answer during work, idle wakeup, stop, restart, and duplicate answers.
- [x] Public integration: server composition, RPC, shared client snapshots/events,
      and protocol documentation. Verify two-client resolution and reconnect.
- [x] Desktop and TUI: batch forms, clearable choice selections, comments,
      freeform answers, submit/dismiss, and visible errors. Verify mixed inputs.
- [x] Review and validation: independent correctness, architecture/simplicity,
      and coverage review; focused checks and `npm run check` pass.
- [x] Synchronize README, PLAN, subsystem documentation, and testing evidence.

## Coordination

All implementation shares `/home/stepus53/projects/harness` at the user's request.
Backend agent owns protocol/store/core/service and questions runtime/schema;
UI agent owns desktop/CLI presentation. Primary agent owns shared question client,
server registration, generated schema, documentation, and final validation.
The separate React performance chat is being coordinated to avoid overlapping edits.

## Evidence

Initial main checkout was clean at d0bb4338acbf5d4655356f69116938b70364383f.
Backend focused validation passes 232 tests across engine/service/SQLite/in-memory
store suites. CLI focused validation passes 51 tests. Public RPC regression passes,
including fresh reconnect, same-client reattach, multiple clients, first-response
wins, comment-only answers, dismissal, read-only child response permissions, and
16 pending Unicode batches. Three Chromium browser tests pass, exercising mixed
forms, clearable choices, comments, visible submission errors, retry, dismissal,
and issued questions in read-only child views.

Three independent reviewers covered correctness/lifecycle, architecture/simplicity,
and tests/docs/scope. Fixed findings: cancellation discarded accepted inbox answers;
read-only child views rejected question responses; pending question byte limits could
exceed attachment capacity; desktop submission errors used the wrong result field.
Batches are limited to 16 KiB UTF-8 and 16 pending requests per conversation. The
existing aggregate loaded-tree attachment byte limit still applies.

Final `npm run check` passes: type checking, lint, formatting, and 1,518 tests
(41 skipped; 162 test files passed, 10 skipped). An initial full run exposed the
new tool missing from an exact approval-defaults fixture and two Ink tests sending
input before passive input listeners were installed. The fixture now includes the
tool; tests flush React effects using the existing repository `act` pattern, with
assertions and timeouts unchanged. The original failures and full suite pass.
Final independent reassessment found no remaining question issues. Native desktop
and remote terminal interaction are unqualified. After restart, questions in an unloaded child
conversation reappear when that child is opened; no cross-conversation durable inbox
or new root index was added.

The user subsequently authorized a combined main-checkout commit with the desktop
streaming performance refactor. Both features share the desktop session/snapshot
integration; no push is requested.

## Question layout follow-up

Desktop now shows one question at a time, with Back/Next navigation and final
batch submission. Hide/Show questions preserves local answers and the current
question without resolving the request. Removed nested question scrolling and
the enclosing support area's short cap for expanded forms; choices use a compact
grid and comments use a single-line input. Enter in that input does not dismiss
the request. Five focused browser cases pass, including no-scroll layout at 1174×887
and 900×650, navigation, draft preservation, errors, dismissal, and child views.

Final follow-up `npm run check` passes: type checking, lint, formatting, and
1,518 tests (41 skipped). Changes remain uncommitted.

## Per-question skip follow-up

Each question has an explicit Skip action (Ctrl+S in TUI), independent of whole
request dismissal. The questions v2 contract adds `{questionId, skipped: true}`
entries without changing ordinary answer entries or persistence schema. A batch
contains exactly one answer or skip per question. Skips are rendered as Skipped
in canonical user input; they never imply approval or an inferred answer.
Desktop keeps Back navigation for revisiting skipped questions and submits the
whole batch on the last question. Mixed and all-skipped batches, restart recovery,
TUI skipping, and the desktop flow have regression coverage.

Final skip follow-up `npm run check` passes: type checking, lint, formatting, and
1,520 tests (41 skipped). All six focused Chromium question cases pass. The user
authorized committing the layout, hide/show, single-line field, and skip updates.
