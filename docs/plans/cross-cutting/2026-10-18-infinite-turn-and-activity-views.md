# 2026-10-18 Infinite turn + activity views — Status: Active

## Goal

- Single-turn autonomy unbounded by step count; command output pageable on demand; subagent peek matchable log.
- Observable: 150+ tool-round turn succeeds; `bash({command, max_lines})` returns larger bounded view by default 40; subagent `peek` shows `→ name args~100 — ok/fail: preview~100` in place.

## Current (grounded)

- `MAX_MODEL_STEPS=100` in `packages/core/src/engine.ts:90`, loop `1235`, throw `1488`; doc `docs/subsystems/kernel/README.md:64`.
- `CommandTool` only `{command}` in `packages/workspace/src/tools.ts:231`; output `VIEW{40,1024,16KiB,tail}` in `packages/workspace/src/process-activity.ts:12`; `boundView` in `packages/execution/src/bound.ts`; spill `.harness/<conv>/outputs/<id>.log` in `packages/execution/src/local.ts`.
- Subagent peek `PEEK_LINES=40/LINE_CAP=500`, `→ name` / `  ok` unlinkable in `packages/subagents/src/activity.ts:onEvent`; `ToolCall.args` in `packages/protocol/src/tools.ts`; `callId/status/content` in `packages/protocol/src/items.ts`.

## Approach / invariants

- Delete bound entirely (no config, KISS/YAGNI). `interrupt`/`steer` at after-tool-result boundary remain the stop; `queue` still waits next turn.
- `max_lines` optional, capped (e.g. ≤500 lines / ≤64KiB total, headroom under `read_file` 256KiB). Default unchanged 40/16KiB. Per-kind only (commands), no universal activities knob.
- Subagent peek stays append-only log of 40; rewrite same `callId` line in place to `— ok / — fail: preview`. Final stays full; transport `MAX_ATTACH_BYTES=2MiB` remains backstop.
- Non-goals: subagent depth change (keep 2), force-background subagents, paging/timeout changes, raising defaults globally.

## Milestones

- [x] M1 infinite turn: remove const/loop-bound/throw + doc line; `npm run check` + new/existing core test for >100 rounds.
- [x] M2 command max_lines: schema + per-activity view plumbing + caps; workspace/execution tests; doc touch.
- [x] M3 subagent peek: args~100 + in-place ok/fail by callId; subagents tests; doc touch.
- [ ] M4 validation: `npm run check`, focused Vitest, independent review, plan evidence.

## Validation (2026-10-18)

- Focused: `core + subagents + workspace/tools + process-activity + execution/bound + activities` — 12 files / 260 tests pass, incl. new 150-round turn test.
- Full `npm run check`: 157 passed / 9 failed files (23 tests); failures in `server/worktrees` + `provider-integration` reproduce on clean tree (env), unrelated to diff.
- Reviews: behavior, architecture, tests/evidence read-only reviews addressed (cost wording, over-cap reject, doc touches, stray file removed).
- Loop review: behavior PASS (150-round deterministic, over-cap consistent, peek matched); arch notes step-observability + library-clamp vs boundary-reject + `#lines` growth deferred as designed gaps, `typeof` closed, MATERIALIZE now references `COMMAND_VIEW_DEFAULT_BYTES`; tests PASS (READMEs synced, no new timing, `tmp/` removed).
- Final review: all three PASS with no hold; one real fix applied — widened-view spill trim now honors `view.maxTotalBytes` instead of the 16KiB default so 64KiB views survive spill; Gaps section now also lists clamp-vs-reject and `#lines` growth explicitly.
- Prettier + `git diff --check` clean on touched files.

## Validation

- Core: long-turn (>100 tool rounds) succeeds; interrupt/steer still abort/merge.
- Workspace: default 40 unchanged; `max_lines:200` returns ~200 bounded lines; over-cap rejected at wire + direct (library clamp only).
- Subagents: peek shows args, ok/fail matched; final unchanged.
- Docs: kernel + orchestration READMEs synced.

## Gaps

- Stuck-model spend now bounded only by context/compaction or interrupt — accepted per request.
- Over-cap `max_lines`: tool boundary (wire schema + direct `execute`) rejects, internal library (`resolveCommandView`/`createProcessActivity`) clamps defensively — intentional layering, documented in Validation.
- Subagent `#lines` log grows unbounded per long turn (peek shows last 40; array trims only on activity GC); in-place `callId` rewrite can mutate already-emitted peek lines — accepted by design.
