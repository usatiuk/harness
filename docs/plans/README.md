# Execution plans

This directory contains durable plans for concrete substantial changes. Plans
preserve the intended outcome, grounded design, acceptance criteria, and final
evidence without replacing a product roadmap.

## Placement

Use:

```text
docs/plans/<area>/<YYYY-MM-DD>-<slug>.md
```

Choose the package or domain that owns the outcome. Use `cross-cutting/` when
several packages share ownership and `process/` for repository workflow changes.
Update an existing plan when work continues the same outcome instead of creating
overlapping plans.

## Status

Declare one status near the title:

- `Draft`: research or material decisions remain open.
- `Active`: the plan is decision-complete enough to implement.
- `Complete`: the intended outcome is delivered and actual evidence is recorded.
- `Superseded`: a linked plan or accepted decision replaced it.

Plans remain in the repository after completion or supersession.

## Content

Keep a plan proportional to the work, but include enough to hand it to another
engineer or agent:

- Goal and observable completion condition.
- Grounded current behavior and relevant evidence.
- Chosen approach, invariants, and explicit non-goals.
- Coherent implementation slices and affected boundaries.
- Behavioral tests, failure scenarios, and other validation.
- Documentation impact and unresolved blockers or remaining gaps.

Research with lasting value belongs under `docs/research/`; link it and state the
decision drawn from it instead of copying a research dump into the plan.

For substantial multi-step work using `$ship-change`, create or select the plan
before broad implementation. Small fixes and mechanical changes do not need a
plan merely to satisfy process.
