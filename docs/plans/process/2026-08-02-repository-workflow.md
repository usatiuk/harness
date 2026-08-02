# Port durable repository workflow

Status: Complete

## Goal

Adapt Sunroom's useful repository guidance, documentation roles, and
research-plan-implement-review workflow to Harness without importing media-player
assumptions or creating empty process structure.

## Grounded state

- Harness has working npm scripts, CI, root design documents, and extensive
  co-located tests.
- It has no tracked repository guidance, durable documentation taxonomy, or
  repository-local workflow skill.
- Sunroom's reusable pieces are its concise engineering principles, explicit
  document roles, durable execution-plan convention, and proportional
  `ship-change` skill. Its Qt, media, platform, and IDE configuration are not
  applicable.

## Decisions

- Add one root `AGENTS.md` tailored to Harness's TypeScript package layering and
  model/tool/provider invariants.
- Keep existing root design documents in place and define their role rather than
  moving or duplicating them.
- Add only useful documentation indexes plus testing and deferred-work records;
  do not create empty per-package documents.
- Port `ship-change` as a repository-local skill and adapt its validation guidance
  to `npm run check`.
- Keep independent multi-lens review proportional to risk, with an explicit
  simplicity lens when it is used.
- Do not import Sunroom's CLion MCP configuration, product plans, decisions,
  research, or subsystem documentation.

## Implementation

1. Add repository guidance and document roles.
2. Add testing, decisions, research, plans, and deferred-work conventions.
3. Initialize and adapt the local `ship-change` skill and UI metadata.
4. Validate the skill, formatting, links, and final diff.

## Acceptance and validation

- Guidance describes Harness rather than Sunroom.
- Existing design documents and npm workflows remain authoritative and linked.
- The skill is discoverable, valid, concise, and does not grant publishing
  authority.
- Documentation roles do not overlap or require ceremony for small changes.
- Skill validation, Prettier, link/path checks, and `git diff --check` pass.

## Non-goals

- Reorganizing existing source or design documents.
- Adding CI, package documentation, or generic templates without a present need.
- Copying Sunroom's domain-specific history.

## Outcome

Harness now has repository-specific engineering guidance, explicit durable
documentation roles, and a local `ship-change` skill. The existing root design
documents remain in place and are linked from both the repository README and the
documentation map. No Sunroom product, platform, IDE, research, or decision
content was copied.

## Validation performed

- The skill-creator `quick_validate.py` validator passed.
- Prettier passed for the README, repository guidance, documentation tree, and
  skill files.
- All referenced repository paths exist.
- Whitespace checks passed for tracked and new files.
- `npm run typecheck`, `npm run lint`, and `npm run format:check` passed.
- Vitest passed: 525 tests, with 33 skipped. The first sandboxed test launch was
  denied permission to spawn Vite's Windows helper; the authorized rerun passed.

## Remaining gaps

None. Per-package documentation should be added only when a package has durable
architecture or operational knowledge that is not already clear from its public
types and tests.
