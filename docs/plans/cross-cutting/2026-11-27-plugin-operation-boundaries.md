# One owner for each plugin operation

- [x] Delivery owns admission. Forward RPC cancellation before admission; do not
      turn an operation's successful return into cancellation. Audit callers and
      verify both sides of admission through RPC.
- [x] Turn start reports the conversation and turn. Put live scope lookup on
      the injected runner only. Verify an acquired handle cannot act on a
      replacement activation and that a fresh lookup works.
- [x] Expose one checked spawn operation. Route the tool and direct callers
      through the same catalog, limits, parent-local lock and slug checks;
      exercise concurrent callers competing for one slot.
- [x] Reconcile owning docs, review lifetimes and obsolete paths independently,
      and run `npm run check` on the integrated checkout.

Peer and RPC suites: 52 tests passed, including both sides of delivery admission
and cancellation of provisional attachment. Application API: 11 passed; MCP and
feedback HTTP: 3 passed on Windows loopback.
The original forced-close reproduction was repeated with three independent
file-backed SQLite databases. All three sends returned success; after closing
and reopening the database and RPC stack, history contained exactly one copy.

The core engine and shutdown suites passed (170 tests), including stale handle
delivery and event suppression. Independent review also reproduced three edges
under integration: a restored grandchild stopping before its direct parent
loads, a cancelled spawn waiting behind another caller, and a partial spawn mark
when a slug write fails. Targeted regressions now pass: prepare the restored
owners, cancel only the queued caller’s wait, and atomically publish the child
and both metadata entries. The lock ends at publication, not task delivery.
The mixed direct/tool race admits exactly one caller to the last slot.

The shared store contract also verifies that ordinary draft cleanup preserves
published children, while a failed registration can remove its own empty child
and matching index. Independent reviewers rechecked the integrated cancellation,
activation, publication, cleanup and test boundaries; no blockers remained.

Full Windows `npm run check` passed: typecheck, ESLint, Prettier, and 2,174
tests passed (83 skipped). `git diff --check` passed. A separate
[direct-attachment follow-up](../../DEFERRED.md#restore-a-childs-recorded-parent-on-direct-attachment)
tracks restoring generic children from their recorded parent.
