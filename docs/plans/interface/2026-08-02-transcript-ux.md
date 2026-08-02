# Improve transcript UX

Status: Complete

## Goal

Make the compact TUI transcript readable as a conversation rather than a raw
event log. Completion means routine model work collapses into one truthful
per-turn summary, file mutations show a bounded colored patch, and visible
conversation blocks have consistent breathing room without breaking live
streaming, resume, verbose mode, or terminal scrollback.

## Current behavior

- Final reasoning collapses to one `thought` marker per reasoning item.
- Every tool call renders independently, so several reads and searches dominate
  the answer they support.
- Edit tools use the same generic call/result card as every other tool.
- Finalized cells enter Ink `Static` as soon as they stop streaming, which means a
  derived per-turn summary cannot safely change after an earlier cell freezes.

## Chosen design

- Keep granular cells as the reducer's presentation truth and derive semantic
  display entries in a pure layout pass.
- Keep every cell from the active turn mutable until the turn reaches a terminal
  state; then publish its final layout to static scrollback once.
- In compact mode, replace reasoning and successful unapproved reads, globs, and
  commands with one work summary at the first hidden-work position. Keep running,
  failed, approved, edit, and unfamiliar tools visible.
- Label the summary `Working…` while active and `Worked for …` afterward. Count
  unique read paths and successful search/command calls. Derive approximate
  timing from local event receipt timestamps live and durable item timestamps on
  resume; do not add timing to the kernel protocol or store.
- Render `apply_patch`, `edit`, `write`, and mutating text-editor calls as edit
  cards. Compact mode shows at most twelve colored patch lines; verbose mode shows
  the complete available patch. Malformed inputs retain the generic tool card.
- Insert one blank line between semantic display entries, not between lines within
  a summary, tool card, patch, or Markdown response.

## Implementation

1. Preserve turn ids and timestamps in transcript cells and stamp live event
   actions at the CLI boundary.
2. Add the pure display-layout selector, work metrics, duration formatting, and
   active-turn mutability rule.
3. Add edit-call recognition and patch rendering using the existing workspace
   patch parser; add no diff dependency.
4. Integrate semantic entries with compact/verbose rendering and static
   scrollback.
5. Update focused reducer, layout, cell, app, and terminal tests and synchronize
   interface documentation.

## Non-goals

- Changing engine events, provider adapters, canonical items, or persistence.
- Claiming private model-thinking duration.
- Hiding failures, approvals, edits, or plugin tools.
- Adding a general transcript theme or pluggable renderer.
- Calculating filesystem diffs after execution; edit cards render the mutation
  already present in tool arguments.

## Acceptance

- The normal transcript shows one work summary instead of repeated thought/read/
  search/command rows.
- Live and resumed transcripts produce equivalent grouping and counts.
- Edit patches are legible, colored, bounded in compact mode, and complete in
  verbose mode.
- Active turns never freeze a summary early or duplicate output when finalized or
  when verbose mode is toggled.
- Existing approval, interruption, error, Markdown, footer, and output behavior
  remains intact.
- Focused tests and `npm run check` pass, followed by independent correctness,
  terminal-lifecycle, and simplicity reviews.

## Outcome

- Compact transcripts now render one semantic work summary per turn, preserve
  exceptional tools, and separate conversation blocks with one blank line.
- Supported edit tools render status-aware, bounded colored patches; verbose mode
  retains the complete available patch, and multi-file cards always retain every
  file name.
- Granular reducer cells remain the only presentation state. Layout and edit-card
  data are derived by two pure CLI helpers; no kernel, provider, service, or
  persistence contract changed.
- Repository guidance incorporates the applicable simplicity and convergence
  principles from Sunroom's desktop guidance, per explicit project direction.

## Validation

- Focused CLI suite: 6 files, 64 tests passed.
- Full `npm run check`: typecheck, ESLint, Prettier, and Vitest passed (72 files
  passed, 5 skipped; 576 tests passed, 34 skipped).
- Three independent review lenses covered correctness, terminal behavior, and
  aggressive overengineering/scope discipline. All in-scope findings were fixed;
  the explicitly requested `AGENTS.md` guidance was retained.

## Remaining gaps

- Conversation switching still permits an ordinary active turn to continue, and
  resume does not provide an atomic snapshot/event handoff. This existing
  lifecycle policy is intentionally outside this transcript presentation change.
- The pre-existing `/clear`/Ink `Static` lifecycle issue remains outside scope.
