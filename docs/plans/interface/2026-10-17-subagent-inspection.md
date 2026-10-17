# Subagent inspection

Status: Complete

## Follow-up: communication and presentation

Research: [existing delivery and ownership](../../research/2026-10-17-subagent-messaging.md).
Implementation and a commit after validation are authorized. No push.

### Behavior

- Keep `subagent({agent, name, slug, task})`. Add `subagent_list({relation, cursor?})`,
  `subagent_send({to, message})` and `subagent_dismiss({to})`; `to` is a conversation ID returned by the list.
  Names/slugs remain readable labels, not another addressing system.
- List the caller's direct parent, siblings and own children, with IDs,
  names/slugs, relationship and current status. Apply the same family rule at
  every depth. Exclude self, cousins and unrelated roots. Enforce the rule when
  sending, not just when listing. Keep child/sibling pages bounded using existing
  parent-scoped storage queries.
- Defaults: configurable `maxDepth: 2` (children and grandchildren) and
  `maxChildren: 3` active direct children per parent. Finished children occupy a
  roster slot until dismissed. Expose both through existing GUI/TUI host settings.
  Spawn admission is serialized per parent so parallel calls cannot exceed its
  limit; this replaces the earlier slug-only in-flight reservation.
- A parent can dismiss its direct child and subtree using one durable flag.
  Descendants inherit dismissal through existing parent links. Dismissed branches
  disappear from the model-facing list and reject ordinary family messages.
  Sending to a direct parent always works, including within a dismissed branch.
  Activity completion can still wake its owner; waking does not restore roster
  membership. Preserve paged GUI history inspection. Dismissed agents cannot
  spawn hidden children. No recursive database rewrite or reactivation tool.
- Sending is ordinary plugin input: use the existing `steer` behavior used by
  activity completion. Busy recipients receive it at the existing safe boundary;
  idle recipients start a turn. Any permitted sender can wake a finished agent.
  There is no finished-agent exception, restart command or new lifecycle.
- The server derives sender identity from the calling conversation and includes
  it in the message content. Retain the existing plugin delivery source and
  nonhuman presentation. A successful send acknowledges acceptance, not a reply.
- Activities remain handles for their original work. Keep existing wait, stop
  and one-shot completion behavior. Completion can already wake an idle owner,
  including a subagent. Do not reset settled handles or create an activity for
  each message. Later turns use the ordinary conversation state and history.
- Child headers show the full clickable ancestor chain, ending with the current
  task name. Reuse that ancestry for activity ownership labels.
- The expanded subagent tree has Running and Finished sections. Keep a branch
  together in Running while any member runs; otherwise place it in Finished.
  Preserve each row's own Running / Completed / Failed / Stopped status and the
  running descendant count. No collapse controls.
- Activities show their owning subagent chain beside the title. Keep one activity
  expanded at a time. Place a quiet 22px Stop icon to the right of Running.

### Implementation boundaries

Use the existing inbox, turn loop, plugin input provenance, spawn metadata,
parent-scoped queries and activity manager. Put family lookup/permission checks
in the subagents package; share that logic between list and send. Extend only
the narrow runner/service capability needed to deliver plugin input to another
conversation. Do not route model messages through the human RPC write path or
import the engine into the plugin.

Preserve root ownership when loading a historical recipient: ordinary root
teardown must still cancel its loaded descendants. This is an existing ownership
invariant, not permission to build a second session manager. Existing scoped tool
allowlists still apply; include the communication tools in the built-in explore
profile so that read-only agents can communicate without gaining file writes.

Reuse one ancestry projection for breadcrumbs and activity labels. Preserve the
activity event's existing owner conversation ID in the transcript reducer rather
than adding a wire field. Refresh running counts/sections from turn state as well
as activity events, since a message can start work without starting an activity.

No message bus, broker, mailbox table, delivery receipts, automatic replies,
broadcast, retry system, new agent state machine, restart policy,
extra sidebar, or changes to conversation scheduling. No automatic resumption
after process restart; explicit messages use ordinary delivery.

### Follow-up milestones

- [x] Communication: add the three tools through the existing tool pipeline and
      narrow plugin-input seam. Verify parent/child, sibling and nested-family
      routing; reject unrelated recipients; preserve sender identity and tool
      scopes. Verify both busy delivery and waking finished recipients, including
      a finished subagent awakened by its own activity completion. Check history
      and ordinary root cancellation after explicitly messaging an old child.
      Verify per-parent limits, concurrent spawn admission, recursive dismissal,
      parent delivery exemption and slot reuse. Check GUI/TUI settings persistence
      and invalid values through their ordinary RPC boundary.
- [x] Presentation: full ancestor chain, Running/Finished branch grouping,
      owner labels and 22px Stop. Verify latest-turn updates after message-driven
      wakeup, branch grouping with a running grandchild, paging, narrow headers,
      exclusive activity expansion and no horizontal popover overflow.
- [x] Finish: focused public-boundary regressions, affected browser checks,
      `npm run check`, proportional independent review and synchronized protocol,
      subsystem and testing documentation. Preserve the existing history-anchor
      failure evidence below. Commit authorized after verification; no push.

Follow-up validation:

- `npm run check`: typecheck, lint, formatting and 1,492 tests pass (41 skipped).
- Chromium: 80 of 81 cases pass. Only the same baseline history-anchor case
  fails with the previously recorded 12px shift. No assertion or timeout changed.
- All five affected subagent/settings browser cases pass in GTK WebKit, including
  full nested ancestry, Running/Finished grouping, activity ownership, 22px Stop,
  empty-popover overflow and GUI settings submission. TUI settings persistence
  passes through the existing host JSON editor and real server RPC.
- Service regressions exercise actual plugin delivery into busy and finished
  recipients, four concurrent spawn attempts with a three-child limit, independent
  child capacity, depth enforcement, recursive dismissal and the parent exception.
  A real background activity's captured tool context wakes a dismissed, finished
  subagent. Reopened SQLite retains dismissal and omits it from the model roster
  while preserving GUI inspection.
- Independent behavior, simplicity and evidence reviews found one teardown race,
  corrected by rejecting adoption while the previous scope closes. A regression
  covers rejection, later adoption and root cleanup. Historical child attachment
  now resolves durable ancestry before taking the existing canonical root lease;
  direct child opening after SQLite reopen and root-close cleanup are verified.
  Review of that correction found no remaining material findings.

Native desktop and live-provider execution remain unqualified. The existing
history-anchor defect remains outside this subagent change.

## Scope and approach

Implement issue #38's agreed desktop inspection surface: a right-aligned header
control showing the running descendant count (icon-only at zero), opening a
popover tree. Rows retain completed, failed and stopped children. Load direct
children in bounded pages and show nested branches expanded, without collapse
controls. Open the ordinary
conversation view read-only with a parent-name breadcrumb; omit rename,
worktree and composer controls. Keep children out of sidebar and Recents.

Parents supply a readable name and stable slug at spawn. Slugs are unique within
the parent conversation. Use these across activity and inspection presentation;
retain the configured agent as its execution profile. Existing spawn marks use
their configured agent as their display name and their child id as their slug.

Reuse durable turn outcomes and normal live attachment. Index plugin state by an
optional scope (parent conversation), avoiding whole-database reconstruction.
Reject client mutations of spawned conversations at the RPC boundary; internal
task seeding and parent-owned cancellation continue through the runner.
No steering UI, new sidebar or new orchestration lifecycle.

## Milestones and completion checks

- [x] Persistence and naming: scoped plugin-state paging, additive migration,
      parent-supplied names/slugs and duplicate-slug rejection. Verify both stores,
      old spawn marks and concurrent duplicate requests.
- [x] Public inspection: typed plugin metadata/list requests with paged children,
      durable outcomes and live running counts; read-only client boundary.
      Verify over real in-process RPC, including reconnect and history/live access.
- [x] Desktop: header popover tree, nested paging, status labels, child breadcrumb
      and ordinary live read-only transcript. Verify rendered browser behavior.
- [x] Validation and handoff: independent behavior, simplicity and evidence
      reviews; required checks; synchronized subsystem/testing documentation.

## Evidence

Focused validation passes 105 tests covering both stores, subagent identity,
real RPC inspection and desktop session attachment. Three Chromium cases pass for
popover trees, navigation and empty-popover sizing at narrow/wide widths. The
reported horizontal scrollbar was an inner 420px list inside the shared 320px
popover; sizing now belongs to the popover itself, with one scroll owner.

Final validation:

- `npm run check`: typecheck, lint, formatting and 1,487 tests pass (41 skipped).
- Chromium browser suite: 78 pass, one existing history-anchor case fails by
  12px. The same failure reproduces against the pre-change `3561ae8` sources
  using an isolated Vite source overlay. Its cause remains open; no assertions or
  timeouts were weakened and unrelated scrolling behavior was not changed.
- The three subagent browser cases pass in Chromium and GTK WebKit, including
  nested paging/navigation, outcomes, header geometry and empty-popover overflow.
- Three independent read-only reviews covered behavior, simplicity and evidence.
  Their child-history finding is corrected: the requested member's head, not the
  root's head, anchors inspection. A nonempty-parent regression proves isolation.
  Latest-turn SQL explicitly limits one row. A reopened SQLite fixture proves
  listing stale running work neither loads its runtime nor starts the provider;
  subsequent inspection retains ordinary crash reconciliation to Failed.
- The generic write check preserves the existing worktree recovery path before
  attachment. Real RPC tests verify this alongside the inspection contracts.

Native desktop execution and live-provider delegation remain unqualified by these
controlled tests. No commit or push.

Follow-up: the tree now renders nested branches directly, without disclosure
controls. Per-parent paging and the single popover scroll region remain.
