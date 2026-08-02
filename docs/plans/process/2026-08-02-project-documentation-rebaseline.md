# Rebaseline project architecture and plans

Status: Complete

## Goal

Replace the obsolete root design documents with current, navigable project
documentation modeled on Sunroom's hierarchy. Completion means a contributor can
start at `PLAN.md`, find the owning subsystem, distinguish implemented behavior
from planned work, and follow links to decisions, research, delivery plans,
testing guidance, and deferred limitations without consulting the deleted legacy
design monoliths.

## Grounded problem

- The implementation has moved well beyond the legacy phased roadmap:
  approvals, request middleware, Codex OAuth, SQLite, Docker/native execution,
  activities, subagents, hierarchical instructions, rewind, and compaction all
  exist.
- The former amendment mixes accepted invariants with speculative machinery,
  including compaction composition that the current plugin host intentionally
  does not support.
- Root guidance and documentation indexes still direct contributors to both
  files, so obsolete text can be mistaken for current architecture.
- Existing package code, tests, README behavior, completed delivery plans, and
  the current composition root provide enough evidence to document the system
  without preserving the obsolete monoliths.

## Documentation model

- `PLAN.md`: product goals, non-goals, system overview, current status, subsystem
  index, and high-level checklist.
- `docs/subsystems/<name>/README.md`: accepted current architecture, ownership,
  invariants, source map, and verification for one durable subsystem.
- `docs/subsystems/<name>/PLAN.md`: selected milestones and acceptance for a
  subsystem with active work; no ceremonial plan is required otherwise.
- `docs/plans/`: concrete delivery plans and final evidence; it does not replace
  the product or subsystem roadmaps.
- `docs/decisions/`, `docs/research/`, `docs/TESTING.md`, and
  `docs/DEFERRED.md` retain their existing focused roles.

## Subsystem map

1. Kernel: protocol, engine, plugin host, delivery, middleware composition, and
   service façade.
2. Persistence: append-only conversation graph, turns, context builds, usage,
   provider payloads, plugin state, blobs, SQLite, and crash reconciliation.
3. Models: provider catalogs/adapters, authentication, request/stream mapping,
   payload fidelity, capacity, usage/cost, and model middleware.
4. Execution: workspace tools, execution contexts, sandbox backends, output
   preservation, approval, and auto-approval.
5. Context: context assembly, hierarchical project instructions, cache stability,
   compaction, and rewind interaction.
6. Orchestration: background activities, plugin delivery, and subagents.
7. Interface: settings cascade, auth UX, CLI commands, TUI transcript, resume,
   and runtime controls.
8. Testing: validation commands, contract suites, platform matrices, live tests,
   and remaining evidence gaps.

## Implementation

1. Add the product plan and subsystem index.
2. Add current-architecture documents for all eight subsystems and focused plans
   only where a deliverable is selected.
3. Update repository guidance, README links, documentation roles, testing, and
   deferred-work records to point at the new hierarchy.
4. Mark the earlier repository-workflow plan superseded by this rebaseline while
   preserving it as historical delivery evidence.
5. Delete both legacy root design files; leave no references to them.
6. Validate Markdown formatting, relative links, legacy-reference removal, and
   whitespace; run the independent documentation review loop.

## Non-goals

- Changing runtime code or declaring speculative features implemented.
- Creating one document per package.
- Copying Sunroom's media-specific architecture or its level of detail where
  Harness does not need it.
- Turning every possible future feature into an active milestone.
- Reconstructing historical rationale already absent from accepted code and
  tests; significant future choices should receive focused decision records.

## Acceptance

- The two legacy design files are deleted and unreferenced.
- Every package has a clear owning subsystem without duplicating package docs or
  creating an idle roadmap for every boundary.
- Current behavior and future checklists are visibly separate.
- Provider-owned execution tools, server-side compaction, compaction-strategy
  composition, durable process recovery, polished non-TUI clients, MCP, and LSP
  are not represented as implemented.
- All documentation links resolve and formatting/whitespace checks pass.

## Outcome

- Deleted the two obsolete root design monoliths and replaced them with one
  product plan plus eight current-architecture subsystem documents.
- Kept subsystem plans only for selected work: model reliability, native mutation
  containment, interface diagnostics, and the matching test evidence. Unselected
  LSP/MCP options and conditional future work remain deferred rather than posing
  as active milestones.
- Updated repository guidance, user-facing documentation, testing guidance, and
  deferred-work records to use the new hierarchy.

## Validation

- Typecheck, lint, and `npm run format:check` passed through `npm run check`.
- `npm run test`: 561 passed and 34 skipped. The restricted launch first failed
  with `spawn EPERM`; rerunning the same suite with process-spawn permission
  passed.
- `git diff --check`
- Local Markdown link scan across repository-owned documentation
- Legacy design-document reference scan
- Independent correctness, architecture/navigation, and simplicity reviews,
  followed by targeted re-review after every actionable finding was resolved
