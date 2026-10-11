# First-message conversation titles

Status: Complete

## Outcome and design

Name a new root conversation from its first accepted user message without delaying
its agent response. Save a bounded first-message excerpt immediately, then make
one tool-free model invocation using the configured naming model or captured
conversation model. Persist a short generated title and emit a typed update for clients. Keep the excerpt on
empty output or external model failure; never retry naming after resume/rewind.

Current records have no title; desktop derives a label from the latest visible
user message and TUI lists workspace/model/time. Reuse ModelInvoker for middleware,
provider identity, context traces and billing. Supply prompt behavior through the
existing per-conversation service boundary, wired by the server. The plugin owns
the background call, cancellation and disposal. Core owns metadata updates and
the shared model invocation capability. Compare the current title with the
captured excerpt before publishing so an explicit title edit wins.

Settings exposes naming model/preset with conversation-model default. Plugin
config lives under `plugins.conversation-titles.model`. No periodic renaming, job
queue, backfill or new manual rename UI. SQLite gets an additive title-column migration; strict RPC gets
a version bump and a title update event.

## Milestones and completion checks

- [x] Persist nullable titles in both stores; verify conditional updates and SQLite
      upgrade/reopen preservation through store tests.
- [x] Generate once from the first root user input; verify concurrent main response,
      empty/failing output, cancellation, captured model, accounting, explicit
      overwrite and no retry after reload or rewind.
- [x] Expose titles over RPC and display them in desktop/TUI; verify client updates
      and persisted listing through public-boundary tests.
- [x] Synchronize subsystem/testing/product docs, run focused tests and full
      `npm run check`, and complete independent correctness, simplicity and
      evidence reviews. Record actual results below.

## Evidence

- 69 initial focused tests pass for naming, both stores, desktop session, TUI
  picker and real server-process settings persistence.
- Review corrections pass 120 focused naming/core/auto-approval/TUI tests. Internal
  errors now remain rejected, log safe diagnostics immediately, and aggregate
  after runtime cleanup. External provider failures/cancellation leave the excerpt.
- Desktop real RPC cache/view updates pass five session tests. Two production-route
  Chromium cases pass naming model/preset save/reset and sidebar/header titles.
- Final `npm run check -- --maxWorkers=2` passes typecheck, lint, formatting and
  all 1,268 tests (38 skips). Four affected production-route Chromium cases pass,
  including existing defaults/reviewer controls and the two new title cases.
- Three independent reviewers covered correctness, simplicity and evidence.
  Correctness and simplicity re-review confirm their findings are resolved;
  final evidence review also reports no remaining actionable findings (16 focused
  tests passed independently).
- The first migration assertion incorrectly expected an explicit true context flag;
  store normalization omits true. The corrected test verifies existing semantics.
- Initial browser execution lacked Chromium; a temporary `/tmp` installation enabled
  execution. The title rendering test initially evaluated before fixture initialization;
  waiting for that actual prerequisite fixed the test without changing product code.
- First full check passed typecheck/lint/format and 1,267 tests, with one Mistral test
  failure: its old single-call billing expectation excluded the new naming call.
  Reproduction returned 200/8 tokens versus expected 100/4. The fixture now waits
  for the generated title, asserts both calls' combined bill, and verifies the
  separate agent checkpoint/affinity. Fourteen focused integration tests pass.

Live vendor invocation and native desktop qualification remain outside this
source-level change's evidence. The user authorized committing and pushing
directly to main after validation.

## Ownership correction

User review identified naming-specific task/cancellation/error aggregation inside
core as a plugin ownership leak. Remove the title policy slot and runtime task.
Use the existing ServiceProvider boundary with generic persisted-input and cancel
hooks. The naming service owns eligibility, excerpt policy, invocation, controller,
background promise and errors; its dispose cancels/drains through existing generic
service teardown. Core only supplies input/model/metadata capabilities.
Validation of the correction passes 110 focused naming/core tests, including
cancellation during the initial excerpt write, forced close during first-message
persistence and excerpt-write failure reaching a failed turn and idle cleanup.
Independent review found the hook initially sat outside the turn failure boundary;
it now shares the existing try/finally and skips admission after cancellation.
Rebased the detached checkout onto fetched `origin/main` at `5ba09f3`, preserving
new auto-approval timeout behavior. Four affected Chromium cases pass after rebase.
The first rebased full check found an upstream settings fixture missing the new
nullable naming field; updated the fixture without changing timeout semantics.
Final `npm run check -- --maxWorkers=2` passes typecheck, lint, formatting and
1,289 tests (38 skipped). All three independent reviewers report no remaining
findings; correctness independently reran the original forced-close race and
evidence independently reran 110 focused tests plus the throwing-hook reproduction.
Four rebased Chromium cases pass. Earlier evidence above describes the
pre-correction implementation. The change is based on latest fetched main.

## Provider-boundary simplification

Removed the private `classifyProviderFailure` mode flag after user review. The
shared provider terminal classifies provider stream failures consistently;
context-window failures retain their existing recovery type. Middleware, store
and core invariant errors remain outside that catch. Three read-only reviewers
assessed the simplification. Evidence review found duplicated user-visible cause
chains; the wrapper now supplies a short message and preserves the original cause
once. The existing failed-turn accounting regression asserts the nested cause
text. Re-review reports no remaining findings; 110 focused tests and the full
check pass (1,289 tests, 38 skipped; typecheck, lint and formatting also pass).
