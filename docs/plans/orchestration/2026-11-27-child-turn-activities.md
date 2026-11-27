# Child turn activities

Status: Complete.

Message delivery acknowledges acceptance. A steer can join the current turn;
pending input left when a turn finishes starts a new one. Activity tracking
belongs to the receiver's turn, not the sender.

Each child turn's final answer is its activity result, delivered automatically
to its direct parent through ordinary activity completion. Only peek is clipped.

- [x] Register child runs in their direct parent's ordinary activity manager,
      including later turns and after reload. Spawn returns only the new child's
      identity; neither spawn nor send waits for a result or registers an activity.
      The focused service, server, desktop, subagent, guidance and activity
      suites passed (79 tests).
- [x] Use ordinary activity kill for the tool and RPC. A settled ID cannot
      interrupt a successor. Dismissal alone closes a child and its descendants.
      Focused activities and engine suites: 182 tests passed.
- [x] Service and RPC tests verify steering, queued and idle wakes, ownership,
      reload, dismissal, and delivery of the untruncated answer. Independent
      reviews covered correctness, tests, scope and plugin boundaries. Full
      Windows `npm run check` passed: typecheck, lint, formatting, 2,151 tests
      passed, 83 skipped.

## Review and compatibility

The activities package does not import subagents or look up a thread closer.
The kernel exposes turn start without knowing which plugin tracks it; only
subagents maps a child turn to its parent's manager. Launch and send use
ordinary admission, not a run receipt. Process foreground/background handling
and activity retention remain in the activities package.

Dismissal still seals the branch before marking it hidden. A crash between
those existing writes can leave it stopped but visible until dismissal is
retried. Do not hide every closed branch as a workaround: earlier releases
intentionally retained explicitly stopped children on the roster. If stronger
crash guarantees are needed for hiding, make dismissal atomic while preserving
that historical distinction.
