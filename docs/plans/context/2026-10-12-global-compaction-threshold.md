# Global compaction threshold

Status: Complete

## Outcome and scope

Expose one global positive integer input-token threshold through existing settings
RPC, desktop Defaults, and TUI selected-host defaults. Blank/null restores
automatic behavior. Projects, profiles and conversations cannot override it.

The engine uses `min(floor(0.85 * maxInput), configuredThreshold)`, capped by the
existing output/headroom safety limit. Missing max-input metadata derives the
input budget from context-window minus output maximum. Missing capacity metadata
leaves proactive compaction unavailable. Existing compatible usage checkpoints
plus appended-content estimates remain the trigger. Manual compaction, overflow
recovery, strategy contracts and immutable history remain unchanged.

Use existing runtime caching: new conversations resolve the setting immediately;
already-loaded conversations need a server restart. No live refresh, migration,
new preference store, plugin package, or per-conversation control.

## Milestones and completion checks

- [x] Configuration/RPC/engine: validate at existing boundaries, preserve clearing
      and omitted-patch semantics, and expose resolved/wire configuration. Protocol
      version 7 accounts for the new property in strict clients.
- [x] Settings surfaces: numeric desktop input and existing TUI JSON editor use
      the nullable scalar; both explain loaded-conversation restart requirements.
- [x] Verification: focused threshold/checkpoint tests, real RPC persistence,
      GUI/TUI setting and clearing, full check, and independent scoped review.
- [x] Delivery: commit, push, run patch release, and publish after all jobs pass.

## Evidence and review

`npm run check` passes: typecheck, lint, formatting, 1,316 tests passed and
38 skipped. All 32 browser tests pass. Real selected-host TUI settings tests pass
and confirm set/clear persistence through RPC. The new engine cases verify small
versus large appended tool output and changed-model checkpoint invalidation.
Three independent reviews cover correctness, simplicity, and evidence/scope;
no actionable findings remain.

TUI input tests initially sent keys before the conversation input or parent menu
mounted. Waiting for the visible prerequisite fixes the original failure without
increasing timeouts or weakening assertions.

The schema generator previously failed on the existing settings patch transform;
request schemas now use Zod input mode, retaining strict unsupported-type failures.
Tiny synthetic token budgets initially crossed thresholds because appended
message metadata also counts; representative budgets preserve the no-fold cases.
Browser Settings initially targeted the hidden Defaults tab; navigation was fixed.
Tests use isolated temporary homes and the browser fixture, preserving dev profiles.

## Delivery

Implementation commit `87814f9` and the preceding desktop creation-defaults commit
`f673c34` were pushed to main. Release version commit `065f406` bumps to 0.1.8.
[Release workflow](https://github.com/usatiuk/harness/actions/runs/38288840094)
passed source validation, Windows x64, Linux x64 glibc, macOS arm64 builds and
release assembly/signature verification. All 19 assets were present in the draft.
[v0.1.8](https://github.com/usatiuk/harness/releases/tag/v0.1.8) was published on
2026-10-12. Native GUI interaction was not exercised; GUI behavior is covered by
the Chromium fixture, and TUI settings/persistence use a real isolated server.
