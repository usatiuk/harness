# Project documentation

This directory stores durable project knowledge that does not belong in source
comments or the root getting-started documentation.

## Sources of truth

- `README.md`: setup, commands, supported environments, and user-facing behavior.
- `DESIGN.md` and `DESIGN-AMENDMENT.md`: architectural intent and historical
  rationale. Update or supersede them when accepted architecture changes.
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

## Proportional documentation

Record information when it will help future implementation, review, recovery, or
decision-making. Do not create empty subsystem documents, speculative roadmaps,
or process artifacts for small obvious changes.
