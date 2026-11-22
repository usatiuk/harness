# Interruptible conversation wait

Status: Complete

- [x] Offer a scoped direct wait in both tool modes. Check timeout, steering, queued input and cancellation.
- [x] Retire explicit activity waits and competing result ownership. Verify foreground collection and one-shot background completion.
- [x] Verify evaluator and service behavior, update subsystem guidance and run repository validation.

Each successful direct call acknowledges its request. After sibling calls, context writes and any scheduled workspace switch finish, the engine pauses once for the shortest requested timeout. A queued follow-up stays deferred. Pending or arriving steering uses normal inbox delivery. The foreground activity consumer still owns the ten-second handoff and cancellation.

Windows validation passed 279 tests across eight affected suites. The workspace switch regression observes the new path in the input hook and the next model request. On the isolated change, typecheck, lint and formatting passed. The default Vitest run had 2,119 passes, 83 skips and nine five-second timeouts in the Windows background-release and worktree changes suites. Both suites then passed serially (16 passed, two skipped) with the original timeouts.
