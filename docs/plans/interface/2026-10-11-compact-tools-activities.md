# Compact tools and live activities

Status: Complete

## Outcome and scope

Desktop reasoning and tool calls collapse into consecutive work groups between
messages. Earlier history loads automatically near the top.
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

## Automatic history and combined reasoning follow-up

Status of follow-up: Complete. The user authorized local commits and requested
automatic earlier-history loading plus combined reasoning/tool groups.

Consecutive reasoning and tool cells share one collapsed desktop group, preserving
canonical order and inspectable detail. Messages and other transcript entries
break the group. Group labels show Working or Worked for the observed duration, retaining tool
counts. Missing historical timings use Worked without inventing an elapsed time. Expanded
reasoning uses smaller muted text, separate from assistant commentary/output.
The representation stays nonrecursive and nonempty; no server/protocol changes.

A desktop-local history marker uses IntersectionObserver on the existing scroll
container to submit the existing bounded history action near the top. A stable observer loads one page per approach; upward wheel input or the discreet
keyboard-accessible marker can continue a collapsed run. Completion alone does
not rearm loading. One session-owned operation per conversation runs at a time,
including across route remounts. Failed loads stop automatic attempts and expose explicit Retry;
disconnected sessions do not load. Existing history anchoring handles prepend.
No prominent Load earlier button or new Canvas loading interface is needed.
The final Start of conversation label keeps the history header height stable.

Review found and fixed automatic draining of collapsed history and duplicate
cursor requests across route remounts. A focused browser test also caught the
final header removal shifting the reader by 44px; preserving header geometry
fixes the original anchor assertion. Keyboard continuation remains available
without adding a gesture framework.

- [x] Verify combined reasoning/tool grouping, automatic loading, no overlap,
      error retry and preserved anchor; run full local and browser checks.
- [x] Independently review correctness, interfaces and scope/simplicity.
- [x] Update durable documentation and prepare the validated follow-up for commit.

All three review lenses are resolved. Timing review requires observedTiming for
reasoning before displaying an elapsed duration; historical completion timestamps
alone do not establish a beginning. The full source check passes TypeScript,
ESLint, Prettier and 1,277 tests (38 skipped). All 24 Chromium conversation tests
pass, including the four follow-up scenarios and rendered compact reasoning.

The browser run exposed an existing composer test race: gap=0 held while footer
clearance was still 373px instead of the resized dock's required 447px. Independent
frame measurements confirmed ResizeObserver and Virtuoso converge to the correct
clearance and visible output. The test now waits for actual footer clearance and
asserts the same final assistant/dock geometry, without changing timeouts or
production behavior.

Native expectations were updated for lazy groups and automatic paging, but Windows
WebView2/live-provider behavior remains unqualified on this Linux host. No push
or external publication is included.

## Remote integration verification

Rebased both feature commits onto origin/main `700336c`, the first-message
conversation-naming delivery. The remote default branch is main. The single
conflict was overlapping appended browser tests; both naming tests and all
activity/history tests are preserved. Feature commits after rebase are `bb7efb3`
and `8388670`. No changes to the naming implementation were needed.

Three independent read-only integration reviews found no actionable issue. Title
events update conversation metadata while keeping transcript cells and identity
stable, so expanded groups, activity polling and the history observer retain
their lifetimes. In-flight history updates preserve the current title.

Final rebased `npm run check` passes TypeScript, ESLint, Prettier and 1,292 tests
(38 skipped). The entire Chromium browser suite passes all 28 cases: 26
conversation cases and two MCP settings cases. `git diff --check` passes. Native
Windows WebView2/live-provider qualification remains outside these results.
