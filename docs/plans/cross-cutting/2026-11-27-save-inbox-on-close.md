# Save conversation input on orderly close

An orderly close stops work, not history. Fence the whole shutdown group before
interrupting it. Keep its inboxes available to in-flight producers until they
finish; then save the remaining inputs in order, without scheduling inference.
Explicit cancellation, permanent dismissal, and process crashes are separate
contracts. Do not add a second queue or recover unacknowledged messages.

- [x] Represent between-turn input in canonical history (wire, stores, existing
      SQLite databases, transcript, and first model request).
- [x] Stop the group before aborting RPCs and turns; join producers before the
      last writes. Keep permanent dismissal and explicit interruption distinct.
- [x] Prove sibling delivery, ordering, cancellation, exactly-once visibility,
      and no inference during shutdown/reopen, using a fresh SQLite connection.
- [x] Review lifetime boundaries and simplifications, synchronize subsystem
      docs, and pass `npm run check`.

Independent reviews exercised cancellation inside an input hook, shutdown at
the first child turn's start, overlapping dismissal, and a failed final write.
Regression tests verify that retry writes only the remaining entries and that
a partially saved child cannot be reopened or adopted first. The SQLite
reopen scenario checks history order and the next model request, not just the
in-memory inbox. Full Windows validation passed: typecheck, lint, formatting,
2,165 tests passed, 83 skipped.
