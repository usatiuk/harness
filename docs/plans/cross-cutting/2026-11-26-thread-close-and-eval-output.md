# Thread closure and eval output

Status: Complete.

Subagent kill used to interrupt one turn: queued sibling messages and nested
background completions could wake the child after its original activity settled.
Dismiss hid the branch without stopping it. Separately, nested text-only tool
results passed through the same file preview as direct calls before JavaScript
could process them, while eval rejected large final output before it could spill.

- [x] Close a thread and its descendants durably before stopping their work. Wire
      kill and dismiss to the same operation; keep ordinary turn interruption,
      ordinary process termination and unrelated conversations unchanged. Verify
      delayed delivery, resumed children, restart, and sibling isolation.
- [x] Skip file previews on nested tool calls only. A focused real-evaluator
      service test selects the last line of a 42 KB text-only tool response
      and verifies the unselected text is absent from the next model request.
- [x] Remove eval's text display limit; use bounded buffering and the ordinary
      output store for large text. Verify large returns and repeated emissions,
      including errors and cancellation; preserve separate image and bridge limits.
- [x] Review behavior, lifecycle/simplicity, and evidence independently; resolve
      findings, synchronize subsystem and testing docs, and run `npm run check`.
- [x] Commit validated changes, push to the confirmed branch, and verify the
      patch release workflow and its published assets.

Closure verification includes the model tool and public activities RPC, queued
sibling input, a late grandchild completion, and direct read-only attachment.
Both store implementations and the SQLite upgrade suite passed, including
backfilling already-dismissed branches. The obsolete plugin descendant index
was removed. Three independent review lenses covered lifecycle, output bounds,
and requirements; the review-driven fixes passed focused and full validation.

Evaluator regressions cover full text with and without workspace execution,
bounded history/events, preserved output on a guest error and after interruption,
and exactly one complete spill file. Real Windows filesystem tests reject
pre-existing junctions or linked artifacts. Concurrent replacement of path
components is a separate limitation recorded in `docs/DEFERRED.md`.

The startup screen uses the desktop's shared disclosure control. A rendered
Playwright/Edge check covered the initially collapsed startup details, initially
expanded timeout controls, and mouse and keyboard toggles. No new control or
native installer interaction was needed.

The initial Windows full check passed 2,144 tests (83 skipped). Hosted Windows
exposed equivalent short/long temp paths in spill tests: assertions now check
file identity and bytes through the emitted reference. The first release and
x64 Linux CI timed out in different Docker glob tests that create empty files.
A Linux x64 probe reproduced an interactive empty write stuck in `cat`, then
completed 512/512 noninteractive empty writes and 512/512 unchanged one-byte
writes. The focused real-Docker suite passed all 12 tests. Neither test timeouts
nor retries changed. Release qualification uses a fresh dispatch from `main`.

The final Windows `npm run check` passed (2,145 tests, 83 skipped).
[Hosted source CI](https://github.com/usatiuk/harness/actions/runs/45911723662)
passed on all three runners. The [release workflow](https://github.com/usatiuk/harness/actions/runs/45911723280)
built all four platform targets. The signed manifest and artifact sizes/hashes
were verified against the draft before [v0.13.1](https://github.com/usatiuk/harness/releases/tag/v0.13.1)
was published as latest with 24 assets.
