# Improve transcript UX

Status: Complete

## Goal

Make compact transcripts read as chronological work stages without transient
tool-card flicker. Consecutive reads and searches remain one mutable `Working…`
tree until another semantic block begins, then visually close as `Explored` and
freeze once their calls settle. Reasoning streams while active and settles as a
compact timed thought; narration, commands, edits, approvals, and failures remain
explicit and ordered.

## Baseline before this change

- Granular reducer cells and the pure transcript layout already preserve provider
  emission order, including assistant narration before and between tool calls.
- Compact mode derives one turn-wide `WorkSummary`. A running read/search first
  renders as a tool card, then disappears into that summary on success, causing a
  visible flash.
- Keeping the complete active turn mutable prevents early freezing, but also
  prevents already final chronological blocks from entering scrollback.

## Chosen design

- Derive consecutive exploration stages from canonical cells. `read_file` and
  read-only editor views become `Read` children; glob/search tools become `Search`
  children. Preserve duplicates and emission order.
- The trailing exploration stage is `Working…` while its turn is active. Tool
  completion updates the same child and does not close the stage. Narration,
  reasoning, commands, edits, approvals, failures, plugin/context output, user
  input, or terminal turn status visually closes it as `Explored`; later
  exploration starts a new stage. A visually closed stage remains mutable until
  every child settles, because a later approval or failure must restore that call
  as an explicit card.
- Failed or approval-bearing exploration calls remain explicit cards and split
  surrounding exploration stages. Commands always remain separate explicit
  cards.
- Stream full dimmed reasoning while mutable. At its semantic boundary, compact
  it to `Thought for …` when this TUI observed live timing, or honest `Thought`
  when reconstructing a durable item. Verbose mode retains raw reasoning and raw
  tool cards without duplicating compact stage entries.
- Publish every finalized prefix to Ink `Static`. Only the mutable suffix remains
  live. Reserve the leading active exploration header when its children overflow;
  a later stage remains inline so its header stays chronologically attached to its
  children. Show a generic `Working…` only when a running turn has emitted no other
  live presentation.
- Keep the model/status row stable; it no longer owns the busy spinner. Add no
  timers, debounce state, persistence, or kernel/provider changes.

## Implementation

1. Replace the turn-wide accumulator and formatter with exploration/thought stage
   entries and compact tree renderers.
2. Mark entries live only while their presentation can still change, allowing
   completed stages and narration to advance into static scrollback incrementally.
3. Integrate the active exploration header with the bounded live viewport and
   preserve existing composer, overlay, edit-card, and verbose behavior.
4. Update layout, app, cell, resume, and real-terminal overflow regressions, then
   synchronize interface documentation.

## Non-goals

- Changing model events, engine dispatch, provider adapters, canonical items, or
  persistence.
- Grouping commands, edits, failures, approvals, or unfamiliar plugin tools.
- Delaying tool presentation with timers or retaining a redundant turn-wide
  `Worked` aggregate.
- Reworking the broader theme, composer, Markdown renderer, or `/clear` lifecycle.

## Acceptance

- A fast read/search appears once as a stable tree child and never flashes as a
  temporary tool card.
- Consecutive exploration extends one block; any semantic boundary closes it
  visually and later exploration creates another block in chronological order.
- Narration between calls remains visible between the corresponding stages;
  commands remain separate cards.
- Reasoning is visible while streaming and settles as `Thought for …` when timing
  was observed, or `Thought` when resumed without timing data.
- A leading `Working…` exploration header remains visible in a genuinely
  overflowing terminal viewport while its body clips beneath it.
- Live and resumed cells derive equivalent completed stages; focused tests and
  `npm run check` pass, followed by correctness, evidence, and explicit
  simplicity/anti-overengineering review.

## Prior delivery evidence

- The original transcript pass delivered semantic spacing, bounded colored edit
  patches, verbose rendering, and the pure cell-to-layout boundary.
- Its full validation passed 72 test files with 576 tests, plus independent
  correctness, terminal, and simplicity review. This refinement preserves those
  behaviors while replacing only the turn-wide work aggregation.

## Delivery evidence

- Replaced the turn-wide aggregate with a pure chronological stage derivation;
  persisted items remain unchanged. The reducer adds only a live reasoning-timing
  marker and human approval progress needed by the presentation.
- Added compact tree/thought rendering, incremental Static publication, a stable
  status row, and bounded leading-stage overflow behavior without timers or new
  persisted presentation state.
- Focused transcript validation passes 5 files with 70 tests, including live and
  resumed stages, narration and command ordering, approval splitting, reasoning
  settlement, fast-read stability, and real xterm overflow/scrollback behavior.
- `npm run check` passes typecheck, lint, formatting, and 72 test files with 596
  tests (5 files and 34 tests skipped by their existing environment gates).
- Independent correctness, terminal-evidence, and simplicity reviews found two
  actionable cases: human approval correlation and chronology when older calls
  remain mutable. Both were fixed and re-reviewed. The final simplicity pass also
  rejected a global later-stage header because it detached the label from its
  children; the implementation keeps that stage inline instead.
