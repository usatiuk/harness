# Improve transcript UX

Status: Complete

## Goal

Keep chronological `Thought` and `Explored` stages while replacing block-scoped
busy indicators with one stable turn footer. During a running turn the footer is
`Working…` at the bottom of the live transcript; the terminal event atomically
replaces it with a session-local `Worked for …` row. Give that row one blank line
above and below, and give the initial conversation banner one trailing blank line.

## Grounded current behavior

- Compact layout already derives chronological reasoning and exploration stages
  without changing canonical items. Successful reads/searches do not flash as
  temporary tool cards; commands, edits, approvals, and failures stay explicit.
- `Working…` currently belongs to a trailing exploration stage or appears only
  when no mutable presentation exists. It therefore disappears during reasoning
  and narration, and its special sticky-header path bypasses normal spacing.
- Turn events already arrive with a client receipt timestamp. The TUI does not
  receive model-generation boundaries, and exact turn completion timing is not
  persisted for resume.
- The initial `conversation <uuid>` line is printed before Ink with no blank line
  separating it from the first screen block.

## Chosen design

- Treat `turn.status` as the only work-footer lifecycle. Store the observed start
  time in reducer state; while running, render one `Working…` footer after all
  transcript output. On the matching terminal event, append one local
  `Worked for …` cell using the observed elapsed time.
- Completed work footers remain in the current reducer session so later turns
  retain them, but `init` does not reconstruct them. Add no canonical item,
  protocol, store, service, or migration support.
- Use `• Explored` as the stable heading for both growing and closed read/search
  trees. Keep compact `Thought` summaries and every existing explicit tool/error
  presentation.
- Remove exploration-header extraction and header-specific viewport sizing.
  Normal bottom clipping owns the invariant that the newest output, work footer,
  and input panel remain visible.
- Put one blank line above the work footer and one shared blank line between the
  transcript/footer area and the input region. This avoids doubled gaps when the
  next turn begins. Print the creation banner with one trailing blank line.

## Implementation

1. Extend local reducer state/cells with observed turn start time and a finalized
   work-footer cell; append it once for completed, failed, or aborted turns after
   settling partial output and emitting any error cell.
2. Simplify exploration rendering to a stable `Explored` tree and remove the
   obsolete active-header branch from the App and bounded viewport.
3. Render the active footer after the live transcript, add the shared pre-input
   spacer, and update the new-conversation banner.
4. Update reducer, layout, App, spacing, and real-terminal regressions plus the
   interface subsystem documentation.

## Non-goals

- Persisting or reconstructing historical work footers after reload/resume.
- Adding model-invocation events or inferring a generation lifecycle.
- Restoring turn-wide file/search/command counts or changing semantic stages.
- Changing provider, kernel execution, canonical item, or database behavior.

## Acceptance

- Exactly one `Working…` footer remains at the bottom throughout reasoning,
  narration, tool calls, and exploration; no exploration block owns another
  `Working…` spinner.
- A matching terminal event replaces it with exactly one `Worked for …` row,
  including failed and aborted turns. Duplicate terminal events cannot duplicate
  the row.
- The work row has one blank line above and below. The initial conversation UUID
  also has one blank line after it.
- Exploration trees retain their order and children under a stable `Explored`
  heading; compact/verbose behavior otherwise remains unchanged.
- Tall real-terminal output keeps the work footer and input panel visible through
  bottom clipping, and final scrollback publishes the completed footer once.
- Focused tests and `npm run check` pass, followed by correctness, terminal, and
  explicit simplicity/anti-overengineering review.

## Prior delivery evidence

- Commit `8343956` delivered chronological stages, incremental Static
  publication, reasoning timing, explicit approval handling, and 596 passing
  tests across 72 files after three-lens review.

## Delivery evidence

- The reducer now models a running turn with a mandatory observed start time. A
  terminal event can close only that matching running turn, so duplicate or stale
  terminal delivery cannot append another footer or overwrite a newer turn.
- The TUI renders one global live footer and one session-local completed footer,
  uses stable `Explored` stages, restores the ordinary bottom-clipped viewport,
  and adds the requested transcript/input and creation-banner spacing.
- Focused reducer/layout/component/App/index/xterm validation passed during
  implementation. Final `npm run check` passed typecheck, lint, Prettier, and 598
  tests across 72 files; 34 platform/environment-specific tests were skipped.
- Correctness, evidence, and explicit simplicity/anti-overengineering reviewers
  inspected the diff. Their actionable findings removed stale exploration
  lifetime state, made turn timing correct by construction, made stale terminal
  events harmless, strengthened real-xterm assertions, corrected a stale comment,
  and removed a test-only banner-formatting API. The final correctness review
  reported no remaining defect.
