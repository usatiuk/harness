# Feedback storage controls

Status: Complete

## Scope

Make the existing feedback checkbox control collection and buttons, show estimated
feedback storage, and provide confirmed deletion of all local feedback data.
Preserve conversations, usage, credentials, provider continuation data, and
operational context builds. Do not redesign context storage, add controls, shrink
the SQLite file, or coordinate deletion with active calls. Active operations may
save feedback again after deletion; this is explicitly accepted.

## Approach

The server supplies the engine's optional evidence-capture switch from current
global feedback settings. Disabled calls omit the existing evidence map and native
capture hook. Store namespace size/delete operations cover `model-evidence` only;
the feedback runtime adds local case/receipt file sizes and deletes those files.
Desktop uses existing settings and confirmation components.

## Delivery checklist

- [x] Gate evidence capture; regression verifies disabled/enabled calls and setting changes.
- [x] Estimate/delete feedback data; shared store and public RPC tests verify preservation.
- [x] Add size and confirmed deletion to existing settings; verify desktop behavior.
- [x] Synchronize feedback docs, run focused tests and `npm run check`, and independently review the scoped diff.

## Validation

- Focused engine/context tests: 152 passed.
- Shared in-memory/SQLite store suites: 88 passed.
- Public server/RPC/SQLite regression: passed, including off/on/off calls in one
  open conversation, exact combined byte accounting, and deletion preservation.
- Headless desktop browser regressions: 4 passed (existing vote plus collection
  toggle and clear confirmation/cancellation/success/failure).
- Initial RPC run inherited managed-server selection from the tool environment;
  clearing `HARNESS_SERVER_SELECTION` and `HARNESS_PREPARED_SERVER` for the
  isolated source test resolved the startup failure without product changes.
- `npm run check -- --maxWorkers=2`: passed typecheck, lint, formatting and all
  2,123 tests (91 platform/opt-in skips).
- The default-worker full run passed static checks and 2,113 tests but timed out
  in ten tests across `background-release.test.ts` and `changes.test.ts`, with one
  busy temporary-directory cleanup. Those unchanged suites passed separately
  (16 passed, 2 skipped), and the full bounded-worker run passed without changing
  assertions, timeout values, retries or product code. The default-concurrency
  timeout cause is not established beyond this load-sensitive observation.
- Three independent read-only reviews (correctness, architecture/simplicity,
  tests/documentation/scope): no actionable findings.
- No installed desktop, live database, or MAI data was changed. Headless browser
  coverage does not claim native packaged-app or live-provider qualification.
