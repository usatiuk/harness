# Orchestration subsystem

## Status

Harness can run commands and subagents in the foreground or as background
activities. Activities are process-local handles owned by one conversation;
their completion is delivered back through the ordinary conversation input seam.
Subagents run as durable child conversations through the same service and engine
as their parent, with independent context, configuration, tools, and usage.

Local stdio and hosted Streamable HTTP MCP tools, env/header/OAuth configuration,
scoped credentials, and desktop/TUI settings are implemented in `@harness/mcp`.
Qualification and delivery evidence are in the
[MCP delivery plan](../../plans/cross-cutting/2026-10-10-mcp-tools-and-settings.md).

## MCP

Server composition injects the existing host `SecretStore`, awaits bounded MCP
initialization, and then installs the plugin's synchronous tool contributor.
One SDK transport/client belongs to each enabled server for the server lifetime.
Classified unavailable/auth-required servers contribute no tools; independent
servers remain usable. Discovery snapshots the catalog until explicit restart.
Connection Test discovers into a temporary connection and closes it without
changing the catalog or executing tools.

The MCP package validates transport/value-source configuration and retains remote
JSON Schema through the generic tool input boundary with an SDK AJV validator.
Tool identities are `mcp_<serverId>_<rawName>`; MCP tools are code-exposure only,
discovered through `tool_search` (or inspected with `tool_describe`) and called
through `eval` in both tool modes. Their scoped names appear upfront unless global
`tools.showNames` is disabled. Raw names retain punctuation and length;
catalog name collisions reject the affected server atomically. Explicit legacy
allowlists using hashed identities require updating; no scope is widened.
Text, structured JSON, and `isError` map to ordinary tool results. Unsupported
content fails explicitly. Calls preserve allowlists, code mode, subagent scope,
history, cancellation, and output handling. Ambiguous connection failures fail
without replay. Shutdown closes transports and stdio children.

MCP selects permissions from its global read-only/other defaults, server defaults,
and exact raw-name overrides. It delegates the resulting ordinary permission to
`@harness/approval`; server composition excludes MCP tools from the native scope
selector so each call has one gate. Read-only requires `readOnlyHint: true`
without `destructiveHint: true`. No names or other hints imply read-only behavior.

Saved configuration, user credential aliases, and internal OAuth records are
separate. MCP scopes keys by server and namespace and binds records to the target.
OAuth client/token identity also includes client authentication and normalized
scopes. Credentials resolve only on the executing host. Resource headers are
injected only at the configured MCP URL; OAuth fetches carry none, and redirects
are rejected. SDK OAuth implements discovery, PKCE, supplied/pre-registered
clients, DCR, token exchange, and refresh. One owner per server serializes
login/refresh/logout mutations. Explicit sign-in has a five-minute bound;
logout cancels login and drains refresh before deleting tokens/client records.
The initiating RPC session may complete/cancel its attempt; disconnect cancels
it. The host listener also accepts callbacks, with full-URL paste for remote use.

## Activities

The activities plugin owns one `ActivityManager` per loaded conversation and
contributes:

- Tool middleware that claims activities minted by backgroundable tools.
- Contract resolution that injects a uniform `background` argument into eligible
  function schemas.
- `activity_wait`, `activity_peek`, `activity_list`, and `activity_kill` tools.
- A service used by tools and the TUI activities overlay.

A foreground activity waits for up to ten seconds. If still running it moves to
the background, preserves output, and returns control to the model. An explicit
`background: true` returns immediately. On exit, the manager delivers one plugin-
sourced completion notice using `steer`; the current turn consumes it at the next
after-tool-result boundary or a new turn starts when idle. Shared background-tool descriptions direct models
blocked on required results to use `activity_wait` rather than sleep and avoid
reporting completion prematurely. Persistent servers/watchers use `activity_peek`
to check readiness; no polling or wakeup mechanism is added.

Activity ids identify work independently of its originating tool call. Output can be inspected while
running, regex-filtered by line, waited on with a bounded timeout, or killed as a
complete process tree. Command activities render a 40-line tail by default; `max_lines` (up to 500
lines / 64 KiB) widens one command's view without changing the default. The manager belongs to one loaded runtime and suppresses
completion delivery, kills, and awaits live work when that root scope is
deactivated. Runtime handles are not durable across switch, reload, or process
exit.

Activities may also carry an immutable owner-local readable reference, supplied
from a subagent's existing task slug. Activity tools accept a canonical ID or a
unique tracked reference/title; ordinary results, lists and completion notices
prefer a readable reference, falling back to the canonical ID for ambiguity or
legacy handles. Structured results retain `activityId` and expose `activityRef`.
Resolution stays inside the caller's manager and ends on collection/deactivation:
family parent/sibling references cannot access another owner's activities or
recreate a handle from durable history. No alias registry is persisted.

Concurrent waits share a waiter count. A timeout or cancellation releases only
that waiter's registration; a successful wait consumes the pending completion
notice. The manager retains the notice callback while waiters are present, so an
abandoned explicit wait cannot discard background completion. Cancelling a
foreground call still kills its activity; cancelling an explicit background wait
leaves the activity conversation-owned.

## Subagents

The subagents plugin contributes `subagent({agent, name, slug, task})`,
`subagent_list`, `subagent_send` and `subagent_dismiss`, plus a shared
contract resolver that enriches its schema from the per-conversation catalog.
When no agents are configured, the tool is withheld. Otherwise the `agent`
argument is constrained to configured names and the model sees their descriptions.
Shipped guidance favors doing small, tightly coupled work directly and delegating
meaningful independent work for parallelism, specialization or review. A child
owns its deliverable instead of relaying the same assignment unchanged to another
child. Existing configurable depth/roster limits remain the enforcement boundary;
guidance is not a guarantee of live-model behavior.
The parent also supplies a readable task `name` (up to 100 characters) and a
kebab-case `slug` (up to 64 characters). The name identifies the activity and
inspection view; the configured agent remains the execution profile. A durable
parent-scoped slug index rejects reuse, including concurrent calls and later
sessions. Slugs identify one delegation within its parent, not a new global
conversation identifier. Existing children display their configured agent and
use their conversation id as the inspection slug.

Each agent definition contains:

- A parent-facing name and delegation description.
- A child system prompt.
- An optional Harness tool allowlist.
- An optional model override; absent inherits the parent's resolved model.

The shipped catalog includes `general` and `explore`, neither with a tool
allowlist. Explore's prompt directs read-only research through available tools,
including web search; its read-only role is instructional rather than a separate
tool restriction. Setting an agent array replaces the defaults. Maximum recursion
depth defaults to two (root, child, grandchild).
Each parent defaults to three active direct children; finished children count
until dismissed. Both limits are positive integer settings (`maxDepth`,
`maxChildren`) exposed in the desktop and TUI host defaults. Parent-local spawn
admission prevents parallel calls exceeding the limit. A child
inherits the parent's workspace root, creates its own durable conversation,
receives its own `AGENTS.md` snapshot, and starts from the delegated task rather
than the parent's transcript.

HarnessService inherits the parent's effective model and configuration slices
whose plugin definitions set `inheritConfig`. Sandbox opts in, preserving a
parent's execution selection. Explicit child selections win; other policies use
their ordinary configuration cascade. The kernel and subagents package do not
import sandbox implementations.

Children also inherit the parent's tool mode unless explicitly overridden. Their
own allowlist governs declarations, discovery, descriptions, and nested dispatch.
Activity/subagent enrichment is identical through direct tools and evaluator
discovery. A backgroundable call returns structured running/completed state and
an activity id alongside presentation text; code must use `activity_wait` when
it requires completed work rather than treating submission as completion.

Children receive a short task/profile/name/slug and direct-parent briefing from
existing spawn metadata, followed by the assigned task; no parent transcript is
copied. Global/project instructions are independently assembled for each child.

`subagent_list({relation, cursor?})` pages the caller's parent, siblings or direct
children with readable names/slugs and a preferred reference. Structured results
retain canonical conversation IDs. `subagent_send` accepts explicit `parent`, a
unique visible-family slug/name, or canonical ID fallback, checks the durable
family relationship, derives sender
identity from its tool context and delivers ordinary plugin input with `steer`.
Running recipients consume it at the normal safe boundary; idle recipients start
another turn, including after finishing. Submission acknowledges acceptance,
not a reply. No activity or separate lifecycle is created for a message.

`subagent_dismiss({to})` resolves a direct child's unique slug/name or canonical
ID and marks it dismissed. Ambiguous aliases reject rather than select a target.
One durable flag applies
to its subtree through ancestor lookup, freeing its parent's roster slot. Model
lists omit dismissed branches, and family sends to them fail, except that a child
can always send to its direct parent. Existing activity completion can still wake
a dismissed owner; it stays dismissed. Dismissed agents cannot spawn hidden
children. Dismissal preserves history and does not cancel existing activities.
GUI navigation omits dismissed branches before paging, including running counts
and child expanders; completed-but-not-dismissed work remains. History and direct
inspection/attachment remain available. The attached-root-scoped
`plugin.subagents.event` notification (`subagents.changed`, contract version 4)
refreshes navigation immediately; a selected dismissed side branch closes back
to the root. Configured tool allowlists still govern communication.

The subagent is itself backgroundable. Foreground completion returns the child's
final result. Background execution is tracked through the same activity tools and
completion delivery as commands. Parent/child metadata is stored in namespaced
plugin state; live handles and cascade-stop ownership remain activation-local.
The desktop header opens a paged tree of durable children, with nested
branches expanded and no collapse controls, grouped into Running and Finished.
Keep each branch in Running while any descendant runs, preserving each row's own outcome. Each level keeps bounded paging. Rows show Running, Completed, Failed or Stopped, and remain
available after work ends or the server restarts. Running means a matching live
runtime and persisted running turn; unowned stale running turns display Stopped
without starting work. Opening such a child uses ordinary crash reconciliation,
which records the interrupted turn as Failed without resuming it.
Names and parent links come from durable spawn metadata;
status reuses the ordinary turn record. No orchestration handles are recreated
merely to list children. Opening a historical child restores its durable ancestry
inside the ordinary canonical root attachment lease, preserving live delivery
and whole-tree teardown across restart.

Spawned conversation inspection uses the ordinary attach/history path, with a
full clickable ancestor chain and no composer, rename, worktree or Fork controls. The RPC
write boundary rejects mutations of marked children, including delivery,
reconfiguration and direct close/reload. Parent-owned task seeding and stop still
use the internal runner. Sidebar and Recents continue to exclude spawn marks.

Subagent activity peeks include a bounded in-progress assistant-text preview,
including commentary, alongside finalized assistant messages and tool entries.
Tool lines render `→ name argsPreview` and rewrite in place to `— ok` or
`— fail: contentPreview` (both previews ~100 chars, matched by callId).
Finalizing a message replaces its transient preview rather than duplicating it;
the terminal result still uses the finalized assistant message.

Closing/reloading a root deactivates its complete loaded conversation tree and
clears that tree's ephemeral parent/child index. Other roots remain independent;
connection shutdown closes all roots owned by that connection.

## Ownership and isolation

- A conversation can observe/control only activities registered with its manager.
- A child receives only its configured tool roster; withheld tools cannot be
  invoked through dispatch.
- Recursion is bounded structurally by depth and the absence of the subagent tool
  at the floor.
- Activity controls, subagent tools and `worktree_list` default to allow without
  approval prompts. Explicit per-tool policies still apply. Delegated filesystem,
  command and other tool calls retain their own approval policies.
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
