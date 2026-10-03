# Harness repository guidance

Harness is a local-first, model- and provider-agnostic agent harness implemented
as a strict TypeScript npm-workspace monorepo. Use judgment when designing and
implementing solutions. Prefer simple, coherent designs over ceremony or literal
adherence to illustrative architecture notes.

## Project context

Before substantial work, read:

1. `README.md` and `PLAN.md` for setup, product direction, scope, subsystem
   status, and priorities.
2. The relevant current architecture and, when present, active roadmap under
   `docs/subsystems/`.
3. Relevant decisions, research, delivery plans, testing guidance, and deferred
   work under `docs/`.
4. The affected packages' public types, implementation, and tests.

Subsystem documentation describes accepted architecture and behavior. Public
types, implementation, and executable tests remain the final authority; reconcile
meaningful drift instead of silently choosing one source.

## Documentation discipline

Keep `PLAN.md`, the owning subsystem documents, and other durable project
knowledge synchronized with implementation. Use the document roles in
`docs/README.md`; do not leave important decisions, evidence, limitations, or
delivery plans only in chat transcripts or commit messages.

Create documentation in proportion to its lasting value. Small local changes do
not need an architecture decision, research note, or tracked plan merely to
satisfy process.

Substantial plans need a high-level milestone checklist and actionable tasks with
dependencies and completion checks. Keep rationale and research separate from
the execution checklist. Update status and validation evidence as work progresses,
not only at handoff. Check a task only when its completion check passes;
distinguish implemented code from verified behavior and unfinished integration.

## Engineering principles

- Preserve one-directional package layering. The primary path is protocol to
  store to core to service to the shared server composition. CLI and desktop use
  the public client boundary. Model providers, tools, policies, and other behavior
  enter through plugin packages and are wired in `packages/server`.
- Clients own presentation and interaction; the server owns conversations,
  configuration, credentials, tools, execution, and persistence. Keep clients on
  the public JSON-RPC boundary instead of exposing runtime objects or duplicating
  agent-loop semantics in a new UI.
- Express mandatory dependencies, ownership, and lifetime/order contracts with
  types, references, and assertions.
- Never hide an impossible internal state or packaged-program defect behind a
  warning, sentinel, ignored result, or inert fallback. Fail fast.
- Recover only explicitly classified external failures, leaving canonical state
  and a bounded retry trigger. Do not retry deterministic failures.
- Treat retries as delivery of the same logical operation. Preserve captured
  intent, identity, payloads, and accounting; a transport failure must not create
  a new user decision or duplicate canonical output.
- Validate untrusted values once at their boundary, then trust the established
  invariant instead of repeating clamps and guards throughout the system.
- Preserve cancellation, usage accounting, opaque provider payloads, immutable
  conversation history, and cache-stable request structure across abstractions
  that touch them.
- Avoid duplicate state and speculative layers. Add an abstraction when it
  enforces a real boundary or simplifies behavior that exists now; do not add fake
  implementations for hypothetical platforms or providers.
- When accepted requirements already imply materially different ownership or
  lifecycle models, establish the narrow shared contract with the first
  implementation. Shape it from known consumers and invariants.
- Check maintained libraries and operating-system facilities before building
  infrastructure. Reuse them when they satisfy the actual contract; keep custom
  code focused on product semantics and explainable gaps.
- Make designs as simple as possible, but not simpler than correctness,
  lifecycle, recovery, provider behavior, and observability require.
- Prefer designs that converge quickly to the correct user-visible state over
  machinery that makes every transient observation or event interleaving
  perfect. Compare the latest semantic value and reconcile it at a safe boundary
  by default. Add coordination, identity, generation, or strict ordering only
  when it protects resource lifetime, a protocol-required asynchronous lifetime,
  or another demonstrated product invariant.
- Prefer observable semantic outcomes over private call-sequence assertions and
  strict ordering machinery that protects no demonstrated invariant.
- Bound routine work by the records and bytes it affects. Use indexed lookups,
  bounded pages, and bounded buffers; bulk reconstruction and maintenance need
  explicit batches.
- Make boundary crossings, cancellation, resource lifetime, and important failures
  observable with safe structured context. Do not log credentials, tokens, raw
  provider payloads, or unrequested prompt content.
- Do not derail scoped work to fix every incidental issue. Record consequential
  deferred findings instead.
- Comment non-obvious invariants and reasons; do not narrate obvious code.
- Preserve unrelated worktree changes.

## Change workflow

For substantial implementation, refactoring, architecture, testing, or
documentation work, use the repository-local `$ship-change` skill. Scale its
research, durable planning, validation, and independent review to actual risk and
complexity. Trivial edits do not require reviewer agents or plan files.

Review requirements and simplicity explicitly, including existing boundaries
affected by the change. Preserve required behavior when removing complexity;
document why stronger ordering or durable state is necessary. Unfinished required
behavior stays open in the plan and blocks completion rather than being relabeled
as a deferral or simplification.

The skill does not grant authority to commit, push, deploy, publish, delete, or
otherwise change external state.

When commits are authorized, commit coherent, validated increments as work
progresses. Aim for two feature-progress commits followed by one cleanup or
simplification commit. Keep cleanup tied to the work; fix correctness issues when
found and do not manufacture churn to meet the cadence.

## Testing discipline

- When a test fails or observed behavior contradicts an expectation, establish
  the root cause before applying a fix. Preserve evidence and distinguish product
  defects from incorrect tests or assumptions. Do not weaken assertions, increase
  timeouts, add retries or fallbacks, or patch symptoms without evidence that the
  change addresses the cause. If the cause remains unknown, keep the issue open.
  Verify the fix against the original failure and the intended contract.
- Prefer regression tests through the highest practical public boundary, using
  real dependencies and representative data.
- Substitute models, clocks, processes, credentials, operating-system state, or
  other edges when control, isolation, or determinism requires it.
- Prefer observable completion events and state over fixed sleeps or brittle
  private call-sequence assertions.
- Tests must work when the system gets faster. Wait for the actual prerequisite
  or result rather than incidental delays or a nearby condition.
- Add a regression scenario for significant bug fixes when practical. Otherwise
  document why automation is not yet possible and what remains uncovered.
- Keep testing guidance and known coverage gaps current in `docs/TESTING.md`.
- Run independent checks concurrently when practical, respecting dependencies and
  shared outputs. Report actual results and limitations; a compile or mocked
  transport does not establish real process, platform, or UI behavior.
- Use `npm run check` as the full local validation command.

## Local conventions

- Retry permission, file-access, network, or suspicious not-found failures that
  may be sandbox-related outside the sandbox with the required approval request
  and a concise justification.
- Never use or read the `yeet` skill. Use `gh` for GitHub access.
- When commits are authorized, use imperative subjects and explain substantive
  changes, reasons, relevant alternatives, risks, and deferred work in the body.
