# Transcript reading and streaming follow-up

Date: 2026-10-19. Baseline: `4a9ba4e` (`main`).
Status: Implementation verified; final browser rerun and hosted publication gates
remain active. Publication joins the user-authorized
[Linux ARM64 minor release](../cross-cutting/2026-10-19-linux-arm64-support.md).
Related delivery: [agent/desktop/shell productization](../cross-cutting/2026-10-19-agent-desktop-and-shell-follow-up.md).

## Goal and scope

Keep the reader's position stable while older history loads, Working details
change, and live output grows; remove the terminal-style streaming square.
The previously recorded 12px prepend drift is one fixture observation, NOT an
upper bound or a reason to describe the user's larger jumps as minor.

Work through the existing transcript/virtualizer and presentation boundaries.
Do not add a second scroll manager, durable UI state, generic animation framework,
retries, widened geometry tolerances, or longer test timeouts to hide movement.
Do not change message persistence, agent semantics, or provider output. Fresh
full-change review also found two confirmed regressions in the previous delivery:
activity completion formatting after handle collection and container environment
reconstruction. The user authorized narrow architectural fixes; these are
separate from the transcript causes, not a general expansion of shell/activity work.

## Current evidence and approach

- `routes.tsx` appends a `.stream-indicator` span after a block Markdown body.
  Its CSS is a literal 5-by-12px solid ink rectangle, not a text-position cursor.
  Remove that visual node/style; expose busy state on the actual assistant article
  and retain existing running/Stop/Working presentation.
- The existing automatic-history regression observes a 12px position change
  against its original 1.5px rounding tolerance. Earlier documentation also records
  larger idle regrouping drift. Those are symptoms, not a proven shared cause.
- Investigate virtualized measurements, header/loading removal, group merging and
  height changes using actual DOM/scroll before-and-after evidence. User-visible
  jumps can exceed a single fixture's value. Establish each root cause before
  modifying product behavior and preserve the original failing scenario.

## Milestones

### M1 — Remove the terminal cursor

- [x] Remove the square without adding another visual animation; retain accessible
      streaming state and completion actions.
      Check: production-route regression covers growing assistant content, busy
      state, Stop availability, no cursor node, and settled message/actions.

### M2 — Diagnose and correct reading movement

- [x] Reproduce the original history failure and representative longer/multipage
      and variable-height/Working/streaming scenarios. Record actual causes below;
      do not assume all glitches share one cause.
- [x] Make the smallest correction at the existing anchoring/virtualization seam.
      Check: original history scenario and 1.5px contract pass with matching
      semantic geometry; representative larger
      prepend/regrouping cases preserve the reader's visible content and position.
      Bottom following, intentional scroll, details expansion, and return-to-latest
      behavior remain intact. Unknown causes remain open rather than patched over.

### M3 — Review, validation and documentation

- [x] Independently review the nontrivial scroll correction for correctness,
      lifetime/order and KISS/DRY/YAGNI; resolve findings with evidence.
- [x] Resolve the two confirmed prior-delivery review findings through existing
      boundaries. Check: actual wait-tool and foreground completion survive
      handle collection; container command reconstruction preserves valid OS
      environment names/values without printing them as shell assignment errors.
- [x] Run focused production-route regressions and `npm run check`; synchronize
      interface/testing/product documents and record actual limits. Do not claim a
      full browser suite is green unless a completed run establishes it.
- [x] Commit coherent validated slices locally under existing user authorization;
      do not restart the user's installed server.
- [ ] Under the user's subsequent explicit authorization, push validated commits,
      dispatch the existing minor release workflow through `gh`, verify its
      produced artifacts, and publish the release. Do not hand-bump versions or
      publish before required fixes/reviews/checks pass.

### M4 — Subsequent shared-control and context visuals

- [x] Correct the user-reported Hide/New conversation hover and focus mismatch
      through shared controls/recipes, preserving real navigation-link semantics
      and native button/form behavior. Check computed surfaces and geometry in
      both themes rather than only class names.
- [x] Align Show sidebar with the actual header when hidden in CSD, native and
      fullscreen chrome. The user observed native Linux but did not rule out CSD;
      verify both rather than assuming a platform-specific offset.
- [x] Replace the broken-looking unknown context ring with an explicit standard
      unknown affordance. Preserve known zero/progress, authoritative checkpoint
      capacity and accounting semantics; do not invent a percentage from missing
      data. Check both themes and accessible/popover facts.
- [x] Independently review these visual changes, run focused and integrated checks,
      and synchronize final evidence before the minor release. These are required
      user-reported regressions, not optional styling deferrals.

### M5 — Remove the unrequested group failure classification

- [x] Delete the aggregation predicate, Failed summary alert and red group class/
      styling completely, not through a setting or CSS-only hide. Check normal
      failed tool calls do not classify the Working group; existing per-call
      errors/output and actual conversation errors remain unchanged.
- [x] Update the owning behavior/testing guidance and verify the focused public
      regressions plus integrated checks before publication.

## Evidence and findings

- The cursor is removed rather than replaced by another animation. The assistant
  article exposes `aria-busy`; content growth, Stop availability and settled
  message actions remain intact. Three focused production-route browser cases
  pass, including pre-output Working and retry progress.
- The exact legacy 12px assertion is a test geometry error: its baseline uses
  `.user-text` (padded container), while its final `getByText` resolves an inner
  span 12px below that box. Instrumentation observes those same offsets before
  and after prepend, not 12px of movement. Separate text/box reads through a
  changing first-row locator can also mismatch identities (259.5px was observed).
  Preserve the original 1.5px stability contract and loading scenario, but sample
  one semantic box/identity atomically. Do not compensate product scrolling for
  mismatched test geometry.
- This corrects the earlier characterization of the 12px observation as a proven
  product defect. It does not invalidate the user's larger-jump report. Genuine
  movement across variable-height, work-group and streaming cases is still under
  investigation; no general scroll repair is claimed.
- The user confirms the large jump occurs at least when scrolling upward while
  older messages load.
- Further scenarios are reproduced independently of the faulty legacy
  measurement: three 180-row mixed-height prepends can temporarily remove the
  reading anchor from the DOM before eventually restoring its position; this
  task-level observation alone does not establish a painted disappearance.
  Extending an expanded
  existing work group with 35 older tool rows shifts the existing child by 945px.
  The old guard only captures when the first row key changes, so same-key group
  extension bypasses correction. Immediate `scrollToIndex` also uses new indices
  before the virtualizer's old measurements are reconciled.
- A library-native `firstItemIndex` experiment keeps the visible anchor present
  at zero measured delta through the mixed-height prepends, removing the stale
  imperative index jump. Same-group prefix growth needs a narrow surviving-content
  correction at that row's actual commit; that part remains under investigation.
- Fresh full-change reviewers independently reproduced completed-result formatting
  after handle collection in both `activity_wait` and foreground `consume`.
  Deterministic public-path regressions fail on the old code with
  `Cannot label unknown activity: target-id` (log `act_cda51bb6`).
  An initial completed-only metadata fix passed 24 tests, but further review
  reproduced the same gap at timeout in both public paths (`act_3d97142b`).
  That partial fix is superseded: the existing manager wait now requires
  synchronous outcome consumption inside its protected `try/finally`, including
  timeout-to-background notice registration. No lease, new registry, extra
  retention state or post-release repair guards. Both GC completion paths, both
  timeout paths, both ambiguity-change paths, and consumer-throw cleanup pass
  in the 27-test activities suite; lint/format pass (`act_ce82a65f`). Exact
  independent re-review is pending.
- Container reconstruction incorrectly used Bash `export` on each NUL-delimited
  OS environment entry. Dotted keys are valid environment names but not shell
  identifiers; rejection both aborts a valid command and prints the value to
  stderr. A platform `env` reconstruction fix and real-shell regressions are
  implemented using an array and `env -i --`; host Docker transport remains
  stdin-only. Twelve real-shell/live Docker tests pass, including exact multiline
  and equals values, empty stderr, and exit codes 0/23. Independent correctness
  review confirms the fix and reproduces the real-shell cases.
- Scroll qualification remains open: one automatic multipage run failed after a
  broader focused pass. Investigation identified a missing test prerequisite
  (the native virtualizer had not yet committed the approached semantic row).
  The corrected test waits for that actual viewport prerequisite, retaining the
  1.5px assertion and continuous DOM observations. Final same-test A/B evidence and
  integrated validation are still required; earlier passing runs alone are not
  sign-off.
- Final same-test A/B confirms the original canvas loses the reading anchor in
  task-level DOM observations during both mixed-height and production automatic 180-row
  prepends. Fixed source passes 15/15 independent fresh-context runs and the
  21-case reading/bottom/font matrix. Evidence is retained under
  `.harness/9a8152e0-5ea2-4d8e-bd0d-c5de973d703d/anchor-evidence/`.
- Fresh independent production probes then expose a missing boundary case:
  a Working container below its 40vh cap cannot absorb the scroll correction,
  leaving 19.796875px displacement after one older step. Crossing the cap with 35
  steps leaves 251.890625px after the inner scroll clamps; the existing already
  capped control remains within 0.11px. The same node stays displaced in all
  samples after measurement. Fix and dedicated regressions are in progress; broad
  prior passes do not establish this missing behavior.
- Parent integrated validation before the latest review fixes: full Chromium
  **160/160** (`act_5f1288fb`); `env -u HARNESS_SERVER_SELECTION npm run check`
  **2,085 passed / 46 skipped**, all type/lint/format stages green
  (`act_3abaaf83`). A prior container-author full check inherited managed-server
  selection and failed isolated server setup; clearing that test-only environment
  variable resolves those failures. Final source must be revalidated after the
  activity ownership and Working scroll-boundary changes.
- The bounded inner/page correction passes 23 focused Chromium cases, and the
  integrated source passes **2,088 tests / 46 skips** (`act_96c8d997`), including
  type/lint/format. The Linux native desktop application also builds successfully
  (`act_1bf45903`); this is build evidence, not installed-window qualification.
- A later broad browser run passes 161/162 but flags a 945px geometry observation
  in the same-group test despite stable final position (`act_f66a2461`). Raw CDP
  compositor tracing proves this observation is **unpainted**: task sample at
  30.317ms, first following ResizeObserver at 62.104ms, restoration at 63.128ms,
  measured commit at 68.951ms, first following Paint at 70.671ms. Both surrounding
  compositor screenshots retain identical marker bounds. This is different from
  the original genuine **final-position** 945px baseline defect. MessageChannel
  tasks posted from rAF are not paint acknowledgements and must not be described
  as such. Raw trace/filmstrip evidence is retained under
  `.harness/1c654d90-528a-4350-affd-153c31feab51/anchor-paint-evidence/`.
- Under the user's explicit library-first simplicity request, a bounded
  simplification replaces the extra row wrapper with Virtuoso's typed
  `components.Item` / `ItemProps` boundary. This removes the shared pending-anchor
  handoff, aggregate-height restoration callback, and parent-DOM measurement read;
  the existing item owns its snapshot and reconciles against its measured-size
  prop. This is an ownership simplification, not a timing fix for the unpainted
  sample. Ordinary prepends continue to use native `firstItemIndex`.
- Automated traces now explicitly assert continuous DOM identity/presence and
  geometry at actual measured-row observations, including a final measured state.
  They retain 1.5px tolerance and reject missing anchors at any observation.
  These are not claims that every compositor frame was sampled. The archived
  trace qualifies the observed 945px intermediate case; other native engines and
  compositor timing remain outside this Chromium evidence.
- The final library-first simplification also replaces the expansion-follow
  flag, remaining aggregate-height callback and custom animation-frame jump with
  Virtuoso's public `autoscrollToBottom`, armed only when the opening click is at
  the actual bottom. No substitute timer or fallback. Focused **24/24** Chromium,
  desktop typecheck, lint/format and diff checks pass; the canvas is 24 lines
  smaller than the preceding bounded fix. Final source is
  canvas SHA-256 `485875e51c71f3089d7ab6687e6a9e223ea956d16d94271b32c547499dd16a47`.
- Final integrated `env -u HARNESS_SERVER_SELECTION npm run check` passes
  **2,088 tests / 46 skips / 0 failures**, including all three typechecks, lint
  and formatting (`act_2cd5a201`). A preceding lint attempt scanned the newly
  archived diagnostic browser script as product JavaScript; the raw script/JSON
  are now byte-identical `.txt` archives, with no lint/config scope relaxation.
  Final Vite production build and protocol schema regeneration pass with no
  schema drift (`act_9620e86d`).
- The final broad Chromium run passes **161/162**, including every cursor,
  history, Working and bottom-follow regression (`act_4c05c37c`). The remaining
  failure is an existing sidebar pagination scenario: Show more leaves five
  accessible links instead of ten. Earlier complete runs pass this sidebar test;
  its cause is not yet established. Do not call the broad suite green or
  attribute this to scrolling without evidence. A bounded classification probe
  is recorded below; no sidebar product change is made merely to erase it.
- The failed run's pre-click screenshot shows the sidebar disclosure mid-opening;
  five DOM links are not a stable-pointer prerequisite. A controlled existing
  animation edge reproduces the exact five-versus-ten result: button pointerdown,
  opening animation completion clamps the clipped body's scroll offset and moves
  the button from y147 to y302, pointerup hits a different element, and no
  `loadProject(more=true)` call occurs. Normal instrumented cases paginate
  correctly. This establishes a missing test prerequisite, not unique proof of
  the unrecorded natural failing pointer sequence. The test now awaits the
  disclosure's actual `Animation.finished` promises before screenshot/click,
  retaining the ten-link assertion and normal timeout. No sidebar product
  changes, synthetic sleeps, retries or weakened assertion. Raw evidence is
  archived as `sidebar-animation-probe.mjs.txt` / `.log` in the paint-evidence
  directory. The final complete browser rerun passes **162/162** with retries
  disabled (`act_f5dd71ae`). This is a new completed result, not a rewrite of
  earlier failed runs.
- Fresh independent full-change reviews cover correctness/lifetimes,
  architecture/KISS/DRY/YAGNI, and tests/evidence/scope across `b215b8e` through
  the working changes, not just scrolling. They expose the two real core bugs and
  the under/cross-cap omission, all now fixed. Final exact-source correctness and
  simplicity re-reviews approve the library-first freeze; independent probes
  verify seven activity lifetime paths, two real-shell environment paths, and
  the item measurement lifecycle. No new registry, lease, scroll manager,
  persistent disclosure state or shell framework is added.
- Core fixes are committed as `5280625`; transcript simplification and synchronized
  evidence are the next coherent increment. Push/release remain pending final
  ARM64 integration under the user's explicit minor-release authorization.
- Subsequent user screenshots/reports expose two presentation gaps from the
  previous shared-control delivery. New conversation remains a bespoke link
  while sidebar controls use the shared ghost/chrome recipe, so hover/focus,
  corner radius and size diverge. Hidden Show sidebar is above the header center
  in CSD, native and fullscreen fixture modes. Focused computed-style/geometry
  regressions reproduce all six mode/theme cases before the fix.
- The context screenshot matches the deliberate unknown-state implementation:
  a dashed CSS border under the ring's radial mask. It looks like a damaged
  spinner. Missing input/output/accounting in that image is not evidence that
  known values were lost; retain honest unknown semantics while replacing the
  visual affordance. Known-capacity arithmetic remains covered separately.
- The control fix uses a narrow `IconLink` sharing Button's class recipe and the
  existing tooltip presentation with `IconButton`, while retaining anchor
  Ctrl/Cmd-click and leaving native button/form/disabled/loading behavior intact.
  Header padding and content-border tokens now own Show sidebar positioning;
  legacy new-conversation styling is removed, not patched with another override.
  Context unknown uses Lucide's standard question-circle; known zero and
  percentages continue through the unchanged capacity helper.
- Focused final visual qualification passes **23/23** Chromium cases. Six
  mode/theme control regressions and two unknown-context regressions first fail
  on the original source. Final tests verify computed hover/focus surfaces,
  dimensions, corner radius, real modified-link navigation and tooltip behavior,
  header alignment, and all capacity cases in both themes. Normal native form
  semantics stay unchanged. Desktop typecheck, scoped source/test lint, format
  and diff checks pass. The parent inspects unknown-context and hover/header
  screenshots. Source digests/raw logs/screenshots are under
  `.harness/sidebar-regression-20261019/`; these are browser CSS-mode checks, not
  actual OS-window qualification.
- Final integrated source validation passes **2,106 tests / 46 skips / 0 failures**
  with all type/lint/format stages (`act_6e7ac136`) and the complete Chromium suite
  passes **169/169** with retries disabled (`act_e8fe52e3`). Final native Cargo
  formatting/tests (**13**), Vite production build and schema regeneration pass
  with no protocol drift (`act_abdf8b31`). Exact-source correctness and evidence
  review approve the final shared-control, unknown-context and literal subagent
  guidance changes. Publication still requires hosted ARM qualification and
  production-signature verification under the minor-release plan. The user later
  accepted signing-key rotation and a manual upgrade; old-key rejection is now
  intentional rather than a compatibility failure.
- The user explicitly rejects the added Working-group failure classification:
  some failed tool calls are normal. The aggregation predicate, Failed suffix/
  alert, red class and CSS are deleted rather than hidden or made configurable.
  Earlier per-tool failure presentation and raw error/output rendering predate
  that addition and remain unchanged. Public regressions now assert no failed
  group classification while preserving individual error detail and duration.
  Both focused public cases pass (**2/2**, `act_a7f4cc39`) and fresh complete
  `npm run check` passes **2,106 / 46 skips** (`act_e298a60e`). Independent exact
  deletion review approves the removal. The new full browser run passes
  **169/169**, retries disabled (`act_9dbd7ef0`), rather than relabeling the
  preceding snapshot. The removal and complete implementation are committed
  in `2d8a04f`, pushed to main. Source CI `39321165700` passes Linux x64 and
  native ARM64 (including real OpenSSH), but exposes two Windows fixture errors.
  Canonical-path and Windows-home fixture corrections await fresh hosted CI.
  See the ARM64 plan for the subsequent open target inventory and key rotation.

### Library boundary references

- [Virtuoso API](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/):
  native prepend indexing, following, and supported component/imperative boundaries.
- [Virtuoso troubleshooting](https://virtuoso.dev/react-virtuoso/troubleshooting/):
  native dynamic-size measurement constraints. The installed 4.18.16 types/source
  remain the implementation authority for this delivery.
