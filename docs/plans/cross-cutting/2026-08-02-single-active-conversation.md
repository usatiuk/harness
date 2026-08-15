# Single active conversation lifecycle

**Status:** Complete

## Goal

The TUI owns one active root conversation and its subagent conversation tree.
Switching or reloading tears that tree down before the next activation, so
conversation-local configuration, instructions, activities, and execution state
cannot leak across activations. Durable history and process-wide provider/auth
composition remain intact.

Completion means the current conversation can be reloaded by id, sandbox changes
apply through that reload without restarting Harness, and no previous runtime,
activity manager, subagent index, or Docker container survives a completed
transition.

## Grounded current behavior

- `Engine` retains every loaded `Runtime` and its lazily cached services for the
  process lifetime; it has no unload operation or service disposal contract.
- The TUI prepares a resume target before deciding whether the current session
  may be left, and the same conversation id does not remount `App`.
- Activities and subagent registries retain additional process-global
  conversation state. Docker owns an explicit asynchronous teardown operation.
- Sandbox configuration is persisted while the cached execution context remains
  active, so the TUI requires a process restart to observe the change.

## Chosen design

- The TUI prepares only one top-level conversation; its engine may also load that
  root's descendants. A session deactivation closes and removes the complete
  loaded set rather than attempting partial tree eviction.
- Add one optional asynchronous disposer to `ServiceProvider`. Runtime services
  remain memoized within an activation because tools and clients must share the
  same instance; the entire map is discarded on deactivation.
- Deactivation atomically refuses an active/queued root unless forced for process
  shutdown. Once accepted, it rejects new work for the closing root scope, clears
  inboxes, aborts turns, awaits quiescence, disposes services in dependency-safe
  reverse registration order, and clears runtime caches. All disposers run, but
  any cleanup failure rejects the transition after in-memory state is cleared.
- Activity managers become runtime-owned and dispose by suppressing completion
  delivery, killing live activities, and awaiting settlement. Docker disposal
  stops/removes its container. The subagent registry is cleared after the tree
  is deactivated.
- The TUI transitions by target id: confirm when any conversation-tree activity is
  live, persist an optional sandbox config mutation while attached, deactivate the
  source, and only then load/prepare the target. An activation generation remounts
  the same id.
- `/reload` reactivates the current id. Sandbox setting changes use the same path
  automatically and are not persisted when the root turn is active.

## Non-goals

- Rebuilding providers, authentication, the plugin host, or the database on each
  activation.
- Supporting multiple independent top-level sessions in one TUI process.
- Durable or resumable activities, generic lifecycle phases, or a general
  session-management framework.
- Changing ordinary model, approval, or sandbox rebuild/stop behavior beyond the
  activation boundary.

## Validation

- Core/service tests cover busy refusal, forced teardown, child cancellation,
  queued-input discard, disposal ordering/failure, and fresh services after a
  same-id reload.
- Activity and sandbox tests cover awaited shutdown, suppressed completion
  delivery, and Docker removal.
- CLI tests cover no target preloading, background-work confirmation, active-turn
  refusal, same-id remount, and immediate sandbox application.
- Update kernel, interface, execution, and orchestration architecture truth; run
  focused tests and `npm run check`.
- Complete independent correctness, evidence, and explicit
  simplicity/anti-overengineering review before marking complete.

## Delivery evidence

- `Engine.deactivate` now owns the atomic root-scope boundary: it refuses a busy root
  unless forced, blocks new work while closing, aborts and awaits every loaded
  runtime, runs service disposers in reverse provider order, and clears caches
  even when cleanup reports an error.
- Activities, one-shot shell commands, Docker contexts, and the activation-local
  subagent index now end at the same boundary. Docker disposal is terminal, so a
  concurrent rebuild cannot recreate a disposed container.
- `/reload`, resume, and sandbox changes share one serialized TUI transition.
  Focused tests directly prove same-id remount and the sandbox order
  mutate → deactivate → prepare.
- Architecture and user documentation describe the implemented lifecycle and no
  longer instruct users to restart Harness for sandbox configuration changes.
- Independent correctness and simplicity reviewers found no remaining concrete
  issue. The evidence reviewer's final two gaps—direct ordering/remount coverage
  and nested error formatting—were fixed and rechecked.
- `npm run check` passes: typecheck, lint, formatting, 72 test files passing and
  5 skipped; 590 tests passing and 34 skipped.
