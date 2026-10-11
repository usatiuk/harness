# Compact tools and live activities

Status: Complete

## Outcome and scope

Desktop conversation tool calls collapse into consecutive groups between messages.
Opening a group shows one compact row per call, with a single-line argument
preview; opening a call retains output, edits, approval facts and nested calls.
Activities show only running work and automatically fetch output every second,
without overlapping requests or updates after unmount. Subagent previews include
in-progress assistant text as well as committed messages and tool entries.

Use existing names, activity peek RPC and conversation events. Do not add Recent,
new push protocols, storage policy changes or activity lifecycle refactoring.
Grouping belongs to desktop presentation; canonical history remains unchanged.

## Milestones

- [x] Implement compact tool groups and running-only automatic activity output.
      Preserve nested calls, history anchoring and full inspection details.
- [x] Verify grouping, preview replacement, polling cleanup and actual browser
      presentation through focused regressions; run the full local check.
- [x] Independently review correctness, architecture/simplicity and evidence;
      resolve findings and synchronize interface/orchestration/testing docs.

## Evidence

Before this change, desktop rendered each tool as a padded disclosure; completed
activity rows remained visible and output required a manual action. Subagent peek
ignored text stream deltas.

Implemented with existing peek RPC and desktop-only grouping. Three independent
read-only reviews found no blocking issue; the minor always-true running prop was
removed and late-response coverage was added. A follow-up correctness review
confirmed disclosure capture uses Virtuoso's existing size-change follow method,
including native keyboard activation, while preserving reading-away behavior.

The first full check caught a test helper returning a broad Cell union; its return
type now expresses a tool cell. The original child-anchor browser fixture assumed
24 separate rows at a fixed position. It now expands grouped fixture calls and
establishes reading mode before locating the first call, preserving the original
anchor assertion. A full browser run reproduced a 360px gap after tool expansion;
arming the virtualizer's existing resize-follow before summary activation fixes
the original failure. No assertions, timeouts or retries were weakened.

Final Chromium conversation suite: 18 passed, including automatic peek cadence,
no overlapping peeks, removal on completion, navigation cleanup, and late response
after unmount. Focused grouping/subagent Vitest tests: 16 passed. Rendered browser
screenshots were inspected. Native WebView and live-provider behavior were not
exercised; no claims are made for those boundaries.

Final `npm run check` passes: TypeScript, ESLint, Prettier and 1,276 tests
(38 skipped). `git diff --check` passes. No commits or external publication were
requested or performed.

## Focused simplicity review follow-up

A fresh three-lens review found no scope creep or unnecessary abstraction. It
confirmed one lifecycle defect: disconnect leaves the visible conversation mounted,
so the activity interval kept calling a closed peer. A production-route regression
reproduced three extra peeks over three seconds. The existing effect now depends
on the session's disconnected state and does not start while disconnected; Stop
is disabled at the same boundary. This reuses existing cleanup and adds no retry,
reconnection, subscription or storage machinery. The correctness reviewer verified
the fix. The Stop assertion initially queried a hidden control; opening its
existing disclosures establishes the real prerequisite without weakening the
assertion. Final follow-up validation: `npm run check` passes (1,276 tests, 38
skipped); the complete Chromium conversation suite passes all 19 cases; Prettier
and `git diff --check` pass. Native WebView/live-provider limits remain unchanged.

## Interface and hidden-rendering review follow-up

Another independent review identified an unnecessary recursive desktop row type
and eager materialization of hidden call output/diffs inside a grouped virtual
item. The desktop representation now distinguishes cell rows from tool groups
with nonrecursive tool members, without duplicating the first member on the group.
Group contents and call detail bodies mount only while their respective native
disclosures are open. A 100-call, 1,000-line-per-write browser regression checks
that collapsed groups mount no calls and opened groups mount previews but no
unopened diff/output bodies.

The review also identified a narrow limitation: prepending earlier calls to a run
can replace its first-call group key, resetting the open disclosure. Results and
history remain intact, and anchor fallback retains group position. This edge is
accepted for this scoped change; no general disclosure-state or identity layer
is added. Multi-level nested-operation omission predates this change and is not
expanded into this work.

- [x] Verify tightened types, lazy disclosure rendering and existing regressions;
      run full checks and record final evidence.
- [x] Independently review the focused corrections.

All three reviewers verified the focused corrections without further actionable
findings. The group type also requires at least one tool, removing redundant
non-null assertions and kind guards at consumers. Final Chromium conversation
suite: 20 passed, including the representative long-run regression. Focused
transcript/subagent suites: 16 passed. Final `npm run check` passes TypeScript,
ESLint, Prettier and 1,276 tests (38 skipped); `git diff --check` passes. Native
WebView and live-provider qualification remain outside this evidence.
