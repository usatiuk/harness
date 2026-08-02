# Project documentation

This directory stores durable project knowledge that does not belong in source
comments or the root getting-started documentation.

## Sources of truth

- `README.md`: setup, commands, supported environments, and user-facing behavior.
- `PLAN.md`: product goals, scope, subsystem index, current progress, and
  high-level priorities.
- `docs/subsystems/*/README.md`: accepted current architecture and behavior.
- `docs/subsystems/*/PLAN.md`: selected subsystem milestones and acceptance; a
  subsystem without active work does not need one.
- Public types, implementation, and executable tests: current behavior.
- `docs/decisions/`: accepted architectural choices and their consequences.
- `docs/research/`: evidence, experiments, alternatives, and unresolved findings;
  research is not accepted architecture by itself.
- `docs/plans/`: durable execution plans and delivery evidence for concrete,
  substantial changes.
- `docs/TESTING.md`: validation commands, test boundaries, and coverage policy.
- `docs/DEFERRED.md`: known work intentionally left outside current scope.

When these sources drift materially, reconcile them as part of the change. Link
to existing truth instead of copying it into multiple files.

## Navigation

- [Product plan and subsystem index](../PLAN.md)
- [Testing](TESTING.md)
- [Deferred work](DEFERRED.md)
- [Architecture decisions](decisions/README.md)
- [Research notes](research/README.md)
- [Execution plans](plans/README.md)

## Proportional documentation

Record information when it will help future implementation, review, recovery, or
decision-making. Do not create empty subsystem documents, speculative roadmaps,
or process artifacts for small obvious changes.
