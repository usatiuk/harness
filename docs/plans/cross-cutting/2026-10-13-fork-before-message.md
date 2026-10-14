# Fork before a user message

Status: Complete. Validated, committed, pushed and published in v0.1.16.

## Goal

Desktop and TUI can fork before a selected canonical user message, open an
independent conversation and preload that message as an editable draft. The source
continues untouched. Shared history keeps original immutable item IDs and payloads.

## Design

- One attached-source RPC accepts conversation ID and user item ID. The store
  atomically validates item existence/user role and creates the fork at the user's
  parent (possibly null). Record fork provenance separately from runtime children.
- Snapshot model/preset, instructions, effective tool scope/mode and conversation-
  scoped plugin configuration into existing overrides. Global-only configuration,
  credentials and the global compaction preference remain host-owned. No plugin
  state, active turns, activities, approval requests or usage is copied.
- Item lookup is global by ID. Parent walks cross conversation ownership without
  membership/access checks. Head updates require an existing item. Physical owner
  IDs remain provenance and local accounting, not read permissions. Fork validates
  existence/user role only, not source ownership or active-branch membership.
- Active history follows parent links, ordered by traversal position, not physical
  owner-local seq. Raw local log access is explicitly named listOwnedItems. Existing
  bounded ancestor pages and item-range reads hydrate the draft without copying
  history or adding a membership table, registry or cache.
- Audit seq-based consumers, naming, crash reconciliation, context/provider payloads,
  reducers and runtime root ownership. Supported steers flush after complete tool
  dispatch; don't add speculative repair-turn machinery. Fail inconsistent inherited
  tool histories rather than mutate source turns or invent recovery identities.
- Desktop has a quiet user-message action. TUI `/fork` opens a user-message picker.
  Both use the ordinary client boundary and draft storage; forking never sends text,
  changes global defaults or overwrites an existing source draft.

## Milestones

- [x] Store/history boundary: ancestry access, atomic fork, schema upgrade and shared suite.
      Check: first-message, later, nested, rewind, source continuation, global ID reads,
      ordered mixed-owner ancestry, bounded pages and SQLite restart/migration tests.
- [x] Core/service/RPC: effective config capture, independent lifecycle, safe inherited
      context and usage. Check: real RPC, live source, compaction, opaque payload/blob
      retention, missing/non-user targets, stable cursors and fresh accounting.
- [x] GUI/TUI: open fork with editable draft, controls and failure feedback.
      Check: source remains open/running, draft not sent or lost, first send attaches
      to prefix, browser and isolated TUI regressions.
- [x] Documentation, full check, three independent correctness/simplicity/evidence
      reviews and final reassessment. Required findings stay open until verified.

## Limits

No editing stored messages, version arrows, sibling counts, branch manager,
filesystem undo, inherited execution ownership, automatic replay or new preference
store. Fork creation writes one conversation record; history pages follow existing
parent links and remain bounded. No inherited-prefix reconstruction at creation. Existing configuration
cascade remains in use after the initial conversation-scoped snapshot.

## Validation evidence

- Shared store tests cover first/later/nested forks, owner-independent lookup and
  head movement, ordered paging, source continuation/rewind and fresh accounting.
- SQLite covers upgrade from schema 8 and restart with no copied owned items.
- Real RPC tests cover draft hydration, original payload/blob retention, runtime
  independence, forks before steered input, resolved settings/plugin scope and
  independent inherited compaction. Latest focused RPC run: 23 passed.
- TUI picker/draft and reducer/core regressions: 186 passed.
- Affected isolated browser regressions: 6 passed (fork draft/source preservation,
  composer acceptance/rejection, collapsed history, reasoning/tool grouping and
  flat eval boundaries). The initial new test failures were incorrect fixture
  readiness/setup and were corrected against actual prerequisites.
- Three independent read-only reviews completed. Review found bare provider-call
  IDs could collide across physical owners; canonical pairing now includes existing
  provenance, and provider wire IDs/payloads remain unchanged. Regression tests
  cover display, recovery and provider request mapping. No membership machinery.
- Full `npm run check` passed: typecheck, lint, formatting, 1,373 tests passed and
  38 skipped. Final focused TUI lifecycle/composer checks: 64 passed. Full validation
  exposed an overlay transition retaining submitted command text in draft storage;
  composer reset now publishes the cleared draft synchronously before its effect
  can be lost on unmount. The original lifecycle regression passes.
- Native desktop and live-provider execution were not exercised. No credential
  store or normal dev profile was used by the test fixtures. Release delivery uses the existing workflow.

## Message action follow-up

User requested small action bars below messages, visible on hover/focus: Fork for
user messages and Copy for completed assistant messages. User bubbles retain their
text width; icons reserve a 20px row outside the bubble. Clipboard success/error
feedback is local and resets after 750ms; icons use a 4px corner radius. Browser
regression covers layout, visibility, keyboard focus, copied text and feedback reset.
Final affected browser run: 3 passed. Full `npm run check` passed again: 1,373 tests
passed, 38 skipped, plus typecheck/lint/formatting. Screenshot inspected.

The existing typography regression twice observed empty computed styles during
initial validation; subsequent runs with an explicit connected-node assertion
passed. The cause remains unestablished; no timeouts or assertions were weakened.

## Release delivery

Feature commit `551d8c3` and the earlier reasoning/discovery commit were pushed.
The first release run stopped during validation before bumping the version:
a Docker glob test exceeded its existing 5s deadline, and the background reconnect
test raced interrupt acceptance against actual turn completion. The latter now
subscribes before Stop and waits for the terminal event before requesting upgrade.
Focused real-process/container regressions pass (25 tests); Docker was unchanged,
and its CI timeout has not reproduced locally. No timeout increases or test retries
were introduced. Full validation passed again (1,373 tests, 38 skipped).

The follow-up fix is `04e4c36`. Release run
[38478708925](https://github.com/usatiuk/harness/actions/runs/38478708925) passed
checks, all three platform builds and release metadata verification. Version-bump
commit `1110fa4` is tagged `v0.1.16`; the [release](https://github.com/usatiuk/harness/releases/tag/v0.1.16)
is published as latest with 19 assets. Platform publisher signing remains
unconfigured; update metadata and desktop updater artifacts carry signatures.
