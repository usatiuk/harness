# Configuration and interface subsystem

## Status

Harness ships one shared server composition, an Ink TUI, and a Tauri/React desktop over a language-neutral
JSON-RPC client boundary. They may share a process or communicate over bounded
NDJSON stdio, directly or through SSH. Configuration is a validated cascade
resolved by the server; clients own presentation and user interaction but no
agent-loop or durable conversation semantics.

## Configuration

The settings document contains kernel model/instruction/tool fields, opaque
plugin slices, optional named profiles, and credential-store selection. Top-level
plugin keys and provider-specific configurations are validated strictly; typos and
unknown configured plugins fail with their source layer.

The resolution order is:

```text
service defaults
< global ~/.harness/settings.json
< project <root>/.harness/settings.json
< local <root>/.harness/settings.local.json
< selected profile
< durable conversation overrides
```

`HARNESS_HOME` is an existing installation/test override for `~/.harness`;
connection entries do not choose homes or expose multiple server profiles. The shared shipped
server acquires exclusive SQLite ownership before schema initialization and runtime startup.
The background owner now supports authenticated multi-client attachment through
loopback TCP and a disposable stdio bridge. GUI/TUI default launchers reuse that
owner; explicit stdio mode retains its isolated composition.

Local connection admission rejects a TCP socket whose connected local and remote
address/port pairs are identical before sending authentication. Some kernels can
self-connect to a stale listener port, echoing the client's own preamble. This
exact absent-peer condition uses the existing connection-unavailable path;
ordinary authentication and identity failures remain fatal to that connection.

The controlling machine's `client.json` registry is separate from server settings.
It initially contains only Local and stores structured WSL/SSH routes, selected
host and desktop keep-running preference. Browser-safe contracts live in
`@harness/connections`; Node adapters atomically replace the registry under a
cross-process filesystem lock. The registry stays beside the controlling machine's
existing settings. Both clients offer host editors and lifecycle controls. SSH
accepts a destination/alias and uses OpenSSH BatchMode; advanced SSH configuration
belongs in .ssh/config. WSL distributions are discovered as editor choices.
Runtime choice is managed or development; development finds Node on the target's
PATH. Installation paths are internal. Each saved connection owns an independent
client session, including two routes that reach the same background owner.
The isolated stdio launcher rejects host flags. Local auth/sandbox utility
subcommands also reject host flags; selected-host controls live in the command
center. Created TUI conversations persist when that client exits.

The project root is the nearest `.harness` directory, then Git root, then starting
directory, while the Harness home itself is never treated as a project. Shared and
local project settings remain separate layers. Plugin definitions contribute
their own Zod schemas and defaults; core configuration code treats their values as
opaque after central validation.

Project discovery and the global-root decision compare physical paths, including
Windows short-name aliases and junctions. Existing ancestors establish identity
before a new workspace/settings directory exists. A `.harness` directory alias
retains its account-parent boundary; repository-local writes remain local.

Conversation records persist workspace root and overrides. The complete model
and preset selection is pinned there at creation and survives resume/reload.
Explicit model/preset changes update that conversation and
the global default for new conversations; other existing pinned conversations
keep their selection. Other settings retain the cascade, including intentionally
global approval policy. Configuration mutations are serialized by the service;
settings writers coordinate by canonical file path and atomically replace files.
Sandbox changes deactivate and reload
the current conversation so its execution backend is rebuilt immediately.
Every complete `{provider, model, preset?}` selection is atomic wherever it
appears in the configuration tree, including named profiles and plugin-owned
reviewer models. Identity changes use a model-only API that clears the old
preset; preset changes use a separate API scoped to the current identity.

Named profiles exist in the resolver/schema, but the current CLI does not expose a
profile-selection workflow.

## Tool modes and inspection

The kernel `tools.mode` setting accepts `direct` (default), `hybrid`, and
`code-only` in the settings cascade or conversation overrides. Desktop creation
exposes a Tool interface selector; settings-file changes take effect on reload.
RPC carries mode, nested associations, structured values, and output references.
Desktop nests child operation cards under their evaluator with concrete
arguments, status, approval facts, and output; incomplete history pages retain
standalone children until their parent is loaded. The TUI marks children in
generic, verbose, and edit cards. Clients never execute guest code.

## Authentication UX

Provider plugins contribute types before asynchronous server bootstrap. Global
`providers.<id>` entries are validated by the chosen type before credential or
network access; conversation/project/profile layers cannot configure connections.
The auth registry exposes each connection's owned login method, and bootstrap
constructs one provider per available connection. `harness auth login` supports
named API-key methods and Codex OAuth. Classified credential/discovery failures
remain visible per connection; packaged defects fail startup. Saved selections
are preserved when unavailable. An unconfigured initial profile may use the demo.

Credential-store selection is pinned in global settings. Unsupported Windows
file/keyring combinations fail and direct the user to DPAPI rather than falling
back to plaintext.

Desktop provider controls call composition-owned `app.auth.*` RPCs. Responses
contain authentication status and safe validation errors, never keys or tokens.
Local offers browser OAuth with its cancellable localhost listener and optional
device-code sign-in. WSL/SSH use device codes: clients display the provider URL
and one-time code while the executing server polls authorization. Neither flow
forwards callbacks between computers. Both are cancellable; device authorization
expires after fifteen minutes. Auth changes
require an explicit server restart to rebuild the provider catalog. Credential
file mutations are serialized across store instances in one process; external
processes must not concurrently modify the same credential file.

Every connection uses uniform instance-scoped credential slots. Compatible
provider types use the same auth boundary; their literal key option supports a
keyless local server. Only `providers.<id>` configures connections, and schemas
live in plugin packages. There is no pre-release config or secret-key migration.
Auth RPCs reuse a live OAuth owner only for the same instance/type and secret
backend, so login/logout drain its rotation without borrowing another auth kind
when the connection type was edited before restart.

The model catalog RPC transports normalized capacities, reasoning metadata and
rate cards, with nullable unknown values. The domain client restores optional
fields; both pickers show known limits without deriving a context window from
separate input/output claims. Server bootstrap bounds the actual wire catalog.

## Session lifecycle

The client can create, attach, resume, reload, close, or list conversations. One
connection may keep multiple root scopes active while the TUI
shows one. A new conversation records its server-side workspace root and resolved
overrides. Background-connected clients retain created conversations across exit.
The isolated stdio TUI removes its own empty conversations when it exits.

The desktop owns one disposable bundled Node bridge per connected entry.
Native close blocks new admission, cancels blocked writes, and closes every
bridge concurrently. A 20-second bridge deadline terminates that child and exits
unsuccessfully. Each server persists independently. Local packaged execution
uses a private immutable Node/code/dependency cache, including the complete
packaged native dependency closure. The dependency cache keeps a real
`node_modules` directory beneath its content-addressed root: Node follows the code
junction and resolves transitive dependencies from that real directory. Layout
participates in cache identity so an obsolete layout cannot be reused. Startup
failure diagnostics take precedence over subsequent transport/teardown errors.
Fresh dependency promotion may retry a Windows `EPERM` once after 100 ms, while
holding the install lock and only if the completed source directory still exists
and the destination is absent. The same rename is retried; other errors and a
second denial propagate without publishing a code build or changing live files.
The keep-running preference defaults false; stop-on-exit releases Local only when
another client is not attached. Local background execution after desktop exit is
an explicit remembered preference. Remote observers detach without stopping their owner.

Logical desktop RPC closure shares one awaited physical bridge close with manager
teardown. Protocol, writer and acknowledgement failures release that observer;
discarded frames receive no credit. Native shutdown includes already-draining
bridges and waits for their shared completion before conditional Local release.
Local discovery/authentication/readiness and contention waits are cancellable.
A bridge observes EOF before readiness while holding early RPC input within the
transport bound; cancellation closes the observer and leaves launched owners
independent.

The shared headless owner (`server --background`) outlives clients, including
the `server --bridge` process that started it. Its private discovery directory
contains atomic stable-home identity, per-instance endpoint metadata and an
authentication secret. A bounded preamble authenticates before RPC and returns
the owner identity; connections reject a different canonical home or instance.
`server.info` reports that identity and `server.stop` acknowledges explicit shared
shutdown. Control uses a separate connection and a bounded drainage wait.
On normal teardown after RPC peer closure, the owner awaits admitted connections' writable
completion before destroying sockets, preserving queued Stop acknowledgements.
Pending authentication sockets close immediately; stalled output drainage is
bounded, while peer departure remains an ordinary transport closure.
NDJSON transport closure follows already accepted frames through the RPC
library's dispatch queue, so a final response received with EOF is delivered
before pending unanswered requests are rejected. Its internal closure marker is
recognized by object identity and is never a wire method. Peer closure remains
terminal even when an initialization handler or response finishes afterward.
Only classified SQLite startup contention permits bounded staggered starts;
broken packages and inaccessible or unsafe existing homes fail visibly. New
Windows homes use an ACL applied atomically at creation; existing homes are
validated without rewriting their ACLs. POSIX homes must be user-owned and not
writable by other users. After acquiring SQLite ownership, the new owner removes
any stale discovery name before publishing its atomic replacement. This permits
Windows recovery while ordinary readers still hold the old file open; clients
never remove discovery. Discovery is removed before releasing SQLite ownership.

Switching visible roots does not stop either conversation tree. A same-root reload is blocked
by a running turn and confirmed when background activities exist; acceptance
closes only that root and its descendants, aborts pending work, disposes its
plugin services, then attaches a fresh activation. RPC connection close removes its observer; shared server ownership preserves
accepted work. The explicitly selected isolated stdio launcher closes its composition
on exit. Other roots are unaffected by
closing or reloading one root.

`conversation.detached` reports that an activation is gone even when cleanup or
replacement fails. Clients discard its buffered events and plugin caches;
failure before teardown preserves the attachment. Attachment config comes from
the live runtime alongside fresh durable history/head state.

The service/protocol supports independent simultaneous roots. Parallel TUI
presentation is outside the current product scope; the existing screen shows one
conversation. Shared Docker controls surface their warning in that screen.

## TUI model

The TUI reduces typed events plus a durable resume seed into presentation cells.
It renders:

- Streaming/final assistant Markdown and chronological semantic stages. Compact
  mode groups consecutive unapproved reads/searches under a stable `Explored`
  tree; narration or any other action starts a new stage. Streamed reasoning
  settles as a timed `Thought` when timing was observed. Verbose mode retains raw
  reasoning and tool detail.
- Tool calls, arguments, result summaries, and approval progress. Failures,
  approved calls, edits, and unfamiliar/plugin tools remain visible in compact
  mode.
- Dedicated edit cards for Harness file-mutation dialects, with bounded colored
  patches in compact mode and the complete available patch in verbose mode.
- Context markers and compaction markers; verbose mode renders the complete
  persisted fold summary.
- Turn failures with nested provider error causes.
- One bottom-of-transcript `Working…` footer for the running turn. A terminal
  event replaces it with a session-local `Worked for …` row; reload/resume does
  not reconstruct historical work footers.
- Background activity state, pending input, sandbox progress, usage, cost, and
  context fill. If any completed invocation omitted accounting, totals are marked
  incomplete and no stale request is shown as the latest context checkpoint.

Visible conversation blocks are separated by one blank line. The maximal
finalized prefix advances into Ink static scrollback immediately; the suffix from
the first mutable entry stays live. Oversized live output clips from the top so
the work footer and input controls remain at the bottom. Toggling verbose mode
clears/reprints the static transcript so expanded reasoning/tool/compaction
content is coherent rather than layered over prior output.

The composer provides multiline input, cross-session history, command completion,
model/preset selection, delivery intents, approval prompts, and overlays for
resume/reload, activities, models, and sandbox configuration. `!command` uses the same
prepared execution backend as model-issued commands.

## Client boundary

The reusable boundary is the [bidirectional JSON-RPC protocol](../../protocol/client.md),
authored as strict Zod schemas with committed JSON Schema for non-TypeScript
clients. `@harness/client` coordinates initialization, attachment, bounded
history, and presentation-domain conversion. `@harness/service` owns dispatch
and shared root-scope lifetime through HarnessRpcHost.

Attachment returns a bounded snapshot, then ordered semantic notifications;
history is fetched independently through anchored byte-bounded pages. Plugins use
ordinary namespaced requests/notifications and optional bounded snapshots. The
TUI receives no service, runtime, process, activity-manager, sandbox, or raw
plugin-state object. Desktop uses the same contract over Tauri channels and
bounded native pipes. Both shipped clients reconnect to the background owner.

Every adopted shared connection registry reconciles execution targets before
publishing new metadata. Changed/removed routes cancel and detach their observers;
label/runtime-source changes preserve valid observers and drafts. Connect/upload
requests are cancellable while waiting for registry adoption. Stop completion
closes its captured observer, so a replacement under the same saved ID survives.
Command results and Local/remote prerequisites have typed, validated contracts.

TUI screens and session helpers live separately from the launcher and server
entrypoint. Presentation imports sandbox/approval client contracts; shared sandbox
configuration has one Node-independent schema source. RPC handler diagnostics
retain the registered method and fixed error class without arbitrary exception
names or content. Failed first runtime loads acquire no tree ownership; host
bookkeeping is pruned after the last active operation leaves no runtime.
Web/mobile/IDE clients remain unimplemented.

## Desktop model

React Router hash-route loaders fetch settings, paged conversation lists, and
anchored history. Actions and fetchers own mutations, pending states, and errors.
An application-wide session owns subscriptions and loaded conversation views;
route navigation leaves work running. Detachment clears stale views and
subscriptions so retry performs a fresh attach. Sidebar pagination survives
action revalidation.

`@harness/client-features` shares plugin clients, transcript reduction, and edit
presentation with the TUI. Plugin browser entry points expose schemas and pure
presentation without importing execution or native dependencies. A virtualized
transcript renders Markdown, reasoning, tool arguments/output and diffs, while
history is loaded in byte-bounded pages and large items use range requests.
Inline approvals, activities, usage, send/queue/steer/interrupt, model/preset,
sandbox controls, provider/default settings, and client-owned drafts/appearance
complete v1. Unavailable configured models/backends remain explicit choices;
creation requires an available model and a platform-supported backend.

Global settings expose the auto-approval plugin's enabled flag and optional
reviewer model/preset. An unset reviewer uses each conversation's current model.
The Settings action writes the reviewer selection globally; creating or saving
normal conversations does not persist a reviewer-model override.
Saving replaces that plugin's complete slice so clearing a reviewer removes its
model and preset. Other plugin slices and project/conversation overrides remain
intact. After saving, the server refreshes only approval and auto-approval slices
in loaded conversations, including children. It emits configuration changes and
retains model selections and service-backed settings such as sandbox ownership.

Vite excludes `src-tauri`, packaged `resources`, and test artifacts from its
development watcher. Cargo owns native builds; watching locked Windows build
executables can otherwise terminate the frontend dev server.

The desktop-local `ui.tsx` boundary provides typed native Button/Input/Select/
Textarea/Checkbox controls and Radix Popover/Dialog/AlertDialog/Tooltip/Tab wrappers.
Semantic CSS tokens define canvas, sidebar, panel, fields, navigation and button
states; Tailwind v4 supplies layout utilities. Navigation stays flat and compact.
Buttons use neutral faces and shallow neutral/accented bases; a generic tinted
recipe derives face, border, base and states from one color. Destructive buttons
reuse it with an independent danger tint. Lucide supplies icons.

Model/preset and sandbox chips reveal complete forms in popovers. Router fetchers
remain mounted above those portals. Destructive confirmations capture the
operation's form data or host identity before opening. The transcript remains
virtualized and uses the same centered measure as composer/support rows. Secondary
tool details use native disclosures with Lucide chevrons. Settings displays one
focused section through force-mounted tab panels, preserving form and sign-in
lifetimes. Its selected section belongs to the existing per-host router location,
so restarting the server restores that section. Appearance is available only in Settings. Creation is folder-first;
Connections separates saved-host editing from current-host actions and collapses
rare server controls. Startup/disconnected states center status, errors and actions.
Settings, providers, connections, startup and route errors consume the
same controls and tokens. The playground consumes those production recipes while
its sample conversation/host state remains isolated.

The conversation canvas owns one full-height scroll parent. A floating dock holds
bounded approvals/activities and the composer over a short neutral fade. Current
status and optional last-turn statistics share a row. A measured footer keeps the
last transcript content clear of that dock; measured items contain their margins.
The virtualizer opens at the latest edge, follows while at bottom, and pauses when
the reader scrolls away. Three dots return to latest only during a running turn;
their visibility does not change dock/fade geometry. Earlier-history prepend
preserves a surviving visible row and offset, with the newly available tool parent
as a fallback when grouping absorbs that row. Desktop-local row identities are
updated with each reduced event, preserving streaming blocks through durable
commit; the server and shared reducer continue to own canonical transcript facts.

Appearance is applied at the document root before render, including portals.
The old `theme` preference is retained when no new appearance preference exists.
Client storage owns System/Light/Dark, pastel/custom accent, button depth/radius,
send/newline mapping and statistics visibility. System
theme follows OS changes. Enter sends and Shift+Enter inserts a newline by default;
settings can swap them. Steer is the default while working; Ctrl/Cmd+Enter queues.
The retired delivery preference is ignored. One primary button shows Send while
idle, Stop while working with an empty/whitespace draft, and Steer with text.
Empty Enter never stops; Ctrl/Cmd+. stops without discarding a draft. Send and
interrupt retain independent pending lifetimes, so an outstanding delivery
acknowledgement cannot block interruption. Composition events never submit, and
keyboard/button submission share
the disconnected/empty/pending guard. Drafts remain keyed by host and conversation.

The context ring shows the latest agent request attempt against that exact
model's advertised window. Missing usage or capacity is unavailable. Last-turn
totals include all model attempts owned by that turn, excluding separate
child-conversation turns; throughput uses agent output divided by
server-measured agent request time, including latency and excluding tool/approval
waits. Missing accounting/timing is unavailable, and incomplete totals are lower
bounds. Reattachment restores these facts from the existing usage summary.

Only one conversation is visible. There is no IDE, side-by-side view, tray, or
parallel TUI presentation. External HTTP(S) transcript links open through the
scoped OS opener instead of navigating the application WebView.

## Accepted invariants

- Configuration is validated at the source boundary and resolved, not stored as
  a second canonical copy.
- Clients render canonical items/events and never decide agent control flow.
- A configured provider/backend failure is visible; fallbacks are explicit
  product choices, not silent recovery.
- Closing/reloading one root never interrupts another attached conversation tree.
- Every transport uses the same validation, correlation, cancellation,
  attachment, and plugin messages; stdout in server mode is protocol-only.
- Terminal scrollback remains usable during long streaming output.

## Source map

- `packages/config`: settings schema, merge, discovery, resolution, and writes.
- `packages/connections`: client.json registry, authenticated background discovery,
  local/WSL/SSH adapters, immutable built-bundle deployment and target dependencies.
- `packages/server`: shipped composition, authentication, app RPCs, and stdio entry.
- `packages/cli`: auth commands, terminal lifecycle, and TUI.
- `packages/client-features`: shared plugin clients and pure transcript/edit presentation.
- `packages/desktop`: React Router UI/session, Tauri process bridge, packaging, and native E2E.
- `packages/client`: transport-neutral peer, client coordinator, domain helper,
  in-process transport, and Node NDJSON transport.
- `packages/service`: shared runtime ownership, server dispatch and client observers.
- `packages/auth`, `packages/secrets`: login methods and credential stores.

The common connection layer is now qualified with actual Ubuntu WSL and isolated
OpenSSH Linux x64 glibc. It uses Node already on the target in development mode or
verified portable Node in managed mode, plus current locally bundled Harness code.
Desktop packaging shares this server/worker bundler. Code and target dependency
caches are immutable; refresh stages a build and activation requires explicit
server restart. Native desktop and rendered TUI WSL conversation flows qualify
host switching, client exit and fresh attachment to the same owner. Local retains
browser and device-code sign-in; WSL/SSH use device codes without callback
forwarding. See the [delivery evidence](../../plans/cross-cutting/2026-10-03-remote-hosts-background-servers.md).

## Verification

Tests cover settings precedence/validation/writes, auth registry and screens,
credential backend selection, session creation/resume/switching, commands,
composer/history/completion, transcript reduction/grouping/rendering, compact and
verbose edit patches, overlays, streaming/static scrollback, and CLI composition.
Protocol tests additionally cover both request directions, cancellation and
closure, bounded history/item ranges, multi-root isolation, plugin controls,
remote approval, and NDJSON framing/backpressure. Platform-specific credential
tests run only on their supported systems.

Actual native Windows E2E covers concurrent conversations and approvals,
draft/keyboard behavior, queue/steer/interrupt, settings/presets, diffs and large
output, paged/virtualized history, secure key storage and restart, crash recovery,
database contention, and real PowerShell/Node cleanup. See
[testing guidance](../../TESTING.md) and the
[desktop delivery evidence](../../plans/interface/2026-10-03-desktop-v1.md).
