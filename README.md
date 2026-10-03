# Harness

A local-first, model/provider-agnostic coding-agent harness. It combines a
durable conversation core with Harness-owned tools, sandboxed execution,
approvals, project instructions, compaction, background activities, and
subagents through a typed plugin surface.

See `PLAN.md` for product direction and current subsystem status.

Prior attempts (reference only, not tracked here) live under `old/`.

## Development

Node >= 22 (see `.nvmrc`). The monorepo uses npm workspaces; cross-package
imports resolve to TypeScript **source** in dev via the `development` export
condition — there is no build step to run or test.

```sh
npm install          # link workspaces, install husky hook
npm run dev          # run the CLI from source (tsx --conditions=development)
npm run desktop:dev  # Tauri desktop development
npm run desktop:build # Windows release and NSIS installer
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm run check        # typecheck + lint + format:check + test (also runs in CI)
```

## Client/server modes

The desktop client uses Tauri 2, React, React Router data routes, and Radix Themes.
It shows one selected conversation with live status for other open conversations,
streaming history, approvals, tool output and edit diffs. Conversations keep
independent turns and drafts while you navigate. Settings provide provider
sign-in, model and sandbox defaults, approval policy, auto-approver enablement and
reviewer model/preset, and light/dark appearance. Leave the reviewer model unset
to use each conversation's current model.
Ctrl/Cmd+Enter sends the composer; running turns support queue, steer, and stop.

Windows desktop development requires Rust, Visual Studio C++ build tools, and
WebView2. `desktop:build` bundles Node, the shared server, and its native/runtime
dependencies; installed users do not need Node or this checkout. Docker remains
an external requirement for devcontainers, and execution tools use the host's
installed shell/programs. The current installer and native E2E qualification
target Windows; macOS/Linux desktop packaging is not yet qualified.

Each desktop application owns one hidden background server. Closing its window
cancels and drains all owned conversations and processes before quitting. Server
crashes are visible and can be restarted; completed history remains durable,
while in-flight work is not resumed. Provider credential changes require an
explicit restart, which stops active work. There is no tray or shared daemon.
GUI and TUI use the same Harness home, with an exclusive database lock allowing
one server at a time. Quit one before starting the other. `HARNESS_HOME` selects
an alternative home for isolated profiles; the default is `~/.harness`.

The TUI always uses the public bidirectional JSON-RPC protocol. By default the
client and server share one process through an in-memory transport. The same TUI
can spawn a local stdio server or a fixed remote SSH server command:

```sh
harness --connect-stdio
harness --ssh user@host --cwd /remote/project
harness resume --ssh user@host
```

The headless entry point is `harness server --stdio`. It emits only NDJSON
protocol frames on stdout and diagnostics on stderr. The server owns its host's
store, settings, credentials, workspace, execution, activities, approvals, and
subagents; the SSH destination is therefore a trusted account boundary, not an
unauthenticated service. See the [v1 protocol](docs/protocol/client-v1.md) and
[generated JSON Schema](docs/protocol/client-v1.schema.json).

Repository guidance lives in `AGENTS.md`. See `docs/README.md` for the roles of
subsystem architecture, roadmaps, decisions, research, delivery plans, testing
guidance, and deferred-work records.

On Windows, local command execution is exposed to models as `powershell`; Linux,
macOS, and Linux dev containers expose `bash`. Windows sign-in uses DPAPI-encrypted
credentials; plaintext file storage is intentionally unsupported. Tool allowlists
that target both local Windows and dev-container sessions should include both
`powershell` and `bash`.

### Execution backends

The `sandbox` plugin selects one execution backend per loaded conversation:

- `local` runs workspace tools directly on the host.
- `native` (Linux only) runs commands in Bubblewrap. The host filesystem is readable, temporary
  and runtime directories are private, workspace writes and network access are independently
  configurable, and built-in file writes enforce the same workspace boundary.
- `docker` runs execution-backed tools in the workspace's dev container.

The global setting (also configurable with `/sandbox`) is:

```json
{
  "plugins": {
    "sandbox": {
      "backend": "native",
      "native": { "workspaceWrite": true, "network": true },
      "docker": {
        "configPath": ".devcontainer/devcontainer.json",
        "idleTimeoutMinutes": 10
      }
    }
  }
}
```

Sandbox configuration changes are saved globally and in the current conversation override, then
Harness reloads that conversation so backend, workspace-write, and network changes apply
immediately. A running foreground turn must finish or be interrupted first; live background work is
confirmed and stopped by the reload. Selecting `native` then fails normally if `bwrap` is missing or
cannot create namespaces; it never silently falls back to host execution. `/reload` performs the
same clean reactivation without changing settings.

The headless service supports independent concurrent conversations; the TUI
continues to show one conversation. Model/preset choices are pinned at creation,
while an explicit selection also sets the global default for new conversations.
Docker conversations using the same project/devcontainer recipe share an
environment. Closing one releases its own work; the last close removes the
owned environment. Shared stop/rebuild warns affected conversations and proceeds.

Routine Native calls run inside Bubblewrap without approval. Harness-executed function tools can
opt into explicit host escape with `executionFunctionTool`; their schema then exposes
`sandbox_permissions: "require_escalated"` plus a required `justification`. The existing approval
middleware classifies that call as outside the workspace before execution. After approval, only
that tool invocation receives the host execution context. The Harness-owned Anthropic editor and
the OpenAI-style freeform `apply_patch` tool implement the same behavior in their own wire formats.
Provider-owned execution tools are intentionally outside the current product
surface; all execution tools offered by the shipped composition are controlled
by Harness.

### Project instructions

The standalone `agents` plugin loads hierarchical `AGENTS.md` guidance for every conversation,
including subagents. At session load it snapshots files from the host filesystem root through the
conversation cwd into the cache-stable instruction prefix, ordered broadest to most specific.
Because outside-workspace instruction reads share the approval boundary, compositions register
`approval` before `agents`; the plugin host rejects the unsafe reverse order.

When a Harness-owned structured file tool accesses a deeper or approved outside-cwd path, the
plugin appends newly applicable `AGENTS.md` files as keyed context items after the tool-call batch's
results.
Those keys deduplicate within the active context and follow the conversation branch automatically:
rewind restores the selected branch's loaded set, while compaction drops older nested markers so a
later file access reloads current instructions. V1 does not parse shell commands, watch files for
changes, or discover container-only instruction trees.

Native v1 treats Harness's own `.harness` output persistence as trusted internal IO, so large or
background command output may update `.harness` even when `workspaceWrite` is disabled. Built-in
write/remove operations reject paths that resolve outside the workspace, but that check and the
host operation are not atomic against a concurrent process replacing a path with a symlink. A
future version should execute these mutations inside the Bubblewrap boundary; v1 does not claim
protection against that race.

### Layout

Packages under `packages/*`, layered one-directionally:
`protocol → store → core → service → server`, with CLI and desktop clients over
the public client boundary. Tools and model providers are plugin contributions
wired in at the `server` composition root. Providers declare
which file-tool dialect a model expects; `workspace` owns and executes every concrete file tool,
while `agents` independently supplies hierarchical project instructions around those calls.
