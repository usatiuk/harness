# Worktrees and workspace-owned Docker environments

Status: Complete. Implemented and locally qualified on 2026-10-15.
Commit, push and release authorized on 2026-10-15 after local qualification.

## Outcome

Conversations can use and switch Git worktrees without moving their files or
history. Docker environments belong to workspaces rather than loaded conversation
runtimes. Keep one execution path, existing plugin boundaries, and small client
controls; do not build a general workspace framework.

## Agreed product requirements

### Worktrees

- New conversations can use the existing checkout or create a new worktree.
  Worktree creation requires a Git repository.
- Existing conversations can switch to a new or existing worktree, or back to
  their original checkout. This selects another working directory and execution
  environment. No files, conversation history, or output files are moved/copied.
- New worktrees start from the selected checkout's current `HEAD` on a generated
  branch. Do not implicitly copy dirty or ignored files.
- The selected server owns Git operations and storage. The global worktree
  directory is configurable through GUI/TUI Settings, defaulting to
  `~/.harness/worktrees` on that server. Changing it affects future creation;
  existing worktrees stay where they are.
- Keep existing sidebar grouping; do not introduce original-project grouping.
  Show a subtle worktree icon on the right of a conversation row, immediately
  before its status indicator. In the open conversation header, show the branch
  name subtly after the title, on the same line.
- Provide minimal management: list managed worktrees, open a conversation in one,
  and delete one. Multiple conversations can use the same worktree.
- Closing a conversation or restarting Harness does not delete its worktree.
- Deletion refuses while conversations there are running. Dirty worktrees may be
  deleted after explicit user confirmation of losing uncommitted/untracked files.
  Ordinary deletion must not silently force. Keep the Git branch and conversation
  history; remove the associated Docker environment as part of deletion.
- Agents can switch their current conversation to a new/existing worktree or back
  when the user requests it. Agent and client actions use the same server
  operations, rather than separate Git or state-changing implementations.

### Docker

- Each worktree gets a separate Docker environment. Conversations in the same
  workspace can share its environment. An environment includes its configured
  Compose services, not just the primary container.
- Creating/opening a Docker conversation starts or creates its environment.
  Merely finishing a turn, closing/switching a conversation, switching its
  workspace, or disposing a loaded runtime does not stop/remove that environment.
- While the server is running, started environments stay running until explicitly
  stopped or removed. Remove current automatic idle-stop behavior from this
  lifecycle; TTL cleanup is outside scope.
- Explicit Stop and server shutdown stop containers, preserving their writable
  state. Opening a conversation again starts the retained environment. Removal is
  a distinct explicit operation and accompanies worktree deletion.
- A small manager lists Harness-managed environments and exposes Stop/Remove.
  Reuse existing ownership labels and devcontainer provisioning; do not replace
  the devcontainer CLI with a custom builder.
- If the server is killed without running shutdown handlers, a reaper must stop
  its environments after bounded loss detection. It must not delete them or stop
  unrelated containers. Exact implementation is a blocking design question below.
- Separate environments do not promise isolation from deliberate shared bind
  mounts or explicitly shared volumes in user devcontainer configuration.

## Grounded current behavior

- `ConversationRecord.workspaceRoot` is currently fixed at creation and also
  drives settings resolution. Switching needs an explicit original checkout /
  current execution directory distinction, rather than treating a changed folder
  as a new conversation or silently changing its effective settings.
- `sandboxPlugin` owns one `DockerEnvironmentPool`. Compatible roots/configs
  share environments; each `DockerExecutionContext` owns its processes, IO,
  cancellation, and event channel. Preserve that useful physical-resource /
  conversation-view split.
- Docker currently provisions lazily. Final view release removes environments;
  explicit Stop also removes them. Idle stopping stops only the primary container
  while leaving Compose sidecars alive. These behaviors need deliberate
  replacement, not another competing cleanup layer.
- Current pool keys use resolved project/config paths, with ancestor
  `.devcontainer` discovery. Confirm physical workspace identity and linked
  worktree behavior before adopting the key unchanged.
- Execution contexts and runtime services are cached. Switching must reconcile
  consumers beyond command cwd: settings, instructions, tools, approvals,
  activities, output references, and subagents.

Source map: `packages/protocol/src/conversation.ts`,
`packages/service/src/service.ts`, `packages/config/src/resolve.ts`,
`packages/execution/src/context.ts`, and
`packages/sandbox/src/{plugin,docker-environment,docker,devcontainer}.ts`.

## Boundary design

| Owner                | Responsibility                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation service | Durable workspace selection and original checkout; coordinate switches and deletion with existing runtime/execution lifetimes; expose public operations. |
| Worktree plugin      | Git create/list/inspect/remove, managed storage setting, and agent tools calling the shared conversation operations.                                     |
| Sandbox plugin       | Workspace Docker environment start/stop/remove, sharing, shutdown and crash cleanup; conversation-scoped execution views.                                |
| Server composition   | Wire concrete contributions through existing plugin/service seams without importing Docker into Git management.                                          |
| GUI/TUI              | Settings, selection/management controls, destructive confirmation and status through public RPC.                                                         |

Worktrees are directories, not a new execution backend. Worktree operations do
not know Docker internals; the service coordinates their cleanup through the
execution owner. Docker receives a workspace, not a branch-management contract.
Shape any necessary seam from these consumers only. Exact RPC/tool names and
package additions are not decided here.

Use Git's worktree metadata as the source of truth where possible. Persist only
Harness facts Git cannot supply, such as the conversation's original checkout
and managed ownership. Do not create a parallel branch/worktree inventory merely
to mirror Git.

### Switching contract

- Client-initiated switches require an idle conversation.
- An agent-initiated switch cannot require an idle turn: the tool itself runs
  inside that turn. Apply it at a safe tool boundary after other old-workspace
  executions drain; subsequent work uses the selected workspace. Do not make a
  tool wait for a batch whose completion depends on that same tool returning.
- A failed switch leaves the previous selection usable. Preparation, durable
  selection and runtime replacement need a defined failure order before coding.
- Preserve effective settings during the switch and their intended behavior after
  restart. Refresh directory-dependent instructions and execution state. Clearly
  tell the agent that its working directory changed; history stays immutable.
- Do not move old output files. Existing history must not silently resolve an old
  relative output reference against a different checkout.
- Background activities and subagents must not be silently retargeted or killed.
  Define the minimum busy condition needed to protect their existing lifetimes.

## Blocking decisions and proof needed

1. **Workspace/configuration identity.** Choose the minimum durable fields for
   original checkout, current directory and managed-worktree association. Define
   settings resolution across switch/restart, existing sidebar folder behavior,
   and behavior when an inactive conversation points at a deleted worktree. Do not
   silently create a missing directory or select another checkout.
2. **Git metadata access.** Linked worktrees refer to private/common metadata
   outside their checkout. Demonstrate status/add/commit through native and Docker
   execution, including devcontainer mounts and sandbox write policy. A checkout
   with working file edits but broken Git is not delivery.
3. **Safe switch boundary.** Inspect actual dispatcher/service lifetimes,
   parallel/nested calls, background activities and subagents. Select the smallest
   boundary that cannot deadlock or run later calls on stale execution. Avoid a
   new scheduler or identity layer unless an observed invariant requires it.
4. **Crash cleanup and ownership.** Select a maintained watchdog/reaper facility
   if one satisfies stop-only semantics. Otherwise specify the minimum heartbeat
   contract, Docker access, restart behavior and stale-owner protection. Confirm
   which server instances can coexist; never stop another live owner's resources.
   Graceful shutdown alone does not satisfy external-kill cleanup.
5. **Deletion and retained state.** Define recoverable ordering for Git removal
   and Docker removal, including partial failures. Specify volume retention
   explicitly; do not silently delete user volumes. Keep confirmation scoped to
   the selected worktree and actual destructive action.

Selected contracts from code investigation:

- Keep optional durable `originalWorkspaceRoot` alongside mutable `workspaceRoot`;
  resolve the settings cascade against the former. Forks and children inherit it.
- Store only managed path/repository/creation ownership in an indexed table; Git
  remains authoritative for checkout/branch state. This supports configuration
  directory changes without directory scans or a mirrored Git registry.
- Defer tool-requested switches until the whole top-level batch, including nested
  calls, finishes. Replace only services declared workspace-scoped (execution and
  project instructions), then rebuild tool contributions for the next request.
  Existing activity blockers reject switching with active background work.
- A persistent stop-only guardian subscribes to Docker start events before
  provisioning. Server stdin EOF triggers an initial stop sweep and continued
  stopping of later owned starts. Stable server-home labels and Compose prefixes
  provide scope; the next same-home server establishes its guardian before
  retiring the old one. Existing database ownership excludes concurrent same-home
  servers. This avoids TTL/quiet-period heuristics and provisioning supervisors.
- Use Docker API stream establishment for readiness and compare daemon IDs. Resolve
  rootless Unix sockets and Docker Desktop socket mounts explicitly; unsupported
  remote daemon endpoints fail clearly, without running unguarded environments.
- Preflight managed ownership and dirty deletion permission before Docker removal;
  then remove environment, Git worktree, and ownership record in that order.

Deletion admission, absolute output anchoring, linked Git access and crash/takeover
qualification are implemented and covered by the evidence below.

## Milestones and completion checks

- [x] **1. Resolve blockers.** Inspect affected public types, consumers and tests;
      record answers above and the smallest concrete API/data changes. Completion:
      switch, delete, stop, crash/restart and missing-path outcomes are unambiguous;
      Git access and reaper feasibility have concrete evidence.
- [x] **2. Worktree/server foundation** (depends on 1). Add validated global
      setting, Git management and durable selection on existing store/service/RPC
      boundaries. Completion: real temporary-repository tests cover creation,
      listing, switching, restart, dirty deletion confirmation and failure safety.
- [x] **3. Docker lifetime** (depends on 1; integrate with 2). Move physical
      lifetime to workspace management; separate stop/remove, stop all owned
      Compose services, retain state, and implement crash cleanup. Completion:
      real Docker tests prove sharing, separation, clean shutdown, forced server
      kill, restart/reuse and ownership safety without destructive fallbacks.
- [x] **4. Client and agent integration** (depends on 2–3). GUI/TUI settings,
      creation/switch/management, icons/branch header and shared agent tools.
      Completion: public RPC/browser/TUI scenarios demonstrate intended behavior;
      agent switching works during a turn without stale tools or deadlocks.
- [x] **5. Qualification and simplification** (depends on 2–4). Run focused
      store/service/plugin and browser regressions, `npm run check`, real Git and
      Docker/Compose scenarios, and scoped independent reviews for correctness,
      lifetime/boundaries, and simplicity/evidence. Update owning docs and record
      platform limitations. Completion: required cases pass; unresolved required
      behavior remains open rather than being called a deferral.

## Validation requirements

- Switching round-trip preserves history, settings and original-checkout identity
  across restart; next calls and instructions use the selected workspace.
- Parallel/nested agent calls, active processes, cancellation, failed provisioning
  and unavailable Docker cannot leave mixed execution or silently fall back local.
- Two worktrees have separate environments; two chats in one share. Last runtime
  release keeps containers alive. Stop/start retains a sentinel in container-local
  storage. Graceful/crash shutdown stops owned sidecars as well as main containers.
- Dirty deletion requires confirmation; clean/confirmed deletion retains branches
  and history. Partial Git/Docker removal failures remain visible and recoverable.
- Configured storage roots, paths with spaces, linked metadata and supported host
  platforms work. Test permissions at real execution boundaries, not only mocks.
- Isolate homes, credentials and Docker ownership in tests. Never use the user's
  dev profile or credential store. Await actual state/events rather than sleeps.

## Explicit non-goals

No merge/rebase UI, branch picker, copying dirty files, per-subagent worktrees,
automatic worktree deletion, TTL pruning, per-conversation containers, new project
records/grouping, generic workspace-provider framework, or automatic conversion
of existing conversations. No unrelated sandbox hardening or Docker rewrite.

## Documentation and evidence

On implementation, synchronize execution architecture, interface/configuration
behavior, persistence/protocol contracts and `docs/TESTING.md`; retain current
behavior in architecture documents until changed. Root `PLAN.md` links here.

Delivery evidence:

- `npm run check`: typecheck, lint, formatting and **1,391 passing tests**, 41
  capability-gated skips. Run outside the outer sandbox: it exposes an empty
  `/tmp/.git` which changes the real non-Git discovery fixture. No product fallback
  was added for that test environment.
- Browser suite: **58 passing cases**, including production worktree creation,
  non-Git eligibility, busy/idle switching, deletion confirmation, and directory
  save/clear. Screenshots checked branch placement, compact header and menu rows.
- Real Docker/Compose suite: **6 passing cases**, one native-only skip. Covers
  shared/separate environments, linked Git status/add/commit and nested discovery,
  retained state/container identity on restart, graceful stop, server SIGKILL,
  later owned starts, guardian death, ownership separation, takeover, and cleanup
  of sidecar-only/network-only remnants without deleting other owners.
- Real server RPC/SQLite regression also passes with Docker enabled: custom
  original-project recipe through a symlink to a managed checkout, server-owned
  start/stop, restart, forced deletion and recovery of a fork's deleted workspace.
- Real Bubblewrap linked Git commit regression: **1 passing case**, two Docker-only
  skips. Requires escaping the outer test sandbox to create namespaces.
- Real QuickJS parallel switch/read, overlapping settings resolution, interrupted
  Git preparation and deletion admission regressions pass. Expected busy/dirty/
  invalid-directory refusals cross RPC safely. Ownership precedes Git creation;
  failed creation and post-Git database failure remain explicitly cleanable.
- Three independent read-only lenses reviewed correctness, resource lifetime,
  boundaries, simplicity and evidence. Findings above were fixed and rerun;
  reviewers reported no remaining blockers in their final scoped passes.

Qualification limits:

- Native Windows Docker Desktop transport/mount behavior has not been exercised
  here. The Windows translated `.git` mount path was exercised against real Linux
  Docker, including commit/nested-repository behavior; Git paths are normalized at
  their boundary. This is not a claim of native Windows qualification.
- Docker Compose's upstream Buildx Bake filesystem entitlement can reject a
  generated Dockerfile outside its build context. The Compose fixture builds its
  own image explicitly and uses it; the product still delegates to the maintained
  devcontainer CLI. No broad build workaround was added.
- Native mutation containment retains its existing documented symlink race; this
  change adds linked Git access, not stronger confinement claims.

Delivery uses the repository Release workflow after pushing the validated feature.
No user development profile or credential store was used for qualification.
