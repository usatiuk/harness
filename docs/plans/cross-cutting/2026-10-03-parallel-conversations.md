# Independent parallel conversation foundation

Status: Complete — delivered and validated on 2026-10-03.

## Outcome and scope

One server runs independent concurrent root conversations over the existing
engine and client protocol. Turns, history, approvals, activities, cancellation,
and activation lifetime belong to their conversation tree. Shared defaults and
shared Docker environments are intentional; their mutation and lifetime must be
correct. There is no parallel conversation UI work in the TUI.

Worktrees, a desktop client, reconnecting daemons, multiple authorities over one
conversation, and durable live-work recovery are outside scope. Evidence is in
the [audit](../../research/2026-10-03-parallel-conversations.md).

## Accepted architecture

- Preserve Engine's per-conversation Runtime and root ownership. No scheduler,
  generic service scopes, distributed leases, or configuration policy framework.
- Pin the complete model/preset in durable overrides at creation. Explicit model
  changes still update the current conversation and the global default for new
  conversations. Existing records without a selection are pinned on first
  activation; historical defaults cannot be reconstructed. Other settings retain
  their existing cascade, including global approval policy.
- Serialize conversation configuration mutations in HarnessService. Serialize
  global settings read/merge/write by canonical file path in the config package,
  with atomic replacement so concurrent readers cannot observe a partial file.
- Child creation inherits its parent's effective model. Plugin definitions opt
  into inheriting their own configuration slice; sandbox opts in. Explicit child
  overrides win. Neither core nor subagents imports sandbox implementations.
- Bound plugin callbacks to the Runtime that created them. Disposal invalidates
  callbacks even if the same durable conversation is later reopened.
- The server reports actual detachment through a semantic protocol notification,
  including cleanup failures. Clients discard the old activation's buffered
  events and caches. A failure before deactivation preserves the attachment.
- The sandbox plugin owns a concrete Docker environment pool, keyed by canonical
  devcontainer project and configuration recipe. Conversation execution handles
  retain commands, emit channels, output namespaces, and managed-tool state.
  Provisioning, container identity, cancellation, and idle accounting are shared.
- Ordinary close kills that handle's work and releases ownership. It does not
  abort another owner's provisioning or remove its container. Last release
  cancels provisioning, waits for it to settle, then cleans the owned resource.
- Explicit shared stop/rebuild emits a user warning about affected conversations
  and proceeds. All handles observe the resulting environment state. No extra
  confirmation or refusal is introduced.
- Preserve IO idle stopping and lazy restart. Aggregate all handles' activity;
  running commands and interactive shells prevent idle stopping. If owners have
  different timeouts, use the longest; any disabled timeout disables idle stopping.
- Align owned container/Compose identity and partial-build cleanup with the
  recipe, using the pinned devcontainer CLI. Keep conversation-relative Docker
  paths aligned when the devcontainer lives at an ancestor project directory.

## Milestones and completion checks

- [x] Audit and signoff.
  - Three independent read-only audits; controlled reproductions of all five
    approved failure categories; primary-source devcontainer research.
  - User confirmed failures and approved fixes, model pinning, tests, and docs.
- [x] Configuration and inheritance.
  - Persist model selection; preserve intentional global mutation behavior.
  - Prevent lost conversation/global patches and partial settings reads.
  - Add plugin-owned child inheritance and real service regression scenarios.
  - Complete when changes survive concurrency, reload, and service recreation.
- [x] Activation and attachment lifetime.
  - Ignore stale callbacks; keep detachment authoritative on cleanup/reload failure.
  - Test simultaneous roots, scoped cancellation/approvals, and failed replacement.
  - Complete when closing/failing A leaves B usable and clients reflect authority.
- [x] Shared Docker ownership.
  - Implement environment pool and conversation handles inside sandbox.
  - Cover shared provisioning, cancellation, own commands, last release, idle,
    stop/rebuild warnings, recipe identity, and partial provisioning cleanup.
  - Complete when public-boundary controlled regressions pass and available live
    Docker/Compose checks have explicit results or precise capability limits.
- [x] Validation, documentation, and independent review.
  - Run focused tests, real stdio scenarios, and `npm run check`.
  - Synchronize product, subsystem, protocol/schema, and testing documentation.
  - Review with three read-only agents covering correctness, architecture and
    simplicity, and tests/evidence/scope. Resolve findings before handoff.
  - Complete only when all required implementation and checks are accounted for.

## Evidence

Baseline validation: 793 tests passed, 28 skipped. Audit focused validation:
104 tests passed. Controlled Docker regressions use simulated process edges;
live Docker/Compose qualification is recorded separately below.

Implementation qualification on Windows:

- Focused engine/service/client/config/Docker suite: 132 tests passed before the
  final additional cancellation, pre-start failure, and mixed-timeout scenarios.
- Real stdio fixture: simultaneous root approvals, scoped close with B's shell
  alive, B continuation, A retry, and independent history passed.
- Live Linux Docker/Compose via Docker Desktop: same-recipe sharing, subdirectory
  mapping, separate recipe projects, A/E own-command teardown with B running,
  rebuild warnings, and final container/sidecar/network cleanup passed.
- Review reproduced and repaired context-assembly cancellation classification and
  cleanup before provisioning had started, plus an unhandled idle-stop launch
  failure. Their regressions pass, as do mixed timeout/disabled-idle cases.
  No generic lifetime/config framework was added.
- Three independent read-only reviewers covered correctness, architecture/failure
  risk/simplicity, and client/protocol/tests/docs/scope. Reproduced findings were
  repaired and rechecked; no required findings remain.
- Protocol schema regenerated. Final `npm run check` passed TypeScript, ESLint,
  formatting, and **821 tests** across **90 files**, with **29 tests** in **6 files**
  skipped by capability/credential/opt-in gates. The opt-in live Compose scenario
  passed separately after the final provisioning-lifetime repair.

## Delivery slices

1. `6513a85`: conversation model/config inheritance and pinning, settings mutation,
   activation-bound callbacks, authoritative detach, and real stdio regression.
2. `ab1f18a`: shared Docker environment ownership, own IO/process cancellation, recipe/Compose
   identity, idle accounting/recovery, warnings, and live integration coverage.
3. Accepted architecture, protocol/schema, corrected audit, and delivery evidence.

The stdio fixture uses real protocol/SQLite/plugins and a controlled demo model;
it does not invoke credentialed CLI bootstrap. Native Linux execution and live
provider load are not qualified by this Windows run. Compose sidecars retain
their existing idle behavior and stop on explicit control/final release.
