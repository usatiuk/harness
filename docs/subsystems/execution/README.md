# Execution and safety subsystem

## Status

Harness owns every shipped file and command tool. Model providers declare the
file-tool dialect a model expects; `@harness/workspace` supplies the corresponding
Harness-executed tools over one `ExecutionContext`. The configured sandbox plugin
selects local host, Linux Bubblewrap, or dev-container execution for each loaded
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

The kernel carries this context as the per-conversation `"execution"` service but
does not call its methods. Workspace, approval, agents, output, activities, and
the TUI resolve the same cached instance.

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

### Local

Runs directly against the host workspace. It is already unconfined and therefore
does not expose a separate host-escape context.

### Native

Linux-only Bubblewrap execution. Host files are readable, temporary/runtime
directories are private, and workspace writes/network are independently
configurable. Routine confined calls need no approval. Managed tools may request
an explicit host escape; after approval only that invocation receives the local
unconfined context.

Native v1 validates built-in mutation paths before performing host IO. The check
and operation are not atomic against another process replacing a path with a
symlink. This limitation is documented and blocks stronger isolation claims.

### Docker

Uses the project's dev-container configuration and provisions lazily. One concrete
environment pool belongs to each sandbox plugin composition, keyed by canonical
project and config path. Compatible conversations share provisioning and the
physical environment; each execution view retains its own cwd mapping, processes,
IO cancellation, output namespace, and event channel. The project may be an
ancestor of the conversation cwd; paths preserve that relative subdirectory.
There is no Docker-to-host escape path.

Ordinary close aborts and awaits only that view's IO/processes, then releases its
ownership. Other owners keep the environment and in-flight provisioning. Final
release cancels and awaits provisioning before removing owned containers,
Compose sidecars, and networks. Recipe-derived labels and `COMPOSE_PROJECT_NAME`
align sharing and cleanup identity. Persistent volumes keep existing behavior.
Explicit shared stop/rebuild emits a warning to affected conversations and acts;
it may interrupt their commands. The TUI displays the warning through its existing
status flow; this does not add parallel TUI support.

Idle accounting aggregates all IO and commands. Interactive sessions prevent
idle stopping. The longest owner's timeout wins; any zero disables idle stopping.
The workspace container stops after idle and restarts lazily. Compose sidecars
remain until explicit stop or final release. Ownership remains while loaded.

Tools and client controls resolve the same backend within an activation. Explicit
reload and sandbox configuration changes dispose that view before constructing
the next. Selection never silently falls back to a less confined backend.

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
explicitly; the current protocol and `emitContent` support text only.

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
model through ordinary workspace tools.

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
- `packages/sandbox`: native and Docker backends plus configuration.
- `packages/approval`, `packages/auto-approval`: authorization middleware.
- `packages/output`: output bounding and preservation.

## Verification

Tests cover path boundaries, process-tree termination, stream decoding, tool
dialects, patch parsing, output spill, approval classification/annotations,
auto-approval integration, Docker lifecycle/retry/idle behavior, and native
namespace configuration. Native integration tests are platform/capability gated.
