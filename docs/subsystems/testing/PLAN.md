# Testing subsystem plan

## Objective

Grow evidence with implemented behavior, especially at cancellation, persistence,
provider, execution, and terminal boundaries. Do not build a general scenario
laboratory ahead of scenarios.

## Milestone 1: model reliability evidence

- [ ] Define table-driven retryable/non-retryable provider failures at adapter
      boundaries.
- [ ] Prove retry occurs only before the first yielded event and is bounded.
- [ ] Prove cancellation interrupts both an active attempt and backoff.
- [ ] Prove agent, compaction, subagent, and auto-approval calls share the model
      middleware behavior.
- [ ] Prove failed attempts do not create completed usage rows or duplicate
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
