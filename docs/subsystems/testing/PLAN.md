# Testing subsystem plan

## Objective

Grow evidence with implemented behavior, especially at cancellation, persistence,
provider, execution, and terminal boundaries. Do not build a general scenario
laboratory ahead of scenarios.

## CI recovery

The [CI and local test recovery plan](../../plans/process/2026-10-16-ci-and-local-test-recovery.md)
is complete: local checks and both Ubuntu/Windows CI jobs pass after correcting
platform fixtures, OAuth project isolation and QuickJS scheduler overhead. Native
macOS qualification remains open; the plan records exact evidence and limits.

## Milestone 1: model reliability evidence

Delivered alongside the
[model retry middleware delivery plan](../../plans/models/2026-10-18-model-retry-middleware.md):
table-driven adapter classification fixtures, middleware bounds/cancellation
tests, engine call-site tests (agent and compaction purposes, usage `attempts`),
and an end-to-end service test for wire visibility.

- [x] Define table-driven retryable/non-retryable provider failures at adapter
      boundaries.
- [x] Prove retry occurs only before the first yielded event and is bounded.
- [x] Prove cancellation interrupts both an active attempt and backoff.
- [x] Prove agent and compaction calls traverse the model middleware with
      identical retry semantics; subagent and auto-approval calls share the
      same `#streamModel` seam by construction (no separate engine test).
- [x] Prove failed attempts do not create completed usage rows or duplicate
      canonical model output.

## Milestone 2: execution/security evidence

- [ ] Add adversarial native path replacement coverage with in-boundary mutations.

## Deliberately deferred

- Coverage-percentage targets detached from behavioral risk.
- Fixed-sleep concurrency tests.
- Mandatory live-provider calls in ordinary CI.
- MCP, LSP, and client integration fixtures until their owning feature exists.
- Packaged-install smoke coverage before Harness has a distribution artifact.
- macOS CI before macOS becomes a supported execution target.
- A custom distributed test harness.
- Platform claims based only on mocked operating-system behavior.
