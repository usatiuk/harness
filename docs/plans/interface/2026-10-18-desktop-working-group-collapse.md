# Desktop working-group collapse, in-place expansion, and hover affordance

Status: Complete (cleanup and full-width two-line preview qualification recorded below).

## Goal and observable completion condition

Desktop work groups follow one rule: every group except the last collapses to a
single summary row, expanding reveals exactly the previously hidden rows with
only those rows animating in place, and every clickable transcript row shows a
hover/focus affordance. Completion condition: the browser regression suite
demonstrates the collapse rule, tail persistence across expand/collapse, animated
supersede collapse, and hover styles on actionable rows, with `npm run check`
green and the interface/testing docs describing the new behavior.

## Current behavior (grounded evidence)

- `StepGroup` ([routes.tsx:1175–1255](../../../packages/desktop/src/routes.tsx))
  decides `collapsible = steps.length > (latest ? 5 : 3)`. Groups at or below the
  threshold render a plain `.work-group-title` with their rows permanently inline
  and no expand affordance.
- The latest group shows a tail of the last five nonempty tool/reasoning entries
  (`WorkItems … preview`, `slice(-5)`) below the summary while closed. The
  reasoning peek fills the shared ~6-line budget (`peekLines = 6 - visible.length`
  for the final reasoning, 1 otherwise).
- Expanding mounts the full list inside the disclosure body (`unmountOnExit`)
  while the preview unmounts (`latest && !open`), so the visible tail rows are
  destroyed and recreated inside one animating `collapse-grid`. The result reads
  as "the 5 lines collapse and reappear as expanded all" instead of "lines are
  added at the top".
- Collapse animation is the shared `.collapse-grid` grid-template-rows/opacity
  mechanism ([styles.css:868–960](../../../packages/desktop/src/styles.css)) with
  `prefers-reduced-motion` handling and Radix Presence-based unmount-after-close.
  Outer Work disclosures use native named details (`name="conversation-work"`),
  keeping one outer Work disclosure open at a time (documented behavior).
- No hover/pointer/focus affordance on transcript disclosure rows;
  `.work-group-title` and `summary` rows are visually inert.
- Docs encode the replaced behavior: [interface README:506–507](../subsystems/interface/README.md)
  ("Expanding the outer group replaces its peek with all entries") and the tail
  contract at lines 497–505.
- Tests encoding the old thresholds: [conversation.spec.ts](../../../packages/desktop/tests/browser/conversation.spec.ts)
  lines 1161–1163 and 1377–1409 expect small groups to render without `.tool-group`
  disclosures; the `showLongToolRun` case (lines 1352–1375) expects a collapsed
  100-call group to contain zero `tool-call` rows.

## Target behavior (decided 2026-10-18; uniform-row requirement added the same day)

1. **Collapse rule.** Every work group is a collapsible summary row
   ("Working for X s · N tool calls" / "Worked for X s · N tool calls" /
   "Worked · N tool calls"). The size thresholds (`>5` latest / `>3` historical)
   are removed. Every group except the last in the transcript renders collapsed
   to just its summary row regardless of step count. Nothing is permanently
   inline because it is small.
2. **The last group keeps its tail.** The last group shows its quiet tail below
   the summary: the last five nonempty work entries in chronological
   order — tool rows one line each, reasoning rows up to two lines. This holds
   while running and after completion, until the group is superseded.
3. **Step rows are identical everywhere.** A step row renders the same element
   with the same props in the tail and in the expanded body, collapsed or open.
   There is no separate preview rendering mode. A reasoning row always shows its
   state label ("Thinking for X s" / "Thought for X s" / "Thinking" / "Thought")
   prefixed to a peek of the reasoning text's final lines in a two-line clamp —
   one line when the text has one, up to two when it has more. While streaming
   the label ticks and the peek follows the text; expanding only rotates the
   chevron and opens the body below the unchanged summary. The preview peek-fill
   heuristic (`peekLines = 6 - visible.length`) is removed in favor of these
   uniform rows. (This supersedes the earlier "keep the peek-fill" answer: uniform
   rows across the expand transition take priority, and the fill only ever applied
   to the final preview reasoning row. The peek grew from one line to up to two
   the same day.)
4. **Expansion adds rows in place.** Expanding a group reveals exactly the rows
   that were hidden, above the persistent tail when a tail is visible. Tail rows
   stay mounted across toggles (stable keys, no remount) and never animate; only
   the revealed rows run the shared collapse animation. Collapsing removes only
   those rows. For a group with no tail (non-last), all rows are "revealed rows"
   and animate together. While expanded, the split stays at its captured entry
   so incoming work does not move inspected rows between React parents. Closing
   restores the rolling five-entry tail. Blank reasoning rows are omitted.
5. **Supersede animates.** When a new group becomes the last, the previous
   group's tail collapses away with the existing collapse animation (one shared
   mechanism) and the group becomes a header-only row.
6. **Hover/focus on every actionable row.** Every clickable/expandable transcript
   row — work-group summaries that can expand, tool-call rows, reasoning rows,
   plugin-message, compaction/context, and message disclosures — shows a subtle
   hover tint (reuse `--navigation-hover-face`) plus `cursor: pointer`, with a
   matching `:focus-visible` treatment for keyboard users. Rows that cannot
   toggle (a summary with nothing to reveal) stay inert so hover continues to
   mean "clickable". Existing text-selection suppression on clickable summaries
   is preserved.

## Design

`StepGroup` partitions each group's steps once per render:

- Collapsed: split the chronological steps before the last five visible work
  entries; omit blank reasoning from the rendered rows.
- Expanded: capture that split entry for the expansion lifetime. New entries
  append to the visible suffix without moving existing rows between parents.
- `head`: the chronological prefix; `tail`: the suffix. Closing restores the
  rolling last-five selection.

Rendering structure inside the existing `.tool-group-container`:

- Summary row: the `Disclosure` summary (chevron + label) when rows can be hidden
  (`head.length > 0 || !latest`); otherwise the plain `.work-group-title` (the
  last group with nothing to reveal).
- Disclosure body (`unmountOnExit`, existing lazy `collapse-open`/`collapse-close`
  animation): `head` rows. Body content is `head` for the latest group and all
  steps for non-last groups is **not** needed; instead the tail wrapper carries
  the tail for every group.
- Tail wrapper: a `collapse-grid` + Presence block holding `tail` rows, open iff
  `latest || open`, `inert` when closed, unmounted after the closing animation.
  Because it is outside the disclosure body, head toggles never touch it; its
  state transition on supersede is the shared CSS collapse transition.

Consequences: expanding the live group opens the head _above_ the stationary tail
("adds at the top"); expanding a non-last group animates head and tail open
together (all rows are newly added); superseding the last group closes its tail
with the shared animation. Expansion holds one captured split key per group behind the
existing named details (`name="conversation-work"`); a group the user explicitly
expanded is not force-collapsed when superseded (the default stays "collapsed").
`WorkItems` has a single rendering path: no `preview` prop, no `peekLines`; every
step renders its one canonical row (reasoning: state label + two-line-clamp peek
of the text's final lines). Container placement (tail wrapper vs. disclosure
body) is the only difference between "tail" and "expanded" rows. The tail keeps
its current aria label ("Recent work"); the body keeps "Work details".

Invariants:

- Tail rows are never remounted by expand/collapse of their own group.
- Exactly the rows that transition hidden→visible animate; rows already visible
  are stationary.
- `transcript.ts` grouping, observed timing, and label wording/timing semantics
  are unchanged; this plan changes presentation only (the reasoning summary now
  always shows its state label).
- Named-details exclusivity (one open outer Work disclosure) is preserved.
- Reduced motion disables the new transitions through the existing
  `prefers-reduced-motion` rules.

Non-goals: persisted expansion state; force-closing user-expanded groups on
supersede; CLI/TUI working footer changes (its single bottom footer is documented
design); changes to grouping, timing labels, or tool row content; new animation
machinery, measured heights, or JS animation timers; hover work on sidebar/dock
rows (already styled).

## Rationale and alternatives

The structural head/tail split makes the "only added lines animate" property a
DOM invariant instead of animation bookkeeping: rows inside the animating body
are exactly the previously hidden rows. The rejected alternative — remembering
previously visible keys and applying enter animations per row — duplicates state,
needs remount control, and re-animates tail rows whenever the body remounts.

Uniform step rows (target behavior 3) replace the earlier split rendering where
tail rows showed text peeks and expanded rows showed only duration labels. That
split made rows change identity at the expand boundary and defeated in-place
transitions; the same element with the same props in every container makes the
boundary invisible. Capturing the split while expanded preserves parent ownership during streaming;
identical props alone cannot preserve React identity when a row moves parents. The earlier decision to keep
the `6 - visible.length` peek-fill was revised for the same reason: it only ever
gave the final preview reasoning row extra lines, so it is inherently a
preview-only rendering. The two-line clamp keeps reasoning rows compact (the
five-entry tail stays quiet) while showing where the thought is heading.

Force-closing an expanded group when it is superseded was rejected: it fights
explicit user intent and adds state choreography for no invariant. The
"always collapsed" rule applies to the default presentation.

## Execution checklist

- [x] **Collapse rule, head/tail structure, and uniform step rows** —
      `packages/desktop/src/routes.tsx` (`StepGroup`, `WorkItems`, `Reasoning`):
      remove the size thresholds, compute `head`/`tail`, render the summary row
      per the reveal rule, put `head` in the disclosure body and `tail` in the
      always-mounted wrapper; give `WorkItems` a single rendering path (drop
      `preview`/`peekLines`) where reasoning rows always show the state label plus
      a two-line-clamp peek of the text's final lines. Depends on: nothing.
      Completion: all non-last groups render as header-only rows at any step
      count; the last group shows its five-entry tail; a group with nothing to
      reveal shows the plain title; the same reasoning row markup renders in tail
      and body, collapsed and open, with a 1–2 line peek.
- [x] **Tail lifecycle and supersede collapse** — `packages/desktop/src/routes.tsx`,
      `packages/desktop/src/ui.tsx` (reuse/extend the collapse-grid + Presence
      primitive), `packages/desktop/src/styles.css`. Tail wrapper state follows
      `latest || open`, animates closed on supersede, unmounts after the closing
      animation, and is `inert` while closed. Depends on: slice 1. Completion:
      tail rows survive their group's expand/collapse unchanged (same DOM nodes);
      superseding collapses the tail with the shared animation to a header row;
      reduced motion shows the same end states without animation.
- [x] **Hover and focus affordance** — `packages/desktop/src/styles.css`: hover
      tint, `cursor: pointer`, and `:focus-visible` on all actionable transcript
      disclosure summaries (work groups, tool calls, reasoning, plugin messages,
      compaction/context, messages); inert rows unstyled. Depends on: nothing.
      Completion: hovering or keyboard-focusing each actionable summary shows the
      tint; rows that cannot toggle show no pointer/hover change.
- [x] **Browser regressions** — `packages/desktop/tests/browser/conversation.spec.ts`
      (fixture support in `composer-fixture.ts` if needed). Update threshold-
      encoding expectations (lines 1161–1163, 1377–1409, `showLongToolRun` at
      1352–1375: a collapsed last group keeps its five-row tail instead of zero
      rows) and the mode-dependent reasoning-summary expectations (lines
      1391–1405 now assert label + peek together in both states). Add: non-last
      small group collapses to a header row and expands to its rows; expanding the
      live group keeps tail DOM nodes and adds head rows above them; a reasoning
      row's summary is identical in the tail and in the expanded body (label +
      1–2 line peek); supersede collapses the tail to a header row; hover/focus
      computed styles on actionable rows; expand while following the bottom and
      while scrolled mid-transcript preserves the reading position. Depends on:
      slices 1–3. Completion: all listed scenarios pass in the ordinary browser
      suite with no weakened assertions.
- [x] **Docs, review, and qualification** (depends on all slices). Update
      [interface README:497–530](../subsystems/interface/README.md): replace
      "Expanding the outer group replaces its peek with all entries", the
      "unused budget gives the final reasoning up to its remaining lines"
      peek-fill wording, and the one-line-each entry wording; document the
      always-collapsed rule, uniform step rows (reasoning: state label + up to
      two-line peek), tail persistence, supersede animation, and hover
      affordance — reconciling the existing "Peek and expanded rows share the
      same rendering" claim with the actual contract. Update `docs/TESTING.md`
      for any coverage gaps (animation feel, native visuals), and this plan's
      status/evidence. Run independent read-only review (behavior,
      architecture/simplicity, evidence/scope) and root `npm run check`.
      Completion: check green, review findings resolved with evidence, evidence
      and limits recorded here.

## Validation

Failure scenarios to cover: expand/collapse of the live group mid-stream while
new steps arrive (tail clips from the top, no flicker); a group crossing the
tail-size boundary live; a reasoning row clipped out of the tail reappearing in
the expanded body with an identical summary; streaming reasoning where the label
ticks and the peek follows the text within the two-line clamp without height
jumps; supersede while the transcript is followed at the bottom and while
scrolled away; historical reload where the last group is completed (tail
persists, no timing mixing); two groups toggled via the named details
exclusivity; nested tool disclosures inside tail rows while the outer group
toggles; reduced-motion runs of the structural end states.

Automated evidence lives in the browser suite (structure, persistence, end
states, computed hover styles). Animation feel and native window appearance are
qualitative limits to record in `docs/TESTING.md` and the evidence section below.

## Evidence and remaining gaps

Review corrected: blank reasoning reordered by a noncontiguous
partition, open details remounted on rolling-tail migration, automatic grid
minimum widths overflowing the chat column, a diagnostic test breaking
TypeScript, stale shadow assertions, and tests missing readiness/anchor
prerequisites. Pinned-header top-edge bleed at DPR 1.25 is fixed with a one-pixel sticky
overlap; screenshot comparison checks that scrolling output cannot paint above
the header. A stable native scrollbar gutter prevents expansion from narrowing
rows by 15px; a regression samples row geometry throughout the animation with
native scrollbars enabled. The image-viewer follow-up closes on empty-space clicks and one
Escape, leaves image clicks alone, focuses the viewer instead of its tooltip
button, and keeps the close control legible in light/dark themes.

Focused browser regressions pass for those behaviors, actual reading anchors,
retained streaming disclosures, widths, animation, reduced motion, and focus.
Independent final production/test/simplicity reviews found no remaining defect.
Validation:

- `TMPDIR=/var/tmp npm run check`: passed typechecking, lint, formatting, and
  1,606 tests (41 skipped). Normal `/tmp` contains an invalid `.git` marker;
  Git discovery in the unrelated worktree integration test fails there. Using
  the standard `/var/tmp` test directory avoids that environment artifact.
- Full Chromium browser run: 109/111 passed. The activities geometry test
  measured its bottom-anchored controls on different animation frames; waiting
  for the actual animations preserves every original bound and passes its
  targeted rerun (1/1). The remaining automatic-history anchor case drifts 12px,
  identically reproduced with HEAD sources and documented in the previous
  streaming-performance plan. Its assertions remain unchanged.
- Focused checks include all changed Work and image-viewer contracts. Negative
  controls confirm the sticky-paint test fails with `top: 0`, and the native
  scrollbar test fails by 15px without the stable gutter.
- Real WebKitGTK passes four affected Work cases. Frame probes in Chromium and
  WebKitGTK, at 1280px and 760px widths, found no transcript horizontal
  oscillation across repeated short/long-history expansion. The user reported
  that restarting cleared a separate renderer glitch; its cause is unproven.
- Image-viewer coverage verifies image clicks keep it open, empty-space clicks
  dismiss, initial focus avoids a tooltip, one Escape dismisses even with the
  close-button tooltip visible, focus restores, and close-button hover/focus
  stays legible in light/dark themes.
- Three independent review lenses and final cross-reviews found no remaining
  scoped correctness or simplicity defect. No commits or external mutations.

Limits: browser geometry and pixel checks do not establish every native window
or display configuration. The baseline history-anchor failure remains outside
this presentation change; native animation feel is qualitative.

## Virtualization and thought-presentation follow-up

The user reported that scrolling back to the latest virtualized Work group
replayed its opening animation. The unconditional lazy animation class ran on
every mount, although the latest tail was already logically visible. Entry
animation eligibility now follows the existing expansion snapshot: historical
user expansion animates, automatic latest-tail restoration does not, and
superseding an explicitly expanded group leaves its visible tail stationary.
Closing a superseded tail still uses the shared exit animation. The expansion
snapshot changes only for the outer disclosure's own toggle; nested tool/thought
toggle events must not recapture its animation eligibility.

The user also requested an inline thought label/preview instead of a label beside
a two-line text column, and no repeated preview when the thought is expanded.
This supersedes the earlier two-line/unmodified-summary requirement above.
Collapsed thoughts now use one inline label and a single-line plain-text excerpt;
the excerpt clips older text from the left so streamed final words stay visible.
Expanded thoughts retain only the label above the full original Markdown. CSS
selects the native open state; no duplicate React disclosure state is added.

- [x] Latest-tail virtualization restoration and expanded-group supersede have
      no new opening animation; real historical expansion and supersede closing
      remain animated.
- [x] Thought label and excerpt share one line; opening hides the excerpt while
      retaining the label and full original body.
- [x] Focused Chromium/WebKit regressions, full checks, and final review recorded.

Focused follow-up validation: Chromium 9/9 and real GTK WebKit 4/4 pass. The
streaming regression measures text ranges inside the clipped viewport, verifying
that original and newly streamed final markers remain visible at narrow widths
while older characters clip off the left. Actual virtualizer unmount/remount and
superseding an expanded latest group preserve the intended animation behavior.
The inline preview screenshot was inspected, and independent correctness and
simplicity reviews found no remaining scoped issue. Full checks pass again: typechecking, lint, formatting, and 1,606 tests
(41 skipped), with the same `/var/tmp` environment adjustment. The final
nested-toggle guard and strengthened regression also receive a desktop
typecheck and targeted Chromium/WebKit rerun.

## Two-line preview correction

The user clarified that the compact reasoning preview should still show up to
**two lines**, with line two starting underneath Thinking at the row's left edge,
rather than remaining indented in a separate preview column. The label is a
normal inline prefix, the latest streamed suffix remains visible, and expanded
thoughts still hide the preview and show the original body once. This supersedes
the follow-up's single-line preview choice and the initial two-column correction.

CSS clipping alone cannot preserve both the inline prefix and the latest text
with full-width wrapping. A local summary component measures an inaccessible,
fixed-position label clone and candidate suffix using the actual browser font
and wrapping. A bounded binary search over the existing last 2,000 characters
selects a trailing suffix fitting two lines. The callback ref owns text in a
React-empty span; no duplicate React disclosure state or generic layout system
is added. ResizeObserver responds to summary/label width changes, and cleanup
removes the probe and observer. The original Markdown body remains untouched.

The browser regression checks actual two-line height, line one after the label,
and line two starting at the label's left edge. It verifies newest marker
visibility in both axes and that the rendered text is a suffix of the original,
including streaming while expanded and window resizing. Fractional CSS widths
are preserved in measurement: rounding 214.6px to 215px admitted a third line.
The regression fails against the rounded implementation and passes the fix at
both 200.6px and 214.6px.

Qualification: Chromium 9/9 and GTK WebKit 4/4 pass; the strengthened renderer
cases pass again in both engines (2/2 each). Screenshots were inspected in both
engines. Full checks pass 1,606 tests (41 skipped), with final desktop
typechecking and focused browser validation covering the fractional-width fix.
Independent correctness and simplicity reviews found no remaining scoped issue.

## Minor release delivery

The user authorized committing, pushing, and publishing the next minor release
on October 18. The current published version is v0.4.0; use the existing release
workflow with `bump=minor` to build v0.5.0 rather than changing versions locally.

- [x] Commit the qualified preview correction and push the scoped commits.
- [x] Run the release workflow and verify source checks and all three builds.
- [ ] Verify signed metadata, publish the release, and record delivery evidence.

Scoped commits aac8cb8, 9f1d9ba and ffea6aa are pushed. The existing
[release workflow](https://github.com/usatiuk/harness/actions/runs/39114863455)
passes its source gate, all three platform builds and signed draft assembly.
It created version commit/tag 1dd526a / v0.5.0. All 19 draft assets are present;
downloaded metadata passes the production native signature verifier, manifest
schema, version, target/update-platform sets and release URL checks.

[Regular CI](https://github.com/usatiuk/harness/actions/runs/39114860390)
passes Ubuntu. Its first Windows attempt fails two unchanged tests: the CLI
sandbox lifecycle assertion sees the initial input frame, and image-only history
exceeds its five-second timeout (10.9 seconds including cleanup, versus 1.1 seconds
in the previous passing Windows run). The lifecycle test writes input before
waiting for mount/subscription, unlike its neighboring reload test. A diagnostic
rerun uses identical source and assertions; no timeout or retry policy is changed.
The rerun passes image history but repeats the lifecycle failure. Correct only
that test's input prerequisites: await the existing subscription, then await the
rendered command before submitting. Its mutation/deactivation assertions stay
unchanged. All seven local lifecycle/launch tests pass; hosted Windows validation
must confirm the correction. The image timeout cause remains unisolated.
