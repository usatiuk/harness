# Orchestration subsystem

## Status

Harness can run commands and subagents in the foreground or as background
activities. Activities are process-local handles owned by one conversation;
their completion is delivered back through the ordinary conversation input seam.
Subagents run as durable child conversations through the same service and engine
as their parent, with independent context, configuration, tools, and usage.

## Activities

The activities plugin owns one `ActivityManager` per loaded conversation and
contributes:

- Tool middleware that claims activities minted by backgroundable tools.
- Model middleware that injects a uniform `background` argument into eligible
  function schemas.
- `activity_wait`, `activity_peek`, `activity_list`, and `activity_kill` tools.
- A service used by tools and the TUI activities overlay.

A foreground activity waits for up to ten seconds. If still running it moves to
the background, preserves output, and returns control to the model. An explicit
`background: true` returns immediately. On exit, the manager delivers one plugin-
sourced completion notice using `steer`; the current turn consumes it at the next
after-tool-result boundary or a new turn starts when idle.

Activity ids are the originating tool call ids. Output can be inspected while
running, regex-filtered by line, waited on with a bounded timeout, or killed as a
complete process tree. The manager belongs to one loaded runtime and suppresses
completion delivery, kills, and awaits live work when that root scope is
deactivated. Runtime handles are not durable across switch, reload, or process
exit.

## Subagents

The subagents plugin contributes one `subagent({agent, task})` tool and model
middleware that rewrites its schema from the resolved per-conversation catalog.
When no agents are configured, the tool is withheld. Otherwise the `agent`
argument is constrained to configured names and the model sees their descriptions.

Each agent definition contains:

- A parent-facing name and delegation description.
- A child system prompt.
- An optional Harness tool allowlist.
- An optional model override; absent inherits the parent's resolved model.

The shipped catalog includes `general` and read-only `explore`; setting an agent
array replaces the defaults. Maximum recursion depth defaults to three. A child
inherits the parent's workspace root, creates its own durable conversation,
receives its own `AGENTS.md` snapshot, and starts from the delegated task rather
than the parent's transcript.

The subagent is itself backgroundable. Foreground completion returns the child's
final result. Background execution is tracked through the same activity tools and
completion delivery as commands. Parent/child metadata is stored in namespaced
plugin state; live handles and cascade-stop ownership remain activation-local.
Switching, reloading, or shutting down deactivates the complete loaded conversation tree and
clears its ephemeral parent/child index.

## Ownership and isolation

- A conversation can observe/control only activities registered with its manager.
- A child receives only its configured tool roster; withheld tools cannot be
  invoked through dispatch.
- Recursion is bounded structurally by depth and the absence of the subagent tool
  at the floor.
- Approval evaluates delegation and every downstream tool call independently.
- Child conversations persist for inspection even though live orchestration does
  not resume after a process restart.

## Source map

- `packages/activities`: activity handles, manager, middleware, tools, and events.
- `packages/subagents`: catalog schema, child lifecycle, registry, and tool.
- `packages/workspace/src/process-activity.ts`: command-backed activities.
- `packages/protocol/src/runner.ts`, `delivery.ts`: child runner and plugin input
  seams.

## Verification

Activities tests cover foreground/background transitions, completion delivery,
wait/peek/list/kill, output, schema injection, and cancellation. Subagent tests
cover catalogs, inheritance, tool scopes, model overrides, recursion, foreground
and background execution, parent metadata, completion, interruption, and cascade
shutdown.
