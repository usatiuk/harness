# Execution and safety subsystem

## Status

Harness owns every shipped file and command tool. Model providers declare the
file-tool dialect a model expects; `@harness/workspace` supplies the corresponding
Harness-executed tools over one `ExecutionContext`. The configured sandbox plugin
selects unconfined host, Linux Bubblewrap, or dev-container execution for each loaded
conversation.

Human approval, optional model-backed auto-approval, output preservation, and
background activity consumption wrap these tools through middleware. Provider-
owned execution tools are intentionally unsupported in the current composition.

## Execution boundary

`ExecutionContext` is a plugin-tier IO contract for:

- Workspace-relative reads, metadata, writes, removal, and glob listing.
- Streaming process spawn in the workspace.
- Large-output storage under the active substrate.
- Relationship classification as in-workspace, out-of-workspace, or unknown.
- Registration of tools wholly mediated by the substrate.
- Optional explicitly approved access to an unconfined host context.

The kernel carries this context as the workspace-scoped `"execution"` service.
Activation explicitly prepares it; workspace, approval, agents, output and
activities resolve the same cached instance. Clients use the public RPC boundary.

The sandbox plugin contributes model instructions from that active instance.
Native instructions report workspace write/network settings and the shell's
temporary mounts, and refer to tool documentation for approved host escape.
Docker reports the mapped container cwd and probes workspace writability as its
remote user; probe failures surface instead of becoming a permission claim.
Docker temporary-file lifetime follows its container/mount configuration and
offers no host escape. Unconfined execution adds no sandbox instructions. Tool
schemas/descriptions remain the sole documentation for escalation syntax.

## Workspace tools and dialects

The workspace plugin contributes a roster from the active model's file-tool
profile:

- Neutral structured `read_file`, `write`, `edit`, `glob`, and shell command
  tools.
- OpenAI-style freeform `apply_patch` with grammar-constrained V4A input.
- Anthropic-style `str_replace_based_edit_tool` commands.

All profiles execute through `ExecutionContext`; adapters only render schemas and
calls. Structured path extraction is shared with hierarchical instruction
middleware; approval classifies calls through the execution substrate instead.
Commands are marked backgroundable and become activities through orchestration
middleware.

## Backends

### None (unconfined host)

Runs directly against the host workspace. It is already unconfined and therefore
does not expose a separate host-escape context.

Configuration and RPC use `none`, `native` or `docker`. Saved configuration accepts
the former `local` spelling as an input alias for `none`, without rewriting files.
Server composition probes usable Linux Bubblewrap once to choose an unspecified
backend's default; unsupported hosts use `none`. The same server-owned value
feeds settings RPC and conversation defaults. Explicit choices remain authoritative,
and explicit native activation still validates availability and fails normally.
Clients do not probe their own host. Sandbox plugin contract 2 and Harness protocol
18 reflect the renamed public backend value.

### Native

Linux-only Bubblewrap execution. Host files are readable, temporary/runtime
directories are private, and workspace writes/network are independently
configurable. Routine confined calls need no approval. Managed tools may request
an explicit host escape; after approval only that invocation receives the local
unconfined context.

Shell commands share a private `/tmp` directory across workspaces in the server
process. A lazy temporary host directory is bind-mounted at `/tmp`, hiding host
temporary files; `/run` remains fresh per-command tmpfs. Server restart selects a
new directory, and OS temporary-file cleanup owns old directories. Native file
tools still resolve host paths; this temporary mount applies to shell commands.

Native v1 validates built-in mutation paths before performing host IO. The check
and operation are not atomic against another process replacing a path with a
symlink. This limitation is documented and blocks stronger isolation claims.

### Docker

Uses the project's dev-container configuration. The server composition owns an
environment pool keyed by canonical workspace and resolved recipe path. Compatible
conversations share the physical environment; each execution view retains its own
cwd mapping, processes, IO cancellation, output namespace and event channel.
The project may be an ancestor of the conversation cwd. There is no Docker-to-host
escape path.

Opening a Docker conversation prepares its environment. Closing a view drains only
its own IO/processes and releases its attachment; environments remain alive with
no views. Explicit Stop stops the primary container and Compose sidecars while
preserving container state. Reopening resumes it. Remove discards containers and
owned Compose networks; named volumes remain. Server shutdown stops all owned
environments. The former `idleTimeoutMinutes` input is accepted for saved-file
compatibility and discarded; there is no idle timer.

Stable server-home labels and workspace/recipe-derived Compose project names align
sharing, management and cleanup. Inventory queries Docker explicitly, including
sidecar-only and network-only remnants; there is no mirrored container registry or
polling. A home-local Docker metadata directory records whether this server has
used Docker, so deleting a local-only worktree does not require a Docker daemon.
`harness sandbox shell/stop` uses the same shared local server; the CLI owns only
the terminal attachment.

Before provisioning, a stop-only guardian container (`node:24.21.0-alpine`)
subscribes to Docker start events through the selected daemon socket and verifies
its daemon identity. Server stdin EOF triggers a stop sweep and continued stopping
of later owned starts, covering an in-flight devcontainer CLI after server SIGKILL.
A replacement same-home server establishes its subscriber before retiring the old
guardian. Existing SQLite ownership excludes two live servers for one home.
Guardian failure closes the server rather than continuing unguarded. Graceful
shutdown drains views, stops all owned environments and retires the guardian.
Rootless Unix sockets and Docker Desktop are supported; other remote Docker
endpoints fail clearly before provisioning. The guardian needs Docker socket access,
just like the server; it does not delete containers or volumes.

Shared Stop/Rebuild warns affected views and may interrupt their commands. Reload
and backend configuration changes dispose the conversation view before constructing
the next. Selection never silently falls back to a less confined backend.

## Worktrees and workspace switching

`@harness/worktrees` owns Git commands, managed-checkout ownership, the global
storage setting and agent tools. `HarnessService` owns conversation selection;
execution backends own their physical environments. No project records or generic
workspace-provider framework are introduced.

A managed worktree starts at current HEAD on a generated `harness/<uuid>` branch;
dirty and ignored files are not copied. Storage defaults to `~/.harness/worktrees`
on the selected server and accepts an absolute configured directory. Existing
locations remain valid after the setting changes. Git is authoritative for current
branches and registrations; the store keeps only managed path, repository and
creation time.

A conversation retains its original workspace for settings resolution and a mutable
current workspace for execution. Forks/children preserve that origin. Switching
moves no files/history. Only workspace-scoped services (execution and project
instructions) are replaced. User switches require an idle conversation tree;
background activities and subagents block switching and deletion. Agent-requested
switches reserve preparation/cancellation immediately but commit only after the
whole tool batch, including parallel/nested eval calls. Other calls in that batch
use the old directory. The next request rebuilds instructions/tools and receives a
workspace-change context item. New execution is prepared before durable selection
changes; failures preserve the old selection.

Deletion validates managed ownership and dirty-file permission, removes the Docker
environment, removes the Git checkout, then drops ownership. It retains branches
and history. Explicit confirmation permits discarding dirty/untracked files; locked
or primary checkouts remain protected. An ownership write failure after successful
Git removal can be retried. Running work or an in-flight switch blocks deletion.
Idle conversations pointing at a deleted checkout fail on open instead of recreating
it; the workspace control can switch back to the original checkout.

Native confinement exposes linked Git common metadata for writes when workspace
writes are enabled. POSIX Docker mounts preserve absolute Git metadata and checkout
paths. Windows Docker mounts translate the checkout's `.git` link without global
`GIT_DIR`/`GIT_WORK_TREE` overrides, preserving nested repository discovery.

## Approval

Approval tool middleware asks through the kernel's correlated request seam when
policy requires a decision. Classification is based on the execution substrate,
tool call, configured tool rules, and explicit sandbox escape. Denial returns one
canonical tool error and durable annotation.

The shared permission vocabulary is `allow`, `ask`, `ask-human`, and `deny`.
Native tools select by workspace scope; MCP selects in its own plugin. Both use
the approval-owned execution/prompting mechanism. Workspace relationship is
optional for scope-neutral tools. Ask follows auto-review; Ask human bypasses it.
`plugins.approval.humanApprovalTimeoutSeconds` defaults to 60, accepts positive
finite durations up to 2,147,483 seconds, and applies after request middleware
passes a prompt to the kernel. The pending-request owner enforces expiry with
zero clients, records denial, removes the prompt, and ignores late answers.
Human waiting remains within the active call, including code-mode child calls.

Auto-approval is request middleware: when enabled, it asks the configured model
for an allow/deny judgment and records the responder/model/reason. A malformed
judgment, model failure, or timeout fails closed as an automatic denial rather
than falling through to a human prompt. Downstream delegated calls are reviewed
independently.

The [auto-approval revamp](../../plans/execution/2026-10-11-auto-approval-revamp.md)
keeps exact `YES` / `NO` decisions. Review context includes available settings and
project guidance, labeled as evidence rather than human authorization. Project
AGENTS.md, summaries, assistant messages, and tool output cannot override direct
user restrictions. The short, task-agnostic policy defaults to approval. Denial
requires a direct restriction or concrete unauthorized dangerous/sensitive effects;
necessity, usefulness, efficiency, and task scope alone are not denial reasons.

The reviewer uses the existing workspace `ReadFileTool`, including its normal
schema (`path`, zero-based line `offset`, `limit`), output bounds, and active
execution backend. Relative paths start in the workspace; local reads accept
absolute paths and `..`, while Docker reads use the container filesystem. No
new workspace-only confinement, regular-file check, subprocess reader, or
execution-backend API is introduced. No ordinary dispatcher or other tools are
available to the reviewer.

Calls and results continue in an in-memory item array, preserving native provider
payloads. A verdict with outstanding calls is never accepted. Review invocations
skip persisted context builds; existing approval annotations and parent-turn
usage remain saved. The short denial reason can include information derived from
inspection. Other model calls keep existing context retention.

`plugins.auto-approval.timeoutSeconds` defaults to 30 and is editable in desktop
settings. One signal covers the complete review, including model calls and read
waiting, with no step/read counts, cumulative quotas, or added model-byte cutoff.
Deadline expiry uses the existing automatic-denial path. Parent cancellation
interrupts review. Cancellation stops waiting for the ordinary read; underlying
backend IO may still complete, because the normal tool does not expose physical
read cancellation. Normal provider output limits and cancellation remain in use.

## Code-mode execution

The shipped `@harness/code-mode` implementation runs a fresh QuickJS WASM runtime
in a Node worker for each invocation. Its only bridge capabilities are scoped
tool calls and explicit output. Search/describe are ordinary host tools, outside
the guest. No host filesystem, network, process,
imports, timers, or credentials are ambient. Computed calls use ordinary
execution/approval middleware; approving computation grants no downstream
authority. Escalation selects unconfined execution for one child operation only.
Execution wrappers preserve each tool's direct/code exposure and output contract.
Guest bridge callbacks remain private to the trusted setup closure.

Fixed limits are 32 MiB guest memory, 512 KiB guest stack, one second cumulative
interpreter CPU (including getters, serialization, jobs, and settlement), 64 KiB
selected output, 1 MiB per bridge transfer, 8 MiB cumulative bidirectional data,
128 submissions, and 16 outstanding submissions. Search accepts 512 characters
and 32 distinct terms, returning at most twelve contracts. Waiting on tools or
human approvals consumes no interpreter CPU. Cancellation terminates the worker
and closes its bridge before outer completion. Unsupported content blocks fail
explicitly. `emitContent` also forwards validated images with a separate 2 MiB
decoded aggregate budget. Image responses permit bounded base64 overhead beyond
the normal bridge budget; text output and tool arguments retain their limits.
Pending microtasks execute in batches of at most 256 before yielding to host
messages. This bounds each batch and avoids paying an event-loop scheduling
delay for every microtask; all interpreter work still consumes the same CPU budget.

Structured data passes through result middleware alongside presentation content.
Middleware that redacts or restricts results must handle both representations.
Read/glob tools provide structured line windows/path lists; the evaluator bridge
bounds data delivered to guest code. Other tools work
through content envelopes. Full results and refs stay in canonical history.

## Output handling

Short results remain inline. The output plugin preserves large results in the
substrate's `.harness/<conversation>/outputs` store and returns a bounded model-
facing view plus its path. Streaming processes use the same store when they move
to the background. Output files are auto-gitignored and remain inspectable by the
model through ordinary workspace tools. New references are absolute host paths;
Docker maps paths within its workspace to the container mount. Old relative
references stay anchored to the earlier workspace by the switch context; files
are never moved or silently looked up in a different checkout.

## Accepted invariants

- Tools never bypass the selected `ExecutionContext` for their primary IO.
- A sandbox claims confinement only for tools it registered and mediates.
- Host escape is explicit, classified before execution, and scoped to one call.
- Backend selection fails normally when unavailable; it never downgrades to local.
- Approval state becomes tool-result annotations and events, not a second hidden
  authorization log.
- Full output is preserved when a substrate can store it; the model view remains
  bounded.

## Source map

- `packages/execution`: IO contract, local backend, process and boundary helpers.
- `packages/workspace`: model-shaped file/command tools and process activities.
- `packages/sandbox`: native/Docker execution and server-owned environment lifetime.
- `packages/worktrees`: Git operations, ownership and agent tools.
- `packages/approval`, `packages/auto-approval`: authorization middleware.
- `packages/output`: output bounding and preservation.

## Verification

Tests cover path boundaries, process-tree termination, stream decoding, tool
dialects, patch parsing, output spill, approval classification/annotations,
auto-approval integration, Docker sharing/retention/stop/crash behavior, and native
namespace configuration. Native integration tests are platform/capability gated.

Image files are recognized by signature through bounded ExecutionContext reads.
Both `read_file` and text-editor `view` return canonical image blocks; line ranges
on images fail explicitly. Local ranged reads use bounded file I/O. MCP validates
native image blocks at ingress and preserves mixed text/image order. Output text
spilling retains accompanying images. Image-bearing computed tool responses use
`{content,status,structured?,full?,annotations?}` so callers can forward content
without serializing base64 as text; structured-only responses keep their prior shape.
