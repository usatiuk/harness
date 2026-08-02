---
name: ship-change
description: Ship substantial Harness changes through grounded research, durable planning, coherent implementation, validation, documentation, independent review, reassessment, and clean handoff. Use for risky, architectural, cross-package, or multi-step work; scale the workflow down for trivial or mechanical edits.
---

# Ship Change

Repository instructions, user intent, and sound judgment take precedence over
this workflow. Use the parts that improve confidence; do not manufacture process
work.

## Workflow

1. **Ground the work.** Inspect current behavior, relevant code, tests,
   documentation, package boundaries, worktree state, and pinned dependencies.
   Research primary sources or production implementations when the result could
   materially change the design.
2. **Plan proportionally.** For substantial multi-step work, create or select a
   durable plan under `docs/plans/` and make it decision-complete before broad
   implementation. Tiny, obvious, or mechanical changes may use a short in-chat
   plan or no explicit plan.
3. **Implement coherently.** Use the strongest existing boundary, keep ownership
   narrow, preserve the repository's one-directional package layering, remove
   superseded code, and leave unrelated worktree changes untouched.
4. **Validate and document.** Exercise observable behavior at the highest useful
   boundary. Add meaningful regressions and synchronize the appropriate project
   truth described in `docs/README.md`.
5. **Review proportionally.** Self-review every diff. Use the independent review
   loop below when scope, risk, uncertainty, or recurring failures warrant it.
6. **Reassess.** Treat recurring findings as evidence of a weak boundary. Simplify
   or redesign instead of stacking guards and patches.
7. **Finish cleanly.** Rerun affected checks, inspect the final diff and status,
   update durable plans with actual evidence, and hand off concisely. Commit,
   push, deploy, or publish only when explicitly authorized.

## Durable plans

Follow `docs/plans/README.md`. Keep plans focused on a concrete outcome, not a
restatement of the repository roadmap. Record the final behavior, validation,
remaining gaps, and resulting commits or links when useful.

## Independent review

When independent review materially improves confidence:

- Use at least three read-only reviewer agents with distinct lenses when agent
  capacity permits.
- Cover behavior/correctness, architecture/failure risk, and
  tests/evidence/documentation/scope.
- Always include an explicit simplicity and anti-overengineering lens. Challenge
  speculative abstractions, duplicate state, unnecessary ordering machinery,
  custom low-level ownership, and fallbacks for impossible internal states while
  preserving demonstrated correctness, resource lifetime, protocol, and recovery
  requirements.
- Give reviewers raw artifacts without steering their conclusions. Self-review
  does not count as an independent lens.
- Before editing for review findings, tell the user which findings will be fixed,
  deferred, or rejected.
- Resolve findings with evidence. Repeat review after substantive review-driven
  changes only when it adds useful confidence; bookkeeping alone does not start
  another loop.

## Harness validation

- Run focused Vitest targets while iterating.
- Run `npm run check` before finishing code changes unless the environment makes
  a specific step impossible; report any omitted validation precisely.
- For documentation-only work, run Prettier on the affected files and
  `git diff --check`. Run broader checks when links, generated content, scripts,
  configuration, or code are affected.
- Preserve exact provider payload, cancellation, usage-accounting, persistence,
  and cross-platform execution semantics when those paths are touched.
