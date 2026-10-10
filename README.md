# Harness

A local-first, model/provider-agnostic coding-agent harness. It combines a
durable conversation core with Harness-owned tools, sandboxed execution,
approvals, project instructions, compaction, background activities, and
subagents through a typed plugin surface.

See `PLAN.md` for product direction and current subsystem status.

Prior attempts (reference only, not tracked here) live under `old/`.

## Development

Source development uses ordinary Node/npm (Node 22.23.3 in `.nvmrc`) and requires
Rust 1.90 or newer for the native binding. The
monorepo uses npm workspaces; cross-package
imports resolve to TypeScript **source** in dev via the `development` export
condition — no TypeScript compilation step is needed to run or test. The
`npm ci` builds the native binding; development and tests run from the checkout.
Stop source CLI/desktop processes before `npm ci` or `npm run native:build`:
Windows locks loaded native modules. Installed apps use their own immutable copies.

```sh
npm ci               # install dependencies and build the native binding
npm run dev          # run the CLI from source (tsx --conditions=development)
npm run desktop:dev  # Tauri desktop development
npm run desktop:build # development desktop build and installer
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm run check        # typecheck + lint + format:check + test (also runs in CI)
```

## Client/server modes

The desktop client uses Tauri 2, React, React Router data routes, Radix Primitives,
Tailwind v4, and Lucide. Shared typed controls use neutral surfaces, shallow
button bases, customizable pastel accents, and light/dark/system appearance.
The sidebar uses native Mica on supported Windows 11 versions and AppKit Sidebar
material on macOS, with solid themed surfaces elsewhere. A shared Terminal-branded
header uses library-managed Windows controls and native macOS traffic lights;
Linux retains its native frame. Dialogs dim the shared header and content together.
The same theme choice applies to content and window
chrome, including startup; custom accents remain independent.
It shows one selected conversation with live status for other open conversations,
streaming history, approvals, tool output and edit diffs. Conversations keep
independent turns and drafts while you navigate. Settings provide provider
sign-in, model and sandbox defaults, approval policy, auto-approver enablement and
reviewer model/preset, and light/dark appearance. Leave the reviewer model unset
to use each conversation's current model.
Model/preset and sandbox controls open from compact composer chips. Enter sends;
Shift+Enter inserts a newline; composer settings can swap those two. While working,
Steer is the default and Ctrl/Cmd+Enter queues. One primary button shows Send when
idle, Stop when working with an empty draft, and Steer when working with text.
Ctrl/Cmd+. stops while retaining the draft.
The context ring opens reported request accounting. Optional last-turn token
counts and request throughput share the current-status row above the floating
composer. A full-height conversation scrollbar supports reading earlier output;
three dots return to latest while working. Appearance and composer
preferences stay on the client, across hosts and restarts.

Windows desktop development requires Rust, Visual Studio C++ build tools, and
WebView2. `desktop:build` carries the complete development server payload;
native bootstrap downloads the pinned Node distribution into the shared cache.
The release build entry uses on-demand verified server and Node payloads without
requiring system Node. Public installers, publication and updates remain in progress
under the [release plan](docs/plans/cross-cutting/2026-10-10-release-installation-updates.md).
Release desktops expose an explicit update check and install/restart action in
Settings → Application. Source and development builds update by rebuilding.
Installed CLIs update with `harness update`: it verifies one signed latest release,
prepares that release's CLI and Node, and replaces the native launcher for the next
invocation. It only accepts a release newer than the running CLI and leaves the
server running. Windows keeps one
`harness.exe.previous` beside the installation until the next update; close older
CLI processes before updating again. Manual CLI uninstall removes those two files
and retains the shared home/data/cache.
Actual signed installer/update execution remains unqualified.
Installed launchers expose `harness cache prune` to preview cached downloads and
`harness cache prune --apply` to remove them. Stop installed CLI, desktop and server
processes first; cleanup refuses while any consumer is running. Conversations,
settings, credentials and the saved server selection remain. The next launch
downloads missing payloads again, so it requires internet after pruning.
Pruned development server builds need redeployment from their source checkout.
Docker remains
an external requirement for devcontainers, and execution tools use the host's
installed shell/programs. The current installer and native E2E qualification
target Windows; macOS/Linux desktop packaging is not yet qualified.

Desktop and TUI attach to the same background server for each execution
environment and OS account. Switching hosts or disconnecting preserves accepted
work. Installed clients prepare the newer of their required server release and the
saved selection on connect. They reuse newer owners and never downgrade. An older
idle server is replaced automatically; active turns or background work leave it
running and show a warning to finish/stop the work and reconnect. No separate server
update action is needed. Desktop exit defaults to stopping Local when no other client uses it;
enable the remembered keep-running preference for Local background work.
Remote stop/restart is explicit. Provider credential changes require an
explicit server restart. There is no tray or login autostart.
The exclusive database lock protects the server in its normal `~/.harness`
directory. Connections do not select alternative homes or profiles.

Both clients initially show Local. Desktop has a host switcher above conversations
and an agent command center for adding WSL/SSH routes and managing servers.
TUI opens its command center with Ctrl+G or `/hosts`; `--host` selects a saved route
and `--ssh` adds/selects a destination. Switching hosts leaves other hosts running.
SSH uses non-interactive OpenSSH authentication and host verification; configure
custom ports, keys and aliases in `.ssh/config`. WSL discovers installed distros.
The TUI uses the public bidirectional JSON-RPC protocol:

```sh
harness --connect-stdio
harness --ssh user@host --cwd /remote/project
harness resume --ssh user@host
harness --host saved-host-id
```

The shared headless owner is `harness server --background`; `harness server --bridge`
ensures it is ready and attaches stdin/stdout. Bridge EOF leaves its work running.
The launchers reuse this owner. New Harness homes are user-private;
background connections reject existing homes writable by other OS users.
`harness server --stdio` remains an isolated connection-owned entry point. It emits only NDJSON
protocol frames on stdout and diagnostics on stderr. The server owns its host's
store, settings, credentials, workspace, execution, activities, approvals, and
subagents; the SSH destination is therefore a trusted account boundary, not an
unauthenticated service. See the [client protocol](docs/protocol/client.md) and
[generated JSON Schema](docs/protocol/client.schema.json).

The controlling machine's `client.json` sits alongside global settings and stores
host routes and client preferences. Provider/model/tool settings
and credentials remain on the selected server. Remote deployment supports Linux
x64 glibc. SSH/WSL transfers a small verified bootstrap; the target downloads its server
and shared pinned Node runtime on demand. It needs internet for first installation,
but no installed Node, npm or compiler.
Released clients use signed release artifacts. Development uses a Linux payload
built with `npm run prepare:remote`; set `HARNESS_DEVELOPMENT_REMOTE_PAYLOAD` to
its output directory on the controlling machine. Upload stages code; restart
activates a rebuilt source payload. Existing released server selections are
preserved. Local offers browser
and device-code ChatGPT sign-in; WSL/SSH use device codes. Qualification evidence
is recorded in
[the release plan](docs/plans/cross-cutting/2026-10-10-release-installation-updates.md).

Repository guidance lives in `AGENTS.md`. See `docs/README.md` for the roles of
subsystem architecture, roadmaps, decisions, research, delivery plans, testing
guidance, and deferred-work records.

Public installation and updates are in progress in the
[release delivery plan](docs/plans/cross-cutting/2026-10-10-release-installation-updates.md).
`npm run release:payloads` builds separate CLI/server payloads. Source development
uses this checkout's `.harness-dev/source` home by default, keeping data and settings
separate from ordinary app use. A manual GitHub workflow bumps the version,
builds the platform artifacts, signs them and creates a draft release.
License collection and custom publication tooling are removed. Public installation,
and updates remain open; no release is published yet.

On Windows, local command execution is exposed to models as `powershell`; Linux,
macOS, and Linux dev containers expose `bash`. Windows sign-in uses DPAPI-encrypted
credentials; plaintext file storage is intentionally unsupported. Tool allowlists
that target both local Windows and dev-container sessions should include both
`powershell` and `bash`.

### Named provider connections

Add connections to the machine-global `settings.json` under your Harness home:

```json
{
  "version": 1,
  "providers": {
    "work": {
      "type": "litellm",
      "label": "Work gateway",
      "config": {
        "baseUrl": "https://llm.example.com/team",
        "apiKey": { "stored": true },
        "models": {
          "coding": { "transport": "openai-responses", "fileTools": "apply_patch" },
          "claude": { "transport": "anthropic-messages", "requestMaxOutputTokens": 8192 }
        }
      }
    },
    "personal": {
      "type": "openai-api",
      "label": "Personal OpenAI",
      "config": { "apiKey": { "env": "PERSONAL_OPENAI_KEY" } }
    },
    "subscription": { "type": "openai-codex", "config": {} }
  },
  "model": { "provider": "work", "model": "coding" }
}
```

Built-in types are `openai-api`, `anthropic-api`, `gemini-api`, `opencode-go`,
`openai-codex`, `mistral-api`, and `mistral-vibe`; default connections use IDs
`openai`, `anthropic`, `opencode-go`, `openai-codex`, `mistral-api`, and
`mistral-vibe`. Each named connection has
isolated credentials. Sign in through desktop Settings or
`harness auth login --provider work`. Additional named sign-ins preserve the
global model selection. Labels are editable; instance IDs identify saved
selections and credential slots.

OpenAI API, Codex OAuth, Anthropic, Gemini and Mistral API/Vibe connections accept
`"webSearch": true` in their provider config; the default is false. Search runs
inside the provider request. Clients show simple activity hints and unchanged
assistant Markdown, with exposed reasoning and assistant phases kept separate.
Harness owns local tool execution and conversation history; provider metadata
preserves required finalized native context. Tool declarations follow provider
configuration; `toolChoice` is forwarded to the native API for provider behavior.

API-key configuration defaults to secure storage. An `{env: "VARIABLE"}` source
uses only that variable; `{env: "VARIABLE", stored: true}` gives the environment
precedence over storage. OAuth instances own independent sessions and refresh
tokens. Every connection, including the defaults, uses instance-scoped slots in
the machine secret backend. This pre-release format has no migration: older
stored credentials require signing in again.

Mistral API and Vibe use API-key sign-in through the same settings/auth controls.
The default instances read `MISTRAL_API_KEY` and `MISTRAL_VIBE_API_KEY`
respectively, with secure storage as a fallback. Additional named instances use
secure storage unless you select an explicit environment source. Both stream
through stateless `https://api.mistral.ai/v1/conversations`, with optional native
web search. API discovery uses
`/v1/models` and Vibe discovery uses `/v1/model-catalog?surface=vibe-code`.
Discovery runs at server boot. The experimental Vibe catalog surface does not
establish subscription eligibility or billing behavior. Available context limits
and verified Vibe reasoning controls come from the catalog; output limits and
prices remain unknown when the server does not advertise them.

Every model call has the calling conversation's stable identity, including
subagents, compaction and auto-approval. OpenCode Go sends it as
`x-opencode-session` on all three transports; Mistral sends it as `x-affinity`.
Each child keeps its own identity. Retries and resume retain the conversation ID,
and both providers identify Harness with `User-Agent: Harness/<product version>`.

Compatible types are `openai-responses-compatible`,
`openai-completions-compatible`, and `anthropic-compatible`. They accept the same
secure key references and may supply a literal key for a local compatible
server. All connections use `providers.<id>`; `customProviders` is rejected.

LiteLLM refreshes its model catalog at server boot. `baseUrl` is the gateway root,
including any reverse proxy prefix. Models use exact gateway aliases; optional
entries override discovery or declare hidden aliases. Other models default to
Chat Completions and neutral file tools. Discovery failures appear in provider
status and preserve your saved selection. Configuration and credential changes
take effect after an explicit server restart.

The catalog carries explicit context, input/output limits, reasoning support,
thinking modes, advertised effort levels/defaults, and configured gateway prices.
The pickers show available limits and reasoning support. Unknown or conflicting
metadata stays unknown; LiteLLM's legacy `max_tokens` does not establish a context
window. Informational reasoning support does not invent generation presets.

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
Native web search is the only provider-owned tool enabled by the shipped
composition. File and command execution remains controlled by Harness.

### MCP servers and tool permissions

Desktop **Settings → MCP** and the TUI's **Ctrl+G → MCP settings** edit the selected
Harness host's global `plugins.mcp` configuration. Add local stdio processes or
hosted Streamable HTTP endpoints, then use **Test** to connect and discover tools
without executing one. Restart that host to activate saved configuration or
manually replaced credentials. MCP executes on the Harness host; its process and
network access are separate from conversation sandbox settings.

Environment variables and HTTP headers have explicit sources: plaintext literals,
host environment references, or stored credential slots. Bearer tokens and OAuth
client secrets use environment references or stored slots. Credentials use the
existing host credential backend and separate masked replace/delete controls;
settings contain references, and read responses contain presence/status only.
Stored slots are scoped to a server and bound to its configured endpoint or
stdio command. Changing that target requires re-entering credentials.

HTTP OAuth supports discovery, authorization code with PKCE, pre-registered
clients, supplied HTTPS Client ID Metadata Document URLs, DCR, and refresh.
Start sign-in explicitly in settings. The host owns the loopback callback and
token exchange; remote/headless clients can paste the full redirected URL.
Sign-in belongs to the initiating client connection and is cancelled on detach.
Tokens and registered client records remain on the host and survive restart.
Startup, Test, and tool calls never initiate interactive sign-in.

Permission choices are `allow`, `ask`, `ask-human`, and `deny`. Ask follows the
existing auto-review settings; Ask human always requests a human decision.
MCP resolves global MCP defaults, server defaults, then exact raw tool-name rules.
Read-only declarations default to Allow; other, unknown, or contradictory behavior
defaults to Ask. Enabling a server accepts its behavior declarations under these
defaults; configure overrides when appropriate. Direct and code calls use the
same permission path.

`plugins.approval.humanApprovalTimeoutSeconds` defaults to 60 and accepts a positive
duration up to 2,147,483 seconds. Desktop **Settings → Defaults** and TUI **Host
defaults** expose this shared approval setting. A human prompt waits within the
active call; expiry denies it, removes the prompt, and lets the agent continue.
There is no later execution of an expired call.

### Code mode and tool discovery

Set `"tools": {"mode": "hybrid"}` or `"code-only"` in settings or conversation
overrides; `direct` is the default. Desktop creation also offers a Tool interface
selector. `tool_search` and `tool_describe` are ordinary, immediately available
tools in every mode. Hybrid also offers ordinary capability declarations and
`eval`; code-only runs capabilities through `eval`, which accepts an async
JavaScript function body:

```javascript
const { paths } = await tools.call("glob", { pattern: "src/*.ts" });
return await Promise.all(
  paths.map(async (path) => ({
    path,
    first: (await tools.call("read_file", { path })).text.slice(0, 100),
  })),
);
```

Call `tool_search` with `{query: "read file"}` to discover definitions, including
descriptions and input/output schemas. Search excludes tools already declared or
discovered in the current context; compaction resets discovery tracking. Call
`tool_describe` with `{name: "read_file"}` for an explicit current definition,
including the output schema omitted by ordinary input declarations. The JavaScript
environment exposes only `tools.call`. Plugins declare direct/code
exposure independently of permission: ordinary tools default to both, deferred
tools use `{direct: false, code: true}`, and entry points can be direct-only.
Discovery never makes a deferred tool directly callable. Responses contain
complete definitions under a 64-KiB limit; oversized definitions are reported
without being marked discovered.
Tool allowlists, approvals, execution backends, activities, and subagent scopes
still govern each computed operation. Children inherit the parent's tool mode.

Calls return structured JSON when supplied, otherwise a content/status envelope;
custom tools accept raw strings. Errors and denials throw with `error.result`.
JavaScript controls child-call order: sequential `await` orders operations;
concurrent submissions such as `Promise.all` overlap, including foreground commands.
Direct model-call batches retain their existing sequential order.
Only explicit `emit`, text-only `emitContent`, and the returned JSON reach the
main agent. Nested calls remain visible in history and approval review. Completed
effects and emitted output survive later failures; scripts never replay or roll
back automatically. Each invocation uses a fresh bounded QuickJS worker without
ambient filesystem, network, imports, process, or credentials. Await all work;
ending the body cancels outstanding calls. Ordinary background activities retain
their own lifecycle and must be explicitly waited on when completion is needed.

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
