# Harness repository guidance

Harness is a local-first, model- and provider-agnostic agent harness implemented
as a strict TypeScript npm-workspace monorepo. Use judgment when designing and
implementing solutions. Prefer simple, coherent designs over ceremony or literal
adherence to illustrative architecture notes.

## Project context

Before substantial work, read:

1. `README.md` for development commands, supported execution environments, and
   the package layout.
2. `DESIGN.md` and `DESIGN-AMENDMENT.md` for architectural intent and rationale.
3. Relevant durable material under `docs/`.
4. The affected package's public types, implementation, and tests.

The design documents contain rationale and intended architecture, but code,
public types, and executable tests describe current behavior. Reconcile meaningful
drift instead of silently choosing one source.

## Documentation discipline

Keep durable project knowledge synchronized with implementation. Use the document
roles in `docs/README.md`; do not leave important decisions, evidence, limitations,
or delivery plans only in chat transcripts or commit messages.

Create documentation in proportion to its lasting value. Small local changes do
not need an architecture decision, research note, or tracked plan merely to
satisfy process.

## Engineering principles

- Preserve one-directional package layering. The primary path is protocol to
  store to core to service to CLI. Model providers, tools, policies, and other
  behavior enter through plugin packages and are wired at the composition root.
- Express mandatory dependencies, ownership, and lifetime/order contracts with
  types, references, and assertions.
- Never hide an impossible internal state or packaged-program defect behind a
  warning, sentinel, ignored result, or inert fallback. Fail fast.
- Recover only explicitly classified external failures, leaving canonical state
  and a bounded retry trigger. Do not retry deterministic failures.
- Validate untrusted values once at their boundary, then trust the established
  invariant instead of repeating clamps and guards throughout the system.
- Preserve cancellation, usage accounting, opaque provider payloads, immutable
  conversation history, and cache-stable request structure across abstractions
  that touch them.
- Avoid duplicate state and speculative layers. Add an abstraction when it
  enforces a real boundary or simplifies behavior that exists now; do not add fake
  implementations for hypothetical platforms or providers.
- Prefer observable semantic outcomes over private call-sequence assertions and
  strict ordering machinery that protects no demonstrated invariant.
- Comment non-obvious invariants and reasons; do not narrate obvious code.
- Preserve unrelated worktree changes.

## Change workflow

For substantial implementation, refactoring, architecture, testing, or
documentation work, use the repository-local `$ship-change` skill. Scale its
research, durable planning, validation, and independent review to actual risk and
complexity. Trivial edits do not require reviewer agents or plan files.

The skill does not grant authority to commit, push, deploy, publish, delete, or
otherwise change external state.

## Testing discipline

- Prefer regression tests through the highest practical public boundary, using
  real dependencies and representative data.
- Substitute models, clocks, processes, credentials, operating-system state, or
  other edges when control, isolation, or determinism requires it.
- Prefer observable completion events and state over fixed sleeps or brittle
  private call-sequence assertions.
- Add a regression scenario for significant bug fixes when practical. Otherwise
  document why automation is not yet possible and what remains uncovered.
- Keep testing guidance and known coverage gaps current in `docs/TESTING.md`.
- Use `npm run check` as the full local validation command.
