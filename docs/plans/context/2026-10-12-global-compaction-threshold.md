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

## Partial-metadata follow-up (October 13)

Status: Complete; published in v0.1.13.

The user reported a new Mistral GLM conversation ignoring 20k, and LiteLLM
advertising input/output without a combined context window. The old early return
required both combined-window and output metadata even for explicit thresholds.
Fix this at the existing engine capacity boundary; do not infer missing catalog
fields, add transport/output-cap policy, or change configuration lifetime.

- [x] Honor configured thresholds with partial/absent metadata; derive the smallest
      known input bound; automatic uses input minus output minus a fixed 2% input
      cushion. Remove 85% and the bounded headroom constants.
- [x] Cover partial combinations, independent I/O, checkpoint suffixes, immediate
      allowance, repeated mid-turn tool compaction, and post-clear creation.
- [x] Focused checks, Settings browser/TUI regressions, full check, scoped
      correctness/simplicity/evidence review and owning documentation.

Normal agent output caps and transport selection remain unchanged. Without known
combined-window and output capacity, the existing compaction request cap stays
unspecified; it is not guessed from separate limits. The fixed-percent cushion
also applies when calculating the existing known-window compaction allowance.
GUI compaction streaming and LiteLLM reasoning preset generation are outside this
narrow follow-up. Loaded conversations still require server restart for settings
changes; no live refresh is introduced. No developer profiles are touched.

Follow-up validation passes: `npm run check` typecheck/lint/formatting and 1,339
tests (38 existing skips); 135 focused engine/RPC/TUI tests; the existing isolated
GUI threshold save/clear case; final engine/RPC recheck after scalar simplification.
Three read-only reviewers covered correctness, simplicity and evidence/scope.
Review findings were resolved: the no-fold fixture now leaves room for appended
content, cleared public RPC configuration correctly asserts null while persistence
asserts absence, and incomplete combined capacity does not invent a summary cap.
The existing checkpoint estimator and mid-turn guard are unchanged. No real
provider generation or running developer conversation was modified or restarted.
The running server needs the updated source loaded before this fix applies.

The user authorized release. Implementation `da6b32a` is pushed, and workflow
version bump `66cfd3b` is synchronized locally.
[Release run 38449490152](https://github.com/usatiuk/harness/actions/runs/38449490152)
passes clean-install source validation, Windows x64/Linux x64 glibc/macOS arm64
builds and artifact signature verification.
[v0.1.13](https://github.com/usatiuk/harness/releases/tag/v0.1.13) is published.
Existing running servers/conversations were not restarted as part of delivery.

## Empty-summary error follow-up (October 13)

The user reported empty compaction output and requested tool-call counts in the
GUI error, stronger summary-first prompting, and commit/push/release. The cause
of that exact live response remains unverified; the live database is intentionally
exclusively owned and was not bypassed or stopped.

The failure message now states empty text and the returned tool-call count,
without logging raw output or arguments. Automatic compaction explicitly requires
visible summary text first; optional continuation tools remain enabled. No
strategy/RPC change, retry or silent fallback is added. The full check passes
1,341 tests (38 existing skips); 133 focused engine/policy tests pass. The two new
regressions verify zero/two tool-call counts reach the existing failed-turn error,
no returned tools are dispatched and no empty fold is saved. Prompt compliance
on the original live failure is not claimed. Implementation `7701045` is pushed;
workflow version bump `f4d72db` is synchronized locally.
[Release run 38453302777](https://github.com/usatiuk/harness/actions/runs/38453302777)
passes clean-install source checks, all three native builds and signature
verification. [v0.1.14](https://github.com/usatiuk/harness/releases/tag/v0.1.14) is
published.

## Codex working-budget mapping (October 13)

Status: Implemented, validated and published in v0.1.15.

The user authorized a pragmatic capacity mapping and commit/push/release. The
Codex catalog's blanket 272k combined window, inherited 128k API output limit and
shared input/output reservation caused an automatic threshold of only 13,120.
The local Codex cache now reports 500k for Sol 6.1 and 272k for most other models,
with a 95% effective-window hint. Treating those working windows as already
output-reserved is the accepted **assumption, not a verified backend contract**.

Expose input ceilings of 628,000 for Sol 6.1 and 400,000 for other Codex models,
retain 128,000 output, and leave combined context unknown. Automatic thresholds
become 487,440 and 264,000 with the shared 2% cushion. Do not copy public API
combined windows into Codex or change the API model catalog, pricing, presets,
transport, output-cap support or compaction engine policy. The shared OpenAI
catalog type/projector now permits either input or combined-context metadata.
Catalog tests verify the public fields; independent-limit engine regressions
cover representative requests on either side of both thresholds.

Focused checks pass 152 tests; `npm run check` passes 1,346 tests (38 existing
skips). Three independent reviews report no blocking findings. Backend hard
limits remain unqualified. Clients cannot display a context percentage without
a combined-context capacity; raw input counts remain available.

Implementation `e2f02ce` is pushed; workflow version bump `4607e48` is synchronized
locally. [Release run 38466574537](https://github.com/usatiuk/harness/actions/runs/38466574537)
passes clean-install source checks, all three native builds and artifact signature
verification. [v0.1.15](https://github.com/usatiuk/harness/releases/tag/v0.1.15) is
published, including the Linux AppImage. Native runtime and live backend capacity
were not separately qualified by this release.
