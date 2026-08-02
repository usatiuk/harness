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

Uses the project's dev-container configuration, provisions lazily, streams build
status, reuses labeled containers, and stops them after a configurable idle
period. Paths and output stay in the container workspace. There is no Docker-to-
host escape path.

Backends are cached for a loaded conversation. Configuration changes apply after
Harness restarts/reloads that runtime; selection never silently falls back to a
less confined backend.

## Approval

Approval tool middleware asks through the kernel's correlated request seam when
policy requires a decision. Classification is based on the execution substrate,
tool call, configured tool rules, and explicit sandbox escape. Denial returns one
canonical tool error and durable annotation.

Auto-approval is request middleware: when enabled, it asks the configured model
for an allow/deny judgment and records the responder/model/reason. A malformed
judgment, model failure, or timeout fails closed as an automatic denial rather
than falling through to a human prompt. Downstream delegated calls are reviewed
independently.

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
