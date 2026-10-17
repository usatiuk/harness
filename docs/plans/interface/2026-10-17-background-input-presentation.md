# Background input presentation

Status: Complete

## Outcome and design

Provider activity hints and plugin-delivered input belong with tools and thinking
in desktop Working groups. Only human input appears as a user message. Pending
background input collapses into an inspectable count beside ordinary human input.

Reuse `DeliverySource`: carry it through inbox snapshots and persist it on user-role
items. Model-facing roles/content and queue/steer/interrupt behavior stay unchanged.
Existing history without source retains its prior appearance; do not infer origin
from message text. SQLite already stores item bodies as JSON, so no migration or
new storage is needed. The public wire contract and its version must stay aligned.
The TUI uses the same provenance to distinguish background input from human text.

## Milestones and completion checks

- [x] Preserve origin across acceptance, inbox events/attachment, persisted turns,
      steering, RPC and reload. Verify with real engine/RPC and SQLite tests.
- [x] Group web-search hints and background input into existing desktop steps;
      collapse pending background messages with inspectable content. Verify row
      grouping, queue presentation and unchanged human messages in browser tests.
- [x] Update documentation and generated schema, run focused tests and full
      `npm run check`, and independently review correctness, simplicity and evidence.

## Validation

- Focused protocol, engine, RPC, SQLite, reducer, desktop transcript and TUI
  rendering checks: 279 tests pass.
- Four production-composer browser cases pass, including background work grouping
  and the expandable background queue beside visible human input.
- Full browser suite: 62 pass, one existing scroll-anchor case fails the 1.5px
  tolerance. The same failure reproduces in an archived HEAD desktop snapshot
  with unchanged dependencies. Root cause remains open; no assertions, timeouts
  or product scroll behavior were changed.
- The normal full check passes typecheck, lint and formatting; 1,451 tests pass,
  41 skip, and one unrelated worktree test fails because `/tmp/.git` is an empty
  directory. That test passes using `TMPDIR=/var/tmp`. The full
  `TMPDIR=/var/tmp npm run check` passes: 1,452 tests, 41 skips, plus typecheck,
  lint and formatting. The wire contract and generated schema use protocol 14.
- Three independent read-only reviews report no material findings. Their minor
  evidence/presentation suggestions are addressed by checking actual model-request
  role/content, exposing TUI queued text in verbose mode and singular/plural labels.

Native desktop and live-provider testing are outside this presentation change;
browser tests exercise production components with controlled data edges. Old
messages without recorded origin cannot be reclassified reliably and retain
their prior display.
