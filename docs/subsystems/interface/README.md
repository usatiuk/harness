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

Global, project and local settings files carry numeric `version: 1`. Profiles,
conversation overrides and RPC settings documents remain versionless fragments.
Unsupported file versions fail before writes; private pre-release files are not
silently migrated. `client.json` retains its existing numeric version 1.

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
connection entries do not choose homes or expose multiple server profiles.
Unix bootstrap checks home ownership against the process's effective UID directly,
without spawning host utilities that inherit AppImage library paths. The shared shipped
server acquires exclusive SQLite ownership before schema initialization and runtime startup.
The background owner supports authenticated multi-client attachment through
Unix sockets on Linux/macOS or local named pipes on Windows and a disposable stdio bridge. GUI/TUI default launchers reuse that
owner; explicit stdio mode retains its isolated composition.

Local communication never allocates an IP port or falls back to TCP. Discovery and
authentication live under `.running-server`; stable identity lives in
`server/identity.json`. Unix endpoints use a short account-private `/tmp` namespace,
independent of home length. Windows admission uses a narrow NAPI adapter enforcing
current-account DACLs and remote-client rejection; Node owns connected streams.
Canceled admission drains its overlapped operation before releasing memory and
handles. A dedicated wait thread leaves Node's filesystem worker pool available.
Management v1 inspection, exact-instance stop and conditional release work before
the application handshake; application RPC still requires its strict handshake.
Connect-time release upgrades use the same management stop with an idle condition.
The engine's existing busy check includes turns, queued input and plugin-owned
background activities. Claiming idle shutdown closes RPC admission synchronously.
The home lifecycle lock spans stop, monotonic selection and start. Busy owners stay
running with a finish/stop-and-reconnect warning; newer owners are reused and saved
versions never downgrade. Preparation downloads immutable candidates without
changing the selected owner. Remote bridges run the captured payload directly.
Windows headless integration is qualified; Unix endpoint cleanup and foreign-user/
remote Windows rejection remain explicit release qualification work.

Launchers execute the background owner directly. If startup adopts another
authenticated owner, it retires and joins its own superseded candidate before
returning, preventing that child from becoming a late replacement after Stop.
Cancellation before owner selection leaves the detached candidate independent.

The controlling machine's `client.json` registry is separate from server settings.
It initially contains only Local and stores structured WSL/SSH routes, selected
host. Keep-running is global configuration on the execution host, not client
connection metadata. Browser-safe contracts live in
`@harness/connections`; Node adapters atomically replace the registry under a
cross-process filesystem lock. The registry stays beside the controlling machine's
existing settings. Both clients offer host editors and lifecycle controls. SSH
accepts a destination/alias and uses OpenSSH BatchMode; advanced SSH configuration
belongs in .ssh/config. WSL distributions are discovered as editor choices.
All hosts use the verified pinned Node runtime through the shared bootstrap;
source development transfers an explicitly built complete Linux payload. There
is no target-PATH runtime choice. Installation paths are internal. Each saved connection owns an independent
client session, including two routes that reach the same background owner.
The isolated stdio launcher rejects host flags. Local auth/sandbox utility
subcommands also reject host flags; selected-host controls live in the command
center. Created TUI conversations persist when that client exits.

The project root is the nearest `.harness` directory, then Git root, then starting
directory, while the Harness home itself is never treated as a project. Shared and
local project settings remain separate layers. Plugin definitions contribute
their own Zod schemas and defaults; core configuration code treats their values as
opaque after central validation.

Plugin definitions may declare `configScope: "global"`. The resolver rejects
their project/local/profile/conversation contributions before merging; MCP uses
this declaration for its host startup configuration. Clients configure MCP
through the versioned `@harness/mcp/client` requests over their existing selected
host connection. Desktop has a structured MCP editor; TUI edits validated JSON
and supplies separate credential/sign-in controls. Both show safe status and
explicit restart requirements, without owning credentials or permission logic.
The shared approval timeout is part of their existing host-defaults editor.
Global compaction input-token thresholds use the same settings RPC: desktop
Defaults provides a numeric field (blank means automatic), and TUI selected-host
defaults expose `compactionThresholdTokens` (null means automatic). Save feedback
explains that already-loaded conversations require a server restart.

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

The kernel `tools.mode` setting accepts `hybrid` (default) and `code-only`
in the settings cascade or conversation overrides. Legacy `direct` values load
as `hybrid`. Desktop creation
exposes a Tool interface selector; settings-file changes take effect on reload.
Global `tools.showNames` (default true) controls the deferred-name list in model
instructions. Desktop Defaults exposes Show deferred tool names; TUI Host defaults
uses `showToolNames`. New or reloaded conversations use the saved value.
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
The stored secrets themselves are account-wide: Windows uses
`%LOCALAPPDATA%/Harness/credentials.dpapi`, keyring uses the `Harness` service,
and the file backend uses `~/.harness/credentials.json`. A separate source
development home isolates settings and conversations, but not these credential
slots; login/logout for the same connection can affect installed clients.

Desktop provider controls call composition-owned `app.auth.*` RPCs. Responses
contain authentication status and safe validation errors, never keys or tokens.
Settings → Providers also exposes native web search for supported connections,
enabled by default. Provider schemas opt safe fields into the generic editor with
final-node Zod metadata `{ harnessSetting: true, title, description }`. Safe status
reports only their descriptors and effective values, never full config or schemas.
The initial editor supports top-level booleans. Unsupported annotated shapes fail
as definition errors; unannotated credentials and complex config stay private.
`app.providers.config.update` accepts a patch of exposed fields, validates the
merged original provider config and atomically saves it, preserving other settings.
The GUI offers the existing explicit server restart to apply the saved choice.
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

The desktop owns one disposable Node bridge per connected entry. Installed builds
use paths prepared by the shared native bootstrap; Tauri development runs workspace
code with developer Node.
The desktop dev command builds the required Node native addon before starting
Tauri. Native builds copy to a fresh sibling file and rename it into place, so
macOS does not reuse code-signing state for an overwritten library inode.
Native close blocks new admission, cancels blocked writes, and closes every
bridge concurrently. A 20-second bridge deadline terminates that child and exits
unsuccessfully. Each server persists independently. Native preparation captures
one immutable complete server payload and its exact shared Node runtime under
the canonical home. TypeScript consumes those captured paths directly; there is
no second copied runtime or dependency-junction cache. Packaged development builds copy
and hash their complete payload, including native dependencies, before starting
an owner. A rebuild attaches to the existing owner until explicit stop; the next
start selects the new source snapshot. An isolated stdio launch first rejects a
live shared owner, preserving its selection.
Complete payloads carry a target native bootstrap. Production SSH/WSL verifies
signed release metadata and transfers that small bootstrap; the target downloads
the selected server and pinned Node. Source remote work accepts an explicitly
built Linux server archive. Both paths validate layout and identity before
atomic publication. Warm bridges open cached code and do not begin late downloads
when their observer leaves. Source remote deployment always uses downloaded Node,
without a target-installed Node alternative. Ordinary local source development
uses Node/npm directly and installs no payload or runtime. Source and release
builds currently pin Node 24.21.0 through `.nvmrc` and `release/node.json`.

One shared cache-use lock covers each running consumer. Preparation callers
acquire it before launching helpers; helpers return captured paths and exit.
The caller retains the lease through actual child completion. Detached owners
acquire their own lease before the initiating manager retires. The desktop
retains its prepared control runtime between calls and through shutdown.
The installed native launcher handles `harness cache prune [--apply]` before
acquiring its normal consumer lease. It previews/removes disposable payloads and
staging only under exclusive cache ownership, retaining persistent data and the
server selection. Missing releases download again; source builds need redeployment.
Cooperative cancellation drains final pipe writes while awaiting cleanup;
startup failure diagnostics take precedence over transport/teardown errors.
Failed Local startup includes the last 8 KiB of the current attempt's log in
the connection error, alongside its log path. Reconnect rejects with the same
diagnostic shown by the host view, preserving it through pending RPC disposal.
The release simplification and platform qualification remain in progress under
the [delivery plan](../../plans/cross-cutting/2026-10-10-release-installation-updates.md).
Settings → Application offers an explicit desktop update check and install/restart
action through the official Tauri updater. The native command verifies the offered
version again before installation; release configuration requires a signed version.
Development builds report that they update by rebuilding. Download/install errors
remain visible, and an installation failure after shutdown requires reopening the app.
On Linux the desktop owns the post-install relaunch: it spawns the installed
AppImage with the launcher environment stripped (`LD_LIBRARY_PATH`, `PYTHONHOME`,
`PYTHONPATH`, `APPIMAGE`, `APPDIR`) so the new instance starts exactly like a fresh
manual launch — the inherited bundled-library environment otherwise breaks host
binaries in the new instance's launcher chain on newer hosts. The relaunch is
attempted even after a failed shutdown, because the update is already installed,
and relaunch failures are reported on stderr instead of vanishing with Tauri's
silent restart path.
Window exit and the Windows installer share one awaited shutdown result so neither
can exit while the other is still retiring a helper. Hosted Windows checks qualify
signed installation and restart from v0.1.2 to v0.1.3; macOS/Linux desktop updater
execution remains unqualified.
The native `harness update` command captures a signed latest release, prepares
its Node/CLI payload, checks the launcher's reported version and replaces it for
the next invocation. It only accepts versions newer than the invoking CLI and
does not stop the server. Updates are serialized within the shared home, not
across independent `HARNESS_HOME` installations. Windows retains one
`.previous` launcher and refuses its deletion while an older CLI still uses it;
Unix uses an atomic rename. No helper subprocess performs deletion. A failed
Windows replacement restores the previous file; interruption between its two
renames requires manual restoration. Hosted signed CLI update execution passes
on Windows x64, Linux x64 and both macOS architectures for v0.1.3. New release
builds target Windows x64, Linux x64 glibc and Apple Silicon macOS; Intel macOS
release builds are discontinued.
The [Linux ARM64 delivery](../../plans/cross-cutting/2026-10-19-linux-arm64-support.md)
extends that pipeline with native `linux-arm64-glibc` server/CLI/bootstrap and
desktop AppImage artifacts plus `linux-aarch64` updater metadata. Native ARM
source CI passes; actual ARM release artifacts and production-signature checks
still gate publication. Earlier x64/macOS evidence is not ARM qualification.

The signed manifest retains its URL and format version and uses one normal
`targets` map. Its inventory accepts additional platform names while validating
every artifact descriptor; actual host/build/development target support stays
explicit and strict. Empty manifests and malformed descriptors reject. Signature
verification and cache writes retain the exact original signed bytes.
The 0.9.0 signing-key rotation intentionally breaks automatic upgrades from old
trust roots; those installations require manual installation. No legacy ARM root
extension, normalization, dual trust or signature bypass is retained.
Desktop exit conditionally releases all observed execution owners (Local, SSH
and WSL), including nonselected or already-disconnected hosts. The execution
host's global-only `desktop.keepServerRunning` defaults false and is read at
release time, not mirrored in client/native state. Settings → Application reads
and changes the selected host's value through existing settings RPC. The known
legacy client-local preference is accepted then stripped, never copied into a
remote config. Explicit Stop/Restart is independent of keep-running.

The server shares one conditional-release decision between public/management
controls. Explicit release relinquishes that socket; concurrent disposable exit
controls do not count each other as remaining consumers. A live/newly arriving
client still prevents stop. Ordinary socket closure never arms a deferred stop.
Host switching, manual Disconnect, TUI detach and network loss retain detach-only
semantics. False-default desktop exit may interrupt work when no other client
owns it; this is not a new idle timer or idle-only shutdown policy.

Logical desktop RPC closure shares one awaited physical bridge close with manager
teardown. Protocol, writer and acknowledgement failures release that observer;
discarded frames receive no credit. Native shutdown includes already-draining
bridges and waits for their shared completion before independent conditional
owner releases. Existing native exit obligations retain only target/expected
identity and coalesce aliases by authenticated server ID. Desktop-only bridge
reporting captures that identity from the same connection; normal CLI bridge
stderr stays unchanged. Remote exit controls use cached attach-only bootstrap:
no provisioning/startup or successor-owner stop. Failures remain bounded and
observable, not converted into missing-owner success.
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
label changes preserve valid observers and drafts. Connect/upload
requests are cancellable while waiting for registry adoption. Stop completion
closes its captured observer, so a replacement under the same saved ID survives.
Command results and Local/remote prerequisites have typed, validated contracts.

Installed desktop cache preparation runs in an internal hidden mode of the desktop
executable before window initialization. Its bootstrap uses the same immutable
cache as the CLI. The parent holds its cache lease before spawning preparation;
the helper returns captured paths and exits. That lease remains through child exit.
Cancel can terminate and join blocked HTTP/OS-lock preparation without abandoning
a blocking task in the app. The native connection channel publishes its operation
ID before preparation; the existing host abort signal reaches that operation and
awaits retirement. Shutdown closes admission before draining both preparations
and already-spawned bridges. Successful control helpers remain cached for the
app's lifetime.

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

The memory router's pathname and query are saved per host and mirrored into the
window hash only when the route changes. Fetcher cleanup and background router
updates do not rewrite browser history, avoiding WebView history rate limits
during transcript virtualization and conversation switching.

The desktop sidebar puts collapsible Projects above Recents, using the conversation's
original checkout when present and its current workspace otherwise. Worktrees stay
under their original project while retaining their actual path and worktree icon. Recents
starts with 20 chats; each project starts with five and adds five on Show more.
Folder summaries are paged in batches of 50. The application list view shares the
core conversation paging/projection boundary and excludes durable subagent spawn
marks before limiting results. Ordering and folder filtering happen in the store,
so older pages and child-heavy folders remain correct. Folder names have full-path
tooltips; duplicate names use their full path as the label.

Only successfully accepted nonempty user input (including queued input) advances
`lastUsedAt`; new chats use creation time. Opening, Stop, approvals, agent output
and tool activity do not change it. Accepted local sends, including queued input,
move the conversation and its listed project to the front in place. Loaded
conversation lists admit a touched root outside their current window; page objects
and cursors stay intact. Background plugin messages do not change this ordering.
Creation, workspace changes and connection reload refresh sidebar data while
preserving loaded page counts without polling.
The global desktop preference stores visibility and width (220px by default,
160–400px, constrained to leave main-content space). The resize edge supports
pointer dragging and keyboard arrows/Home/End; a show button remains available
while hidden. Section collapse and project hiding/collapse use the existing
host/server preference namespace. Hiding affects only the group, leaving its chats
in Recents. Opening or creating a chat there unhides it without changing collapse.
There are no project records, lifecycle settings or filesystem discovery.
Section labels use small muted uppercase text with right-side Lucide chevrons;
Show more is a compact ghost action. Navigation text is non-selectable. Project chats align with Recents and long
names truncate inside fully visible selected-row rounding. Running chats show a
small muted spinner; a separate unread dot marks live assistant text received
while another route is selected. This unread set is session-local, only tracks
attached conversations, and clears when opened or detached. It is not persisted
or synchronized between clients.

An icon-only header control opens the resizable right sidebar with Changes and
Subagents tabs. Changes displays one continuous, independently scrollable diff;
its paged file tree jumps to the selected file. Folder rows match file rows and
use Lucide chevrons with compact full-length vertical guides and green addition/red deletion counts.
Tree folders use the shared disclosure animation and reduced-motion preference.
Filenames stay on one line with ellipsis and full-path hover. File headers show
the same status and line counts as tree rows and toggle individual files. CodeView
owns collapsed layout; chevrons animate, while diff height changes immediately to
preserve virtual positioning. Tree selection reopens a collapsed diff. The diff
right-click menu exposes Word wrap and Line numbers, both on by default and stored
in desktop-local preferences across viewer remounts and application reloads.
Unwrapped code exposes a visible 8px horizontal scrollbar. Hunk metadata keeps
its native 32px row: one label spans the wrapped diff, or stays anchored within
the left scrolling pane in unwrapped split view. It does not add custom virtual
rows or couple the independent horizontal panes.
The comparison selector stays sticky at the top of the tree. Its header and the
file headers share an exact 45px height (32px control, 12px padding, 1px border).
The divider resizes tree height above the diff and tree width beside it. Tree width
defaults to 240px with a 180px minimum. Both requested widths are remembered per
root conversation in application memory, keyed by the existing host/server identity. They survive
close/reopen, conversation navigation and router/session replacement; descendants
share their parent's widths. Reload/restart clears this memory. The tree sits above the diff in a narrow panel and to its
right at 560px panel width. The default panel width adapts to the window; manual
resizing uses pointer or arrow keys and can fill the available layout except for
320px reserved for the main conversation. At narrow window widths it overlays the main
conversation and retains its close-sidebar icon. `@pierre/diffs` CodeView owns multi-file line virtualization, sticky file headers
and anchored file-ID navigation. It parses Git patches with line numbers; the actual diff pane switches to split view at
640px and uses unified view below it. Combined merge patches retain raw Git output.

Comparisons are Uncommitted (HEAD versus working content, including untracked),
Unstaged (index versus working content, including untracked), Staged, Against the
repository default branch, and Unpushed against the displayed upstream. The latter
two compare committed HEAD with the merge base, excluding dirty content and
upstream-only changes. Resolve a remote default HEAD (prefer origin), then local
main/master. Missing checkout/base/upstream has an explicit unavailable state.
No base selector or implicit fetch is provided.

The worktrees v4 plugin owns validated list/diff requests and server-side Git
reads. The server obtains the main conversation's current workspace from its
attached runtime, so Local, SSH and WSL use the same request path. Lists are
paged at 200 rows with nullable per-file addition/deletion counts (unknown for
binary or oversized previews), and Git listing output is bounded at 4 MiB. Visible file patches
load for rendered files and neighboring files in both directions, with at most four
concurrent reads and priority for the selected file. Patches belong to the comparison
and survive virtual row unmounts. Previews are bounded at 512 KiB / 10,000 lines, with
explicit oversized/binary states. The open Changes tab polls every two seconds
after each completed read; hidden tabs stop polling. In-flight reads finish before
the next poll, preventing starvation on slower remote connections. Cancellation
closes requests on selection/tab/lifetime changes. Atomic-save ENOENT is a
classified readable transient state; other errors remain visible and retry when
the tab/sidebar is reopened. Git supplies patches, including rename source paths
and index-removal comparisons; temporary comparison inputs never alter the index.

Subagents retains one connected, paged family tree rooted at the main parent,
which is a static label; only subagents can be selected. The tree stays rooted there
even when the main route displays a nested child. Running and finished outcomes
stay in their original branches. Selecting a row displays the existing live
conversation transcript beside the main conversation, with separate scrolling and
history paging. It has no duplicate identity header, composer, rename, worktree or
Fork actions, and adds no open-on-right/open-in-main controls. Tab switches retain
the selected transcript and diff position. Existing ConversationViews, client
attachments and ancestry APIs own all live data; no second runtime or history
store is introduced. The child header shows the full clickable ancestor chain. Turn
changes refresh the family tree even when no activity was created. Spawned
views use the same live transcript, but omit composer, rename, worktree and Fork
controls. Client writes to children are rejected by the server; the parent keeps
ownership of their execution. Activity titles include the owning subagent's
ancestor chain and a 22px Stop control beside Running. The existing GUI/TUI host
settings expose subagent depth (default 2) and active children per parent
(default 3; finished children count until dismissed). See [orchestration](../orchestration/README.md).

`@harness/client-features` shares plugin clients, transcript reduction, and edit
presentation with the TUI. Plugin browser entry points expose schemas and pure
presentation without importing execution or native dependencies. A virtualized
transcript renders Markdown, reasoning, tool arguments/output and diffs, while
history is loaded in byte-bounded pages and large items use range requests.

Both clients replace ephemeral message/reasoning previews with finalized items
and preserve canonical append order even when a search hint arrived during a
preview. Assistant phases remain preserved in stored/API data and provider
replay, but never affect presentation or appear as labels. Assistant text uses
normal styling regardless of phase. Simple provider activity text renders
without native payload inspection.
Cost displays indicate incomplete totals when rows are unpriced or native search
fees are unavailable. Models author Markdown links; no citation transformation
or provider-specific search-result UI runs in clients. Assistant and reasoning
Markdown use one recognizable content-link color/underline/focus recipe, separate
from navigation styling and the existing safe HTTP(S) opener.
Desktop groups all non-message transcript activity into Work groups: reasoning,
tools, provider/plugin activity, context, compaction, errors, and local notes or
shell output. Only actual user and assistant messages/commentary break groups.
Pending approvals/questions and composer/status controls are separate actionable
UI, not transcript cells. Failure remains visible in a group's summary; terminal
duration markers contribute to that summary instead of adding a duplicate row.
Streaming assistant articles expose busy state without appending a terminal-style
cursor rectangle below their Markdown; existing running/Stop controls remain.
Ordinary earlier groups collapse to a single summary row regardless of size;
deliberately opened/focused steps remain inspectable across supersession.
Only the latest group keeps a five-entry peek,
with an outer disclosure whenever entries are hidden. A latest group with
nothing hidden shows its rows directly under a plain title. Reasoning
remains separately collapsed; opening its compact Thought row mounts the full
smaller muted text. Reasoning rows show Thinking for X s while streaming and Thought for X s
when locally observed timing is available. The group summary shows Working for X s
while active, updating once per second from the locally observed group start.
A running turn shows a plain Working row before its first agent output; the
first content replaces that waiting indicator without creating history entries.
Completed live groups show Worked for X s with that local elapsed duration. Historical tool-only
groups use comparable server timestamps; historical groups containing reasoning
show Worked without timing. Client and server clocks are never mixed for elapsed
labels. Each call is counted once. Opening the group shows a flat list of
compact call rows, with small decorative tool icons at the same left edge as the
thought chevron and one-line argument previews. Clickable summaries and preview tool rows disable text selection; expanded body
text remains selectable. Tool chevrons sit on the right;
only failures show a status prefix after the icon, while awaiting approval remains
visible. Opening a call retains full arguments, output, diffs and approval facts.
Eval arguments and results have separate begin/result rows with subtle horizontal
boundaries. Child calls stay independently visible without opening their parent;
results follow the last available descendant, including nested Eval calls.
Desktop rows distinguish messages from nonrecursive, nonempty step groups.
The latest collapsed group shows a quiet tail of the last five nonempty
work entries plus explicitly opened or keyboard-focused steps, in chronological
order, including after completion,
until a newer group supersedes it; superseding folds the ordinary tail with the
shared collapse animation while retaining intentional reading exceptions.
The latest tail appears immediately when a virtualized
group remounts; restoration does not replay an opening animation. Expanding a
group adds exactly the hidden entries above the tail without remounting it, so
only the added rows animate. While expanded, the split stays at the same entry
as new steps arrive, preserving open tool/thought
details; closing restores the five-entry tail plus intentional reading exceptions.
An opened preview step keeps the same keyed DOM owner when it ages out of the
five; closing and leaving focus releases it. Nested output/diff disclosures do
not independently register whole-group retention. This is group-local state, not
a durable disclosure registry or unbounded suffix. Empty textual work rows are
omitted without dropping image-bearing messages or meaningful tool/shell rows.
Step rows render identically in the tail and in expanded details. A collapsed
reasoning row shows its Thinking/Thought label followed by an inline preview.
The second line uses the full row width, starting underneath the label. The
preview fills two lines using the browser's actual wrapping, then advances by a
whole wrapped line as a new line streams in. Its starting text stays fixed while
line two fills, rather than sliding by characters. Measurement uses a bounded
2,000-character buffer with whitespace collapsed; short text uses one line.
Resizing or a wider duration label reconciles the visible lines. Opening the thought leaves only the label in the summary
and renders the full original Markdown below, so the preview is not repeated. A faint left guide and small content
indent associate rows with their Work heading. Work paragraphs use 4px spacing;
compact reasoning previews collapse whitespace while expanded reasoning preserves
the original Markdown paragraphs.

Native named details allow one open outer Work disclosure and one open inner
conversation disclosure at a time. Only the outer Work container scrolls, capped
at 40vh, with a stable scrollbar gutter so expansion cannot shift row widths;
arguments, outputs and reasoning do not introduce nested scrolling.
Open tool/thought headers stick to the top of that scroll area with a one-pixel
overlap to prevent fractional-scale paint gaps, so their collapse controls remain
reachable. Soft wide oval scroll shadows on Work containers and sidebar navigation indicate
content above/below and disappear at the corresponding edge. Work shadows use a
pointer-transparent overlay above the scrolled content so opaque code blocks
cannot cover them. The shared observer
updates them on scrolling, viewport resizing and direct-row resizing/replacement,
including animated disclosure changes. No opaque background covers the native
sidebar material.

Sidebar and conversation disclosures share a short grid-height/opacity animation,
with reduced-motion support. Persistent disclosure content stays mounted to
preserve activity polling lifetimes. Previously lazy call, thought, group and
project-list bodies opt into Radix Presence, retaining content until the closing
CSS animation completes. No measured heights or JavaScript animation timers are
used. Finished-group inspection preserves the reading position; the existing
virtualizer measurement/follow handling owns transcript alignment. Grouping changes
presentation only and preserves history anchors when earlier calls merge into a
visible group. Loading earlier calls into a group can reset its disclosure to
closed; expansion state is not persisted. Clickable summary rows tint on hover
and keyboard focus.

Working summaries report activity, duration and tool count, not an aggregated
failure outcome. Individual tool/shell errors can be normal execution results;
they do not add a Failed badge, alert or red group styling. Existing per-call
error results and actual conversation errors retain their own presentation.

Earlier history loads automatically near the top of the transcript through the
existing bounded history action. A persistent intersection observer loads one page
per approach; an upward wheel event or the discreet keyboard-accessible marker
can request another page if collapsed history adds no height. Successful loads
do not rearm themselves. Failed loads wait for explicit Retry, and disconnection
stops automatic loading. Session-owned in-flight operations prevent duplicate
paging across route remounts of the same view. Sharing follows the attached view
lifetime; reloading a conversation gives its replacement an independent load. The final Start of conversation label preserves the
header height and reading anchor.

The activity dock shows only running work and hides when empty. Existing command
or agent names and a one-line output preview identify compact expandable rows.
Only one activity expands at a time. Each row keeps a compact Stop icon beside
its running label, available while collapsed as well as expanded.
Output uses the existing peek RPC immediately and every second while the visible
conversation owns the row, with no overlapping requests. Unmount or disconnection cancels refresh
and ignores late responses. There is no manual refresh control or Recent list;
completion results remain in ordinary conversation history.

Inline approvals, activities, usage, send/queue/steer/interrupt, model/preset,
sandbox controls, provider/default settings, and client-owned drafts/appearance
complete v1. Unavailable configured models/backends remain explicit choices;
creation requires an available model and a platform-supported backend.
Submitting the creation form saves its model, preset, sandbox and tool interface
as global defaults on the selected host before creating the conversation. The
existing settings API accepts partial updates, preserving unrelated policies and
tool permissions. Saving must succeed before creation; reopening the form reads
the saved defaults, including tool mode, rather than resetting it to Direct.

Desktop model choices use the existing Radix Select and Tooltip primitives:
provider/model names stay prominent, differing exact IDs are dimmed, and token
capacities/reasoning/presets appear on hover or focus. Aliases remain selectable
exact identities. Creation offers the chosen model's presets, inherits the initial
default, and clears the old preset when changing identity. TUI options use concise
provider/ID labels. Clients render catalog metadata without inferring vendor controls.

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

The conversation rename control is a compact 20px button immediately after the
title and before the worktree picker. The picker retains a fixed 12px branch icon
and truncates its label as horizontal space shrinks.

The desktop-local `ui.tsx` boundary provides typed native Button/Input/Select/
Textarea/Checkbox controls and Radix Popover/Dialog/AlertDialog/Tooltip/Tab wrappers.
Its shared ContextMenu wraps Radix root/trigger and themed portal content/checkbox
items, retaining library keyboard navigation, focus and dismissal semantics.
Semantic CSS tokens define canvas, sidebar, panel, fields, navigation and button
states; Tailwind v4 supplies layout utilities. Navigation stays flat and compact.
Buttons use neutral faces and shallow neutral/accented bases; a generic tinted
recipe derives face, border, base and states from one color. Destructive buttons
reuse it with an independent danger tint. Lucide supplies icons.
Sidebar navigation uses `IconLink` for real router anchors and `IconButton` for
actions, sharing the control recipe and tooltip rather than duplicating hover
surfaces. Native form/disabled/loading semantics remain with `Button`. Hidden
sidebar controls use the same header-padding/content-border geometry in CSD,
native and fullscreen modes, including the narrow layout.

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
bounded approvals/activities and the composer over a short neutral fade. Optional last-turn statistics sit below the composer; disabling them removes
the footer space. Keyboard hints live in settings, and no redundant Ready/Working
status label is shown.
A simple two-stop fade above the dock becomes solid just inside the rounded
composer, keeping its top corners soft and its footer covered. A measured footer keeps the
last transcript content clear of that dock; measured items contain their margins.
The virtualizer opens at the latest edge, follows while at bottom, and pauses when
the reader scrolls away. Three dots return to latest only during a running turn;
their visibility does not change dock/fade geometry. Earlier-history prepend uses
Virtuoso's logical `firstItemIndex` to keep measured row identities aligned rather
than jumping to a new index against old sizes. Same-key work-group prefix growth
captures a surviving visible child through Virtuoso's typed `components.Item`
boundary and reconciles when that item's measured-size prop matches its height.
There is no shared pending-anchor handoff or aggregate-height acknowledgement.
An inner Working scroller absorbs its
available displacement first; the page absorbs any remaining displacement below
or across the group's height cap. Details expansion decides bottom-follow from
actual scroll geometry rather than a delayed presentation notification, then
arms Virtuoso's native `autoscrollToBottom` instead of scheduling its own
post-measurement jump.
Desktop-local row identities are
projected at presentation publication, preserving streaming blocks through durable
commit; the server and shared reducer continue to own canonical transcript facts.
Each attachment owns its live reducer state, cached immutable React snapshot and
one pending timer. Text/reasoning publish at most once per 100 ms; semantic events
and disconnect flush preceding text immediately, and detach cancels pending work.
Connection notifications drive the host/app shell, sidebar notifications cover
list/title/status/unread changes, and content notifies only its conversation.
Unchanged rows/steps retain references for memoized message/work renderers.
Composer comparisons use only its actual state inputs; headers/history receive
narrow props and controls subscribe separately to connection state. Tool diff
preparation lives inside the disclosure's mounted body, preserving Presence closing
animations. Restart checks current turns/activities when clicked. See the
[delivery plan](../../plans/interface/2026-10-17-desktop-streaming-performance.md)
for measured work reductions and native-performance qualification limits.

Shared GUI dropdowns use themed Radix menus with value callbacks and canonical
hidden form fields; empty choices and disabled fields retain normal form semantics.
Text inputs keep native editing and use the same compact themed styling. Model
pickers retain their provider/ID detail tooltips. Popup/control spacing is compact,
with larger coarse-pointer targets. Redundant model/sandbox popup headings are
omitted. Shortcut hints use the platform modifier and concise wording.

Direct + code (`hybrid`) is the shared server composition default for new
conversations; explicitly configured choices override it.

Conversation headers sit above the scroll viewport and show a compact single title without a workspace subtitle;
full folder paths remain available on project and conversation hover. The compact
composer uses a short fade above the dock, keeping the lower dock covered
by the canvas background. Markdown
separators use the neutral line token and tight margins. Heading sizes scale with
conversation text; compact tool/reasoning text keeps its existing sizing. The
virtualizer uses fractional bounding-rectangle heights rather than default rounded
measurements, preserving bottom-follow across supported text sizes.

Linux uses WebKit's default rendering policy. The experimental
`PreferPageRenderingUpdatesNear60FPS` override was removed after isolated samples
already exceeded 60 callbacks/sec with the preference enabled and reproduced the
reported sluggish scrolling without establishing a benefit from the override.
The [frame-pacing investigation](../../research/2026-10-12-linux-frame-pacing.md)
records measurements and limitations. No direct WebKit FFI or extra runtime
version requirement remains for this experiment.

Appearance is applied at the document root before render, including portals.
The old `theme` preference is retained when no new appearance preference exists.
Client storage owns System/Light/Dark, pastel/custom accent, button depth/radius,
conversation text size (14px default, 12–18px in GUI Appearance settings),
send/newline mapping and statistics visibility. System
theme follows OS changes. The same preference sets Tauri's native theme (including
returning to System) before the initially hidden window is shown, and on live
changes without remounting routes. `WindowShell` owns one header above every route,
including startup/error states; `window-chrome.ts` and native `appearance.rs`
isolate window integration. Source development uses `Harness (Dev)` in native/custom
window titles and startup labels; packaged builds retain `Harness`.
Pinned `tauri-plugin-decoration` owns Windows controls,
native Snap hit testing and macOS traffic-light positioning. Tauri owns dragging,
double-click maximize and resizing. WebView2's native drag region opens the real
Windows system menu; Linux retains its native frame. Decoration activates after mount and before
showing the window. The header and document-level portal scrim share one dimming
color; window controls remain usable without dismissing modals. macOS traffic
lights use the same semantic opacity through a main-thread AppKit call. Ordinary
popovers do not dim the frame. Library fullscreen state removes reserved header
space. The restored Lucide Terminal mark also generates desktop app-icon formats
through `npm run icons --workspace @harness/desktop`.
The content stays explicitly in the expanding second grid row, including when
Linux native decorations or fullscreen hide the custom header. This preserves
full-height views and keeps Settings at the bottom of the sidebar.
Window-vibrancy, already used by Tauri,
installs Windows Mica or macOS Sidebar material; only supported installations
enable transparent document/sidebar surfaces. Unsupported platforms/versions use
solid themed surfaces; unexpected native appearance failures are fatal, with an
IPC failure reported through the native dialog before the existing close/shutdown
path. Main content and popovers retain opaque surfaces. The main panel's 1px
divider follows its rounded top-left corner and continues across the top edge.
With the left sidebar hidden, CSD uses a square main top-left corner.
Native decorations and fullscreen remove the top divider and make that corner
square when the custom header is hidden.
Host-area chrome uses one translucent hover/open/focus recipe; both sidebar
toggles use the same existing small icon-button geometry and expanded-state
accessibility, with positioning left to their layouts.
OS facilities own material
focus, transparency, contrast and power adaptations; pastel accents are independent.

Composer autosizing uses `react-textarea-autosize` consistently on every engine,
with the existing 52px CSS floor and `clamp(52px, 30vh, 320px)` cap before internal
scrolling. The library owns measurement; a width-only observer invalidates its
measurement after sidebar/container changes. There is no native-support branch
or second height algorithm. Vite retains workspace development exports and
standard module/browser conditions rather than forcing ESM import resolution
inside CommonJS dependencies.

Accepted send/Stop actions do not revalidate unrelated settings/provider state;
subscriptions already own transcript and touched-conversation updates. A local
submission-admission ref covers repeated events before React renders pending
state, released by the existing submit promise. Fetchers still own acknowledgement,
errors and draft reconciliation; there is no optimistic transcript insertion or
automatic resend.

Enter sends and Shift+Enter inserts a newline by default;
settings can swap them. Steer is the default while working; Ctrl/Cmd+Enter queues.
The retired delivery preference is ignored. One primary button shows Send while
idle, Stop while working with an empty/whitespace draft, and Steer with text.
With pending input, Stop is labeled Interrupt and explains that pending messages
run next. Empty Enter never stops; Escape in the message box
interrupts without discarding a draft. Unmodified Escape only acts while running
and leaves IME composition alone. Send and
interrupt retain independent pending lifetimes, so an outstanding delivery
acknowledgement cannot block interruption. Composition events never submit, and
keyboard/button submission share
the disconnected/empty/pending guard. Drafts remain keyed by host and conversation.
Pending plugin input appears as one expandable background-message count; human
queued input keeps its text. Consumed plugin input appears as an expandable
message inside Working, using its recorded origin, without a user bubble or fork
action. TUI uses compact origin labels and a pending count; verbose mode reveals
the message text. Neither client changes delivery order or model-facing content.

Both clients derive input utilization from the latest authoritative agent
checkpoint and its exact model, not the current selection or a naming/reviewer
call. A known max-input limit is the denominator (labeled Input limit); otherwise
an advertised shared context window is used and labeled accordingly. The
inspector shows both limits when known. Missing usage/capacity is unavailable,
and unknown uses a standard question-circle affordance rather than a dashed
masked ring. It remains distinct from zero usage and does not invent a
percentage. Output-only limits do not
establish input capacity; neither input-plus-output nor compaction's reserved
threshold is substituted for a window. Last-turn
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

Release installation, shared managed runtimes, connect-time server upgrades and
explicit client updates are implemented as described in the
[delivery plan](../../plans/cross-cutting/2026-10-10-release-installation-updates.md).
The plan separates source/native coverage from remaining published-artifact
installation, update and remote qualification. Desktop runtime selection follows
Tauri's own development/packaged mode, independently of Rust optimization.

- `packages/config`: settings schema, merge, discovery, resolution, and writes.
- `packages/connections`: client.json registry, authenticated background discovery,
  local/WSL/SSH adapters and immutable complete-payload deployment.
- `packages/server`: shipped composition, authentication, app RPCs, and stdio entry.
- `packages/cli`: auth commands, terminal lifecycle, and TUI.
- `packages/client-features`: shared plugin clients and pure transcript/edit presentation.
- `packages/desktop`: React Router UI/session, Tauri process bridge, packaging, and native E2E.
- `packages/client`: transport-neutral peer, client coordinator, domain helper,
  in-process transport, and Node NDJSON transport.
- `packages/service`: shared runtime ownership, server dispatch and client observers.
- `packages/auth`, `packages/secrets`: login methods and credential stores.

The earlier connection layer was qualified with actual Ubuntu WSL and isolated
OpenSSH Linux x64 glibc. The release replacement transfers a verified native bootstrap; the target
downloads server and shared Node without target npm or system Node. Source remote work uses `npm run prepare:remote` on Linux/WSL and an
explicit `HARNESS_DEVELOPMENT_REMOTE_PAYLOAD` directory on the controller.
Released server selections survive connections from other client versions;
source rebuilds attach to a live owner until stop and the next start. The real
SSH replacement scenario passes. Earlier native desktop and rendered TUI WSL
conversation evidence establishes the previous flow; current WSL and visible
desktop qualification are tracked separately. Local retains
browser and device-code sign-in; WSL/SSH use device codes without callback
forwarding. See the [release delivery evidence](../../plans/cross-cutting/2026-10-10-release-installation-updates.md).

Remote preparation now detects Linux x64 or ARM64 GNU libc before selecting a
runtime/cache/artifact. SSH and WSL share this target-selection path; musl and
unsupported architectures reject explicitly. A development `remote.json` must
match the detected target even when a candidate cache already exists. Build it
on the corresponding native Linux host; there is no relabeling or implicit
cross-compilation. Current isolated x64 OpenSSH cold/warm/owner/cancellation
checks pass; actual ARM hosted execution and live WSL qualification are recorded
separately in the ARM64 delivery plan.

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

## Conversation titles

The opened conversation header exposes a pencil on title hover or keyboard focus
(always visible on touch). It edits the title inline: Enter/check saves,
Escape/cancel discards. Saving uses `conversation.title.set`, restricted to an
attached conversation, with a trimmed nonempty title of at most 200 characters.
The engine reuses the conditional metadata write and `title.changed` event;
manual titles survive reload and supersede pending automatic suggestions.
The title event updates the header/sidebar without changing activity order or
message history. Failures keep the editable draft visible.

The server wires `@harness/conversation-titles` as a per-conversation service plugin.
Its persisted-input hook saves a 64-character excerpt of the first root user message and starts one
independent invocation. A usable result replaces that excerpt with a title capped
at 80 characters. Empty output, provider failure or cancellation leaves the excerpt.
The immutable message sequence prevents regeneration after resume or rewind;
existing conversations and subagents are not backfilled. An explicit metadata
overwrite wins over a pending suggestion by comparing the captured excerpt.

The plugin sends only a bounded first-message prompt (4,000 characters), with no
tools, history or workspace instructions, through the shared ModelInvoker.
Purpose `title` preserves tracing and billing without becoming an agent context
checkpoint. Naming does not hold the agent turn open or block navigation; session
deactivation uses generic service cancellation and disposal hooks. The plugin owns
the controller and pending invocation; core owns metadata writes and events. Internal
configuration, persistence, middleware and stream-invariant errors remain failed
tasks with safe diagnostics; cleanup completes before reporting those errors.

Desktop Settings → Defaults exposes the naming model and preset. The durable
setting is `plugins.conversation-titles.model: {provider, model, preset?}`; unset
uses the first turn's conversation model. Changes refresh loaded configurations
and affect future naming attempts. The saved title crosses protocol 6 in reads,
pages and `title.changed` events; desktop headers/sidebar and TUI resume choices
use it. No retry, periodic naming, separate queue or manual rename UI is added.

### Forking an earlier draft

The desktop user-message hover/focus action below the bubble and TUI `/fork` picker open an
independent conversation before the selected user message, with its text in the
ordinary editable composer draft. Neither action sends the draft or overwrites
the source draft. The source can keep running. Desktop forks also seed image
attachments in the editable draft; the text-only TUI reports the fork ID for
non-text drafts rather than silently dropping content.

Desktop user-message actions (Fork) and final assistant actions (Copy/feedback)
reserve a small row below content. Intermediate assistant actions sit to the right
of the text without a separate row. Only the last content in a settled turn gets
final placement; running turns and messages followed by more content stay compact
regardless of provider phase. Icons appear on hover or keyboard focus (always on
touch), without shifting message text. Copy uses the message
Markdown text through the browser clipboard API, shows success for 750ms and
reports failures inline.

### Provider and MCP setup

Desktop Providers offers Add LiteLLM gateway: ID, label, gateway URL and optional
API key. The existing app RPC validates/persists the provider configuration, then
the ordinary auth RPC writes its key to the selected credential backend. A failed
key write leaves a visible saved provider so the user can retry. Restart activates
its model catalog; credentials never enter settings JSON. Protocol 12 adds provider
creation, without a new provider registry or schema-form framework.

MCP uses a compact server list. Basic fields cover local command or HTTP endpoint
and authentication. Bearer setup exposes one password field bound to the existing
secret reference; blank keeps the stored value. OAuth exposes Sign in after Save.
Headers, environment sources, token references, client metadata/scopes and policy
overrides stay in collapsed Advanced sections. Test uses saved configuration and
does not replace the startup catalog. Status distinguishes saved/authenticated
state from active tools; restart remains explicit. Classified failures report a
safe stage and HTTP status/process code, never response bodies, SDK messages, URLs
or credentials. GitLab enterprise availability still depends on its instance;
successful OAuth alone does not prove MCP initialization/tool discovery succeeds.

Text selection uses native Highlight/HighlightText colors, distinct from the
user-message bubble in both themes. Native Windows rendering is not qualified by
the Linux browser fixture checks.

### Worktree and Docker management

The creation form offers a new-worktree choice for Git folders. The subtle branch
control beside the conversation title switches to a new/existing worktree or the
original checkout; it is disabled during running turns and the server also checks
background work. Opening the picker rereads Git branch names, including renames
made with ordinary Git commands. Default branches use `harness/<adjective>-<animal>`
with numeric suffixes for collisions; directories keep their UUIDs. The agent's
`worktree_switch` accepts optional `branch` only with `kind: "new"`; explicit names
are validated by Git. No desktop naming/rename control or CLI name option is added.
The picker shows a readable current-checkout card, up to five worktrees including
the selected worktree, and a Show all action for older entries. Other worktrees
are ordered by the latest conversation use or managed creation time, with stable
path ties; this derives from existing records without tracking filesystem changes.
Original/New actions are separated from selection. Sidebar grouping uses the
original project, with a worktree icon immediately before status indicators.
Settings → Defaults configures
the selected server's storage directory; Settings → Worktrees pages managed
checkouts and Docker environments. Deletion uses explicit confirmation, retaining
branches/history; Docker Stop preserves state while Remove discards containers
and keeps volumes. Failed opens retain a workspace control for recovery.

TUI supports `--worktree` at creation, `/worktree` for list/new/original/use/managed/
delete (`--force` explicitly discards dirty files), and `/docker` list/stop/remove.
Host Settings exposes nullable `worktreeDirectory`. All these use the same plugin
RPC boundary and server-owned lifetimes. Local sandbox shell/stop utility commands
also use the shared local server instead of provisioning independent containers.

Sidebar conversation rows and project names use 13px normal-contrast text and
compact vertical spacing. Section
labels stay muted and use normal case; project rows share chat styling with a folder icon, and
nested chat titles align with the project name. Recents have no extra indentation. Selection
uses a neutral translucent highlight without an accent stripe or outline,
preserving the native sidebar material on Windows/macOS. The scroll region keeps
a stable native scrollbar gutter with clearance for expanded overlay scrollbars
and its outer edge 2px inside the sidebar boundary. The track is transparent;
scrollbar width and interaction remain native.

The desktop is nonselectable by default, including Work headings, status labels
and action bars. Message bodies, expanded thinking, code/output, errors and
editable fields explicitly enable native text selection. Transcript selection
remains limited to the centered chat column; drafts retain native editing. Only
the inline text inside a user bubble is selectable, keeping padding out of the
highlight. The bubble clips native paragraph-selection paint at its rounded boundary.

Transcript rows use 6px vertical padding; user bubbles use 10px top and 6px
bottom margins so consecutive messages and work summaries stay compact.

## Async question forms

The `questions` v2 plugin contract carries pending question batches in attachment
snapshots and sends created/resolved notifications. The shared QuestionsClient
uses existing attachment buffering so reconnect snapshots precede live updates.
Desktop renders one question at a time beside the composer, with Back/Next
navigation and submission on the last question. Choices use a compact grid, and
expanded question forms are exempt from the support area's small scroll cap.
Hide/Show questions collapses the form while retaining its current question and
entered answers; it does not submit or dismiss the request. Comments use a
single-line input. TUI `/questions` opens
a panel while the normal composer remains available. Each question has clearable single or
multiple choices when supplied, plus a comment field. A comment alone is valid;
a blank answer is not submission. Each question can instead be explicitly skipped
using Skip on desktop or Ctrl+S in the TUI. Skipped questions count toward completing
the batch and are reported to the agent as skipped, not answered. Dismissal applies
to the entire request and remains separate. Closing a panel leaves
the request open. Requests are conversation-owned; after server restart, opening
a child conversation restores questions owned by that child.

### Host guidance editor

Settings → Instructions edits the selected execution host's fixed
`$HARNESS_HOME/AGENTS.md` through `app.instructions.get/update`. Guidance is not
included in routine settings reads and is never duplicated in JSON instructions.
The server supplies the path; clients cannot request arbitrary file paths. The
editor loads on demand and explicitly saves exact text, retaining dirty edits
through tab changes, unrelated revalidation and failures. Missing and empty files
remain distinct. Existing nonregular/symlink targets reject, errors are visible,
and atomic replacement preserves the existing mode (new files use 0600).
Existing runtime snapshots remain stable: changes apply to new or reloaded
conversations, not automatically to the next prompt in an already-loaded runtime.

### Desktop image content

The composer accepts pasted and dropped PNG/JPEG/GIF/WebP files, including
image-only messages, using public deliver RPC optional images. Shared protocol
validation enforces a 2 MiB combined decoded budget and matching signatures.
Image bytes stay in canonical log content, not client file paths or a blob store.
Per-conversation unsent images live in a router-owned memory map; accepted sends
clear only the captured attachments, preserving edits made while awaiting delivery.
Text drafts retain their existing storage. App restart loses unsent image drafts.

Transcript reduction retains image blocks for user/plugin messages and tool
results. Desktop previews open a Radix modal spanning the app with a dark backdrop
and top-right close button. The viewer surface receives initial focus, avoiding
a close-button tooltip; one Escape press or a click on empty space dismisses it.
Clicking the image leaves it open. The close control uses a subtle translucent
hover/focus fill against the dark viewer. Closing restores focus to its preview
trigger.
CLI displays image placeholders without base64. Accepted
images reconnect through ordinary history item references and chunk reads.
Image signatures determine media types for both browser and native file reads;
empty or generic browser File.type metadata does not reject valid images.
Normal browser `ClipboardEvent.clipboardData.files`, DOM drop files and the
paperclip's file input share FileReader ingestion. If paste exposes no files but
indicates image/file content, the handler starts `navigator.clipboard.read()`
inside the paste gesture. Screenshot blobs use the same FileReader path.

WebKitGTK 2.52.6 exposes copied local files as URI-list blobs through that browser
API, but cannot fetch their bytes from file URLs. Only these explicit file URIs
and Tauri native drop paths use a bounded desktop file reader. Tauri file-drop
handling remains enabled because actual Linux external drops did not expose DOM
Files. Client-local paths never cross conversation RPC. There is no native
clipboard reader, OS-specific clipboard branch, or clipboard dependency.

Ordinary text/HTML and visible non-file URLs keep browser editing behavior.
Plaintext-only paths remain text. Browser clipboard permission failures and
unsupported image contents surface in the attachment error. WebKitGTK 2.52.6
exposes no readable representation for raw JPEG-only native clipboard data;
that case reports an error. Copied JPEG files and PNG screenshots are verified. Shared protocol
signature/schema validation still owns canonical images and their aggregate limit.
One router-owned observable draft per conversation holds images, read count and
error, so pending reads remain visible across navigation and only accepted captured
attachments clear. There is no separate upload manager or persisted draft blob.

Actual Linux X11/WebKitGTK qualification covers file/bitmap/JPEG clipboard,
native drag/drop, chooser, send, exact PNG/JPEG file bytes, decoded screenshot
pixels, and equality of SQLite image payloads with model-request payloads.
Browser event injection alone does not qualify this OS boundary. Wayland,
Windows and macOS native execution remain unqualified.

Model-switcher option tooltips show image input as supported, unsupported, or
unknown using the existing model metadata; an absent claim is never shown as
unsupported. This is presentation only and uses the shared model selector.
