# Compact tools and live activities

Status: Complete

## Outcome and scope

Desktop reasoning and tool calls collapse into consecutive work groups between
messages. Earlier history loads automatically near the top.
Opening a group shows one compact row per call, with a single-line argument
preview; opening a call retains output, edits and approval facts. Child calls stay flat.
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
not rearm loading. One session-owned operation per attached view runs at a time,
including across route remounts of that view. Failed loads stop automatic attempts and expose explicit Retry;
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

## Final lifetime audit and visual adjustment

The extra correctness review reproduced a reload lifetime bug: sharing an earlier
history request solely by conversation ID allowed a replacement view to await a
request that updated only its detached predecessor. Sharing now keys the attached
ConversationView itself, preserving remount deduplication without crossing reload
lifetimes. The real RPC regression failed before this correction and now verifies
the replacement loads independently while the old response cannot change it.

The requested final presentation uses a once-per-second Thinking for X seconds
counter while active, Thought for X seconds after completion, or Thought
when historical timing is unknown. Expanded rows avoid extra indentation. Small decorative tool icons align with
the group label; reads, edits, search and commands use familiar icons, while other
tools use a generic icon. Reasoning retains its smaller muted text.

- [x] Verify corrected lifetime and latest labels with full source/browser checks.
- [x] Independently review the focused lifetime correction and commit.

## Selected Eval boundaries presentation

Status of follow-up: Complete.

The selected mockup keeps the thought chevron on the left and tool chevrons on the
right. Expanded reasoning is direct smaller muted text, without a separate preview
or disclosure. Tool names and icons stay compact; only failures show a status
prefix after the icon. Awaiting approval remains visible while applicable.

Eval has separate argument/begin and output/result disclosures with subtle
horizontal boundaries. Child calls remain in canonical order in the same flat
list, independently inspectable when the Eval disclosures are closed. Results
follow the last available descendant, including nested Eval calls. This is purely
desktop presentation over existing parentCallId values, not a protocol extension.
The collapsed group counts each call once; lazy output/diff rendering is preserved.

- [x] Validate flat children, Eval boundary ordering, keyboard inspection, labels
      and chevron geometry with focused and full source/browser checks.
- [x] Independently review correctness, simplicity, scope and evidence; resolve
      findings, synchronize documentation and commit the validated changes.

Three independent read-only review lenses found no remaining behavior, architecture
or simplicity issues. Review found stale native selectors and documentation;
these now match flat children and separate Eval boundary rows while retaining
approval, denial and parent-attribution checks. The Chromium anchor regression
now verifies the surviving child's position when a parent loads, rather than the
old presentation replacing that child with its parent. Icon alignment measures
the stable summary edge instead of a chevron bounding box during rotation.

Final `npm run check` passes TypeScript, ESLint, Prettier and 1,294 tests
(38 skipped). All 29 Chromium browser cases pass, including Eval boundary ordering,
flat keyboard-inspectable calls, failure-only labels, live thinking timing and
history anchoring. Rendered screenshots were inspected. `git diff --check` passes.
Native expectations were synchronized but Windows WebView2/live-provider behavior
remains unqualified on this Linux host. No protocol or persistence extension and
no push or external publication are included.

## Fresh abstraction and identity review

Status: Complete.

A fresh review reproduced a synthetic Eval result key collision with a valid
suffix-bearing tool call ID. Synthetic results now use a separate desktop key
namespace. The regression requires unique keys for both the child and result.

Review also found a clock-domain leak: reasoning starts are observed locally,
while canonical tool and reasoning completion timestamps come from the server.
Subtracting these could show immediate 60-second or negative elapsed labels on a
remote connection. Live group timing is now observed by DesktopTranscript using
only its local clock and survives content updates. Historical tool-only duration
uses comparable server timestamps; historical groups containing reasoning remain
untimed. This adds only desktop observation metadata, with no protocol changes,
clock synchronization or runtime state duplication.

- [x] Verify suffix-bearing IDs and a server clock 60 seconds behind through
      unit/browser regressions, full checks and independent correction review.
- [x] Synchronize evidence and commit the focused corrections.

Correction review also reproduced a timer reset when history prepend changed the
first member/group key. A temporary lookup by surviving existing member keys now
preserves the local observation through regrouping. No durable identity is added.
The unit regression verifies continuity, frozen completion and historical reopening.

Independent reviewers verified the namespace, clock boundary and continuity fixes
without remaining findings. Final `npm run check` passes TypeScript, ESLint,
Prettier and 1,296 tests (38 skipped). All 29 Chromium browser cases pass,
including the real displayed timer with a 60-second server skew. Native WebView2
and live-provider qualification remain outside this Linux evidence.
