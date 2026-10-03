# Parallel conversations and Docker ownership audit

Date: 2026-10-03. Audited baseline: `7850fec`. This records evidence and the
decisions drawn from it; delivery status and checks belong in the
[implementation plan](../plans/cross-cutting/2026-10-03-parallel-conversations.md).

## Existing foundation

Engine already owns one Runtime per conversation: inbox, turn, abort controller,
pending requests, services, and idle waiters. Loading is single-flighted per
conversation. Root cancellation/deactivation enumerates only its descendants.
The JSON-RPC connection admits multiple roots and routes work/events by root and
conversation. SQLite item/head updates are transactional and conversation scoped.
Activities, approval requests, process handles, history, and output namespaces
already have conversation ownership. This needs repairs at ownership seams, not
a scheduler or a replacement engine. The TUI stays single-conversation.

## Reproduced failures

Three independent read-only audits covered engine/store, client/service/config,
and execution/orchestration. Controlled probes used real service, engine, store,
and protocol implementations with deterministic models/process/disposal edges.

1. **Docker identity disagreed with ownership.** Per-conversation execution
   contexts provisioned/removed the same workspace-labeled container but held
   separate provisioning/idle state. Closing unused A removed B's container and
   interrupted B's command. A's idle accounting ignored B's activity. Different
   recipe paths also lacked separate physical identity.
2. **Child inheritance was incomplete.** A real service/subagent tool probe with
   parent model `parent-override` produced child model `global-default`. Sandbox
   overrides were likewise omitted, allowing a Docker parent to create a local
   child. Fake-runner tests did not establish the documented inheritance.
3. **Concurrent patches lost updates.** Concurrent `{a:1}` / `{b:2}` patches to
   one conversation returned `{audit:{a:0,b:2}}`. A controlled filesystem probe
   also reproduced lost global patches across roots. Settings writers need one
   read/merge/write boundary, including model and credential-store writes.
4. **Attachment metadata survived failed activations.** Failed replacement
   preparation left A's runtime absent while the client restored attachment.
   A throwing disposer left the RPC session attached after the engine removed
   the runtime. B remained loaded; the failure was incorrect A membership.
5. **Old callbacks reached replacement runtimes.** A captured tool context's
   `deliver` started work after the same durable conversation was deactivated and
   reopened. Runtime identity, rather than conversation id alone, must bound
   callbacks. Shipped activities already suppress their own late completion.

An attachment probe also reported `rootModel:M2` alongside `liveModel:M1` after
a lower settings layer changed. Global mutation itself is intended. The approved
repair is durable model/preset selection plus live-config attachment projection.

## Accepted policies

- Pin model/preset at creation. Explicit selection changes the current root and
  global default for new conversations. Resume keeps the pinned choice. Legacy
  unpinned records adopt the current default once at first activation; historical
  defaults cannot be reconstructed.
- Other configuration retains the existing cascade. Approval policy may remain
  global and middleware may read its latest effective value. The observed
  `[1,2,2]` plugin versions across two steps and a following turn are not an
  approved defect or a reason for generic turn-level configuration freezing.
- Inherit parent model and plugin slices explicitly opted in by their owning
  definitions. Sandbox opts in; explicit child overrides win. Avoid sandbox
  imports in core/service/subagents.
- Share Docker by default for the same canonical project/config recipe. An
  activation owns a view; the sandbox composition owns the physical environment.
  Ordinary close releases only its commands/IO/ownership. Final release cancels,
  waits, and removes the owned resource.
- Preserve the existing IO-idle/lazy-restart policy, aggregating activity across
  owners. Longest timeout wins; any zero disables idle stopping. Loaded owners
  retain ownership even when the workspace container has idled down.
- Explicit shared stop/rebuild warns the affected users and proceeds, including
  interruption of another conversation's commands. No refusal or extra prompt.
- Worktrees, private-environment UI, multiple authorities, reconnect, desktop
  implementation, and parallel TUI presentation are outside this milestone.

## Primary-source Docker evidence

The lockfile pins `@devcontainers/cli` **0.80.3**. Container id labels and Compose
project identity are separate in its
[Compose implementation](https://github.com/devcontainers/cli/blob/v0.80.3/src/spec-node/dockerCompose.ts).
Distinct id labels alone do not isolate Compose environments.
[Docker project names](https://docs.docker.com/compose/how-tos/project-name/)
document `COMPOSE_PROJECT_NAME`; [Docker labels](https://docs.docker.com/engine/manage-resources/labels/)
provide resource lookup identity. Harness derives both identities from the same
canonical project/recipe pair and cleans its Compose sidecars/networks as well
as the workspace container. Pinned CLI configuration filenames must be
`devcontainer.json` or `.devcontainer.json`; recipe identity uses the complete path.

The live integration fixture uses two valid recipe paths in one project. It
verified separate Compose projects, shared ownership within a recipe,
conversation subdirectory mapping, own-process shutdown, rebuild warnings,
and final container/sidecar/network cleanup on Linux Docker from Windows.

## Remaining boundaries

One server is the settings/runtime authority. File queues and atomic replacement
coordinate its writers, not arbitrary external processes editing settings.
Cross-process ownership of the same physical Docker environment is not provided.
Idle stopping currently stops the workspace container; Compose sidecars remain
until explicit stop or final release. Docker volumes retain existing persistence.
Native filesystem containment, credential refresh under live provider load,
durable live-work recovery, and desktop UI behavior remain separate qualification
work; none is established by these controlled or Docker tests.
