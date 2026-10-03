# Remote hosts and background servers

Date: 2026-10-03. Status: product and architecture research, selected for delivery.
[The active delivery plan](../plans/cross-cutting/2026-10-03-remote-hosts-background-servers.md)
records implementation choices and current qualification evidence. The foundation
section below describes the pre-change code that motivated the design.

## Confirmed product direction

- Desktop starts with a built-in `Local` host and initially shows one selected
  host, with a switcher above the conversation list. Other hosts keep running when
  selection changes.
- Keep host sessions independent of the selected sidebar filter so a combined list
  grouped by host can be added later without changing execution ownership.
- Desktop provides GUI connection editors for WSL and SSH; TUI provides equivalent
  discovery, add/edit, selection, and connection/server controls. Saved connections
  are shared between the two local clients.
- Separate client connection/preferences configuration from the existing
  server-owned settings. Each server resolves settings on its own host; both
  clients read their connection registry on the controlling machine.
- Support a simple development connection mode using Node already installed on
  the host. The client builds from the current local source and automatically
  transfers the built Node bundle and dependency metadata, then prepares/reuses
  remote runtime dependencies. Manual source synchronization or a remote
  repository checkout is not part of the normal workflow. Managed portable
  packages are a separate provisioning option.
- Reconnect reads fresh server state and history. Reconstructing an already-running
  partial response is outside the initial scope; show running status and wait for
  the complete persisted text.
- Investigate shared background servers, WSL, SSH, and a common desktop/TUI
  connection model. The user also raised preventing duplicate servers on one PC;
  the proposed scope below needs confirmation as part of the eventual design.

Exit defaults, simultaneous control from multiple clients, remote provisioning,
transport authentication, supported platforms, and upgrade behavior remain
proposals in this research snapshot; the active plan records the selected defaults
and delivery requirements.

## Existing foundation and constraints

The [current interface architecture](../subsystems/interface/README.md) and
[protocol v1](../protocol/client-v1.md) already put both clients on the same
bidirectional JSON-RPC boundary. The TUI can run the fixed SSH command
`ssh -T -- <destination> harness server --stdio`; the remote installation must
already exist. The previous [transport delivery](../plans/cross-cutting/2026-08-15-transport-agnostic-client-server.md)
qualified stdio but did not exercise an actual configured SSH host.

Important source boundaries:

- `packages/server/src/index.ts`: `buildServerHarness(connection)` builds one
  composition and one RPC session, acquiring exclusive SQLite ownership before
  runtime startup. Its approval forwarding is tied to that session.
- `packages/service/src/rpc-session.ts`: connection shutdown force-deactivates
  every root the session owns. Attachment failure can also tear down newly owned
  work. Disconnect currently means cancellation and disposal.
- `packages/desktop/src-tauri/src/main.rs`: the native bridge owns one bundled
  child, closes its input during shutdown, and uses `kill_on_drop`. It needs a
  different relationship to a persistent server and multiple connections.
- `packages/desktop/src/session.ts`: one `DesktopSession` stores views and
  subscriptions; navigation already leaves other conversations running.
- `packages/desktop/tools/package-server.mjs`: packaging copies Node and bundles
  JavaScript plus native/runtime dependencies. This is a portable directory
  layout, not currently one self-contained executable.
- `packages/protocol/src/client-protocol.ts`: attachment includes status, queued
  input, usage, and plugin projections. It does not include an active partial
  assistant response or a replay cursor.
- `packages/openai-codex/src/oauth.ts`: provider login listens on server-local
  loopback. Opening its browser URL on a different computer does not by itself
  route the callback back to the server.

The existing database lock should remain the final exclusion authority. Discovery
and attachment must complement it rather than introduce a second canonical lock.
Completed conversation history survives normal restart; in-flight work does not
resume. The database is currently a disposable pre-release format, so remote
upgrades cannot promise transcript preservation without addressing the existing
schema-compatibility policy.

## Proposed server and host model

A host represents an execution environment, an OS account, and a Harness home.
Examples are native Windows, Ubuntu under WSL as a particular Linux user, and an
SSH account on a Linux workstation. Each owns its conversations, workspace paths,
settings, credentials, and execution backends. Client appearance, drafts, saved
connection entries, and selected host are client concerns.

Recommend at most one running server per environment/account/canonical Harness
home. Desktop and TUI attach to the same owner instead of fighting over SQLite.
Different explicit `HARNESS_HOME` values remain isolated profiles. Windows and
each WSL distro need distinct servers even on one physical PC. A physical-machine
singleton would prevent the requested Windows/WSL workflow.

Saved connection labels and addresses are routes to a server, not its identity.
Two SSH aliases reaching the same account/home should discover the same server
and avoid duplicate UI sessions. A stable home/server identity and a per-process
instance identity would distinguish that case from a restarted server. Do not
assume matching hostnames or directory strings prove matching authority.

Clients perform an ensure-and-connect operation: discover and authenticate the
existing server, or start one and wait for explicit readiness. Simultaneous starts
must converge through the existing database exclusion mechanism. Handle classified
startup contention with a bounded readiness wait; incompatible versions, broken
packages, and inaccessible homes fail visibly. A discovery file or PID alone is
not proof of a usable or dead server.

## Lifetime and multiple clients

Separate these operations in the protocol and UI:

| Operation                                 | Proposed effect                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Select another host/conversation          | Change presentation; existing work continues.                                    |
| Detach a subscription or lose a transport | Remove that observer; accepted server work continues.                            |
| Stop a turn                               | Cancel that turn using existing server semantics.                                |
| Close/reload a conversation runtime       | Explicitly affect that root and its descendants; all clients observe the change. |
| Stop/restart a server                     | Drain or explicitly cancel its work and disconnect all clients.                  |

The composition should own one service/store and admit several RPC sessions.
Sessions own their subscriptions, bounded writer queues, and request correlations;
the server owns active root runtimes and their resources. Runtime activation must
be shared, so a second attachment or its failure cannot dispose another client's
work. Accepted user input must not inherit a departing transport's cancellation
lifetime. Requests such as cancellable authentication retain an explicit,
operation-specific lifetime rather than making every request immortal.

Allow desktop and TUI to view/control the same conversation as the same trusted OS
user. Keep the existing server-authoritative send/queue/steer/interrupt rules. For
an operation requiring an idle runtime, evaluate the actual server state; do not
introduce editor locks or a multi-user permissions system merely to reconcile two
views. Show shared consequences for restart, reload, and shutdown.

Unobserved idle runtimes can unload through the existing idle/disposal contracts.
Running turns, queued input, pending approvals, processes, and background
activities keep their resources alive independently of observer count. Keep host
overview subscriptions small and fetch history only when useful. A slow or broken
client may lose its connection under the current byte limits; that must not cancel
canonical server work or stall healthy clients.

The existing approval forwarding must follow the same runtime ownership boundary:
today a failed server-to-client request causes the approval to be denied, and
pending approvals are not in the attach snapshot. Preserve the kernel's pending
request as authority, expose a bounded projection, and accept decisions through a
server-side request. The first valid decision resolves it; other clients learn it
was resolved. Client presence does not introduce a separate approval policy or
setting. Existing deny/auto-review policies continue to decide according to
configuration.

Pending approvals are live state in the background server. The desktop/TUI need
not be running for the request to remain pending and appear on a later attachment.
Auto-review can reduce human intervention for unattended work, but is not required
to retain approvals across client disconnects.

Reconnect discards transient client state and uses a fresh bounded attachment,
plugin snapshots, and durable history. Preserve local drafts separately. For an
already-running response, show running status and wait for complete canonical
text; do not render a received suffix as the whole response. Later responses can
stream normally. Do not add partial-response snapshots, event replay, or a durable
replay log for the initial implementation.

A request timeout cannot establish whether a mutation was accepted. For example,
the server accepts a send and starts its turn, then the link fails before the
acknowledgment reaches the client. Transport closure rejects pending RPC waits;
it does not undo accepted server work. The current `RpcPeer` exposes cancellation
and closure handling, but no universal default request deadline. Define appropriate
deadlines for connection/startup and ordinary short RPCs when adding remotes;
pending human input is server state rather than a client RPC that must stay open.

On a lost response or timeout, report the unknown outcome and reconnect from fresh
server state without automatically resubmitting mutations. Fresh history/pending
input/status shows the current conversation; it need not prove which identical
message belonged to an unacknowledged request. Any resend remains an explicit user
decision. Automatic mutation retry and its delivery-deduplication machinery are
outside the initial scope. Changed closure/approval semantics still require
explicit protocol evolution rather than silently changing the v1 contract.

## Client and server configuration

Name the split by ownership, not physical location: the local native server also
uses server configuration. Propose a separate `client.json` beside the controlling
machine's existing global `settings.json`:

| Configuration                                                       | Read/written by                                                | Owns                                                                                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<client-home>/client.json`                                         | Local desktop/TUI connection management.                       | Saved WSL/SSH entries, labels, launch/runtime choices, optional target Harness homes, and client preferences.               |
| `<server-home>/settings.json`                                       | The server on its own host, including the native local server. | Existing model/provider defaults, approval and auto-review policy, sandbox/plugin settings, and credential-store selection. |
| Project `.harness/settings.json` and `.harness/settings.local.json` | The selected server's existing settings cascade.               | Existing project and project-local execution settings.                                                                      |

The default directory is `~/.harness` on each respective host. Client config stays
on the controlling machine when selecting a different server; a target Harness
home in a connection entry selects the remote profile, not the client config
directory. Do not merge local server settings into remote settings. Provider
secrets continue to use the selected server's credential store; connection config
references OpenSSH aliases/identity paths rather than storing SSH passwords or
private-key contents.

Desktop and TUI share the connection schema, registry, and add/edit behavior.
Validate the client file at its boundary and coordinate atomic writes when both
clients edit it. Keep app-specific presentation preferences under their respective
desktop/TUI sections instead of duplicating the connection list. Changing a saved
connection or startup preference in one client does not force another running
client to switch its selected host.

Client connection editing works before any server is connected. Remote RPCs expose
only the selected server's settings. In the UI, distinguish **App / Connections**
from **Selected host settings**; the latter names its target. Keep observed
connection status, server process metadata, transcript state, and drafts out of the
configuration document. The `Local` entry is built in; an empty saved-host list is
enough for first launch. Exact file/schema fields remain to be selected in the
delivery plan.

## Local, WSL, and SSH connections

Prefer one bounded JSON-RPC protocol with small host-specific launch/connection
adapters:

```text
Desktop / TUI
    |-- native local bridge ------------> native shared server
    |-- wsl.exe -> Linux stdio bridge ---> distro shared server
    '-- ssh -> remote stdio bridge ------> remote shared server
```

The stdio bridge attaches to host-local IPC and relays protocol frames. Its exit
closes that connection, not the server. SSH does not need a public Harness port;
WSL does not need an IP address or a separate SSH server. Workspace paths remain
RPC values interpreted on the selected host, never interpolated remote shell
commands. Picking a WSL or SSH project must use host-aware path entry/discovery;
a native Windows directory picker alone cannot choose those paths correctly.

[Node 22's net API](https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support)
already supports Unix sockets and Windows named pipes. This is a candidate for
host-local IPC, with user-private discovery and authenticated connections.
Windows ACL behavior, POSIX permissions, endpoint replacement, and stale endpoint
cleanup need qualification before selecting a library/implementation. A loopback
socket with an owner-protected secret is an alternative if it provides a simpler
verified boundary. Binding to localhost alone does not authenticate clients.

Reuse OpenSSH configuration, aliases, agents, and host-key verification. The user
selected non-interactive SSH for this delivery: use BatchMode, accept a destination
or alias in both editors, and leave ports/keys/custom settings to .ssh/config.
Authentication and unknown-host failures surface diagnostics rather than prompting.
Use maintained OS facilities before introducing an SSH stack. WSL
discovery/launch can use the distribution and user controls documented in
[Microsoft's WSL command reference](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).

Persistence must be independent of the bridge and GUI process. Qualify native
Windows detach/shutdown and Linux SSH logout behavior; ordinary detached spawning
is not evidence that an OS/session manager preserves the process. Reuse user
service managers where appropriate. Autostart at login/boot is a separate choice.

WSL needs an explicit lifetime qualification. Microsoft's current
[systemd documentation](https://learn.microsoft.com/en-us/windows/wsl/systemd#how-does-enabling-systemd-affect-wsl-architecture)
says systemd services do not keep the WSL instance alive. Test a supported means
of preserving active Harness work when the window/bridge closes; do not equate
installing a systemd unit with satisfying this requirement.

## Provisioning and upgrades

Use two runtime sources behind the same connection and server-lifecycle contracts:

| Runtime source  | Host prerequisites                                                                      | Client responsibility                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Development     | Supported Node; npm and any build prerequisites needed to prepare runtime dependencies. | Build current local server code, transfer it, prepare/cache target dependencies, then launch or reuse the server and attach. |
| Managed package | A supported OS/architecture and normal host tools.                                      | Obtain and verify a portable package when needed, then launch or reuse its server and attach.                                |

Development builds from the current local source, including uncommitted changes.
Transfer the built Node bundle and dependency metadata, rather than the source
tree. This requires no remote Git checkout, manual copying, or release publication.
Build the shared server/bridge JavaScript locally using the repository's existing
bundling approach, then automatically transfer the changed bundle over SSH/WSL.
Pure JavaScript dependencies can be bundled; the remaining native/runtime
dependencies belong in a minimal generated manifest and lockfile installed on the
target. The existing packaging script already distinguishes the bundled server
from external runtime packages, but its local dependency-copy step needs a
target-aware path for development transfers.

Cache the remote dependency installation and reuse it when the dependency lock,
target platform, and Node compatibility still match. Source-only edits ordinarily
replace the small JavaScript bundle without reinstalling dependencies. Do not copy
the local machine's whole `node_modules` as the remote runtime: native packages
must be prepared for the target. A prepared dependency cache can also support
hosts without package-network access; otherwise dependency installation needs that
access. Dependency setup failures remain explicit.

A development connection selects the current local build, a user-local remote
installation directory, and optionally a Node executable. An existing installation
can still be reused as an advanced launch choice. Keep inputs structured and
validated instead of adding arbitrary remote shell-command templates. Exact UI
labels and launch syntax remain open.

Development changes how the runtime is supplied, not how work runs. It uses the
same singleton discovery, compatibility handshake, shared service, background
lifetime, and reconnect behavior. Connecting or refreshing transfers the current
build automatically, staging a complete bundle before making it available. The
running server keeps its current code until an explicit restart, which affects
attached clients; show when a newer development build is ready. Do not mutate live
dependency files or start a second server merely to use the new build. Developers
can use an explicit separate Harness home for isolation.

This mode can establish real WSL/SSH connections before a portable release channel
exists. It still needs automatic bundle transfer and target dependency preparation,
but skips packaging/distributing Node and publishing releases. Complete managed
onboarding still needs the package work below.

Managed onboarding is: choose a distro/SSH destination, inspect its platform and
existing server, install a compatible user-local runtime when needed, start or
reuse the server, then attach. Show concrete progress and diagnosable failures.

An installed compatible server should be reusable. Otherwise, distribute
versioned portable server packages containing Node, Harness, and the appropriate
native dependencies. Download directly on the target when available, or download
on the client and transfer over SSH/WSL. This general approach has a production
precedent in [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh#what-are-the-connectivity-requirements-for-vs-code-server):
it can download remotely or transfer a locally downloaded server. This comparison
supports the provisioning pattern, not a claim that Harness packaging is ready.

Use trusted release metadata, verified artifacts, staging plus atomic promotion,
and no administrator installation. Installation must not execute partially
transferred files. Qualify an explicit OS/architecture/libc support matrix;
Linux x64 with glibc is a plausible first WSL/SSH target, not a selected promise.
There is currently no qualified portable remote release channel to consume.

Separate package presence from the live server version. Clients negotiate protocol
compatibility and capabilities. Downloading a new package must not silently
restart busy work, spawn a second database owner, or migrate its database.
Incompatible servers require an explicit update/restart flow with shared impact.

Credentials stay on the executing host by default. Native Windows credentials do
not automatically become WSL/SSH credentials. Existing API-key flows can be
exposed for the selected host. Browser OAuth needs a qualified callback-forwarding
or provider-supported remote flow; SSH transport alone does not solve localhost
redirects. Restart-required provider changes affect every attached client.

## Desktop and TUI connection management

Call the switcher **Host** or **Connection**, since a WSL distro is not a physical
device. First launch has only the built-in `Local` connection. Saved entries can
then include `WSL: Ubuntu` and `SSH: workstation`.
The menu can show connected/disconnected state, running work, and pending input on
other hosts. Switching restores that host's selected conversation, pagination,
and drafts; keys include host identity so two servers cannot share a local draft
or conversation view by accident.

Use a GUI connection manager next to the switcher with add/edit forms, test/save,
rename/remove, connect/reconnect/disconnect, and explicit server stop/restart.
Basic forms show meaningful host choices; launch/runtime overrides belong in
advanced controls. Removing a saved entry is configuration editing and must not
implicitly stop its server. Editing an entry takes effect on its next connection,
without changing the transport under active work.

On Windows, discover installed WSL distributions automatically and offer them as
available choices in **Add WSL connection** or an **Available WSL** picker section.
Discovery does not add saved entries or start/provision every distro. Selecting a
distro supplies defaults for a quick connect/save flow; the editor remains useful
for its user, display label, optional Harness home, and runtime mode. A single
default distro shortcut can use the same flow rather than a separate connection
type. Do not assume one WSL distro per PC.

The SSH editor accepts an existing OpenSSH host alias or a destination with
user/port options. Provide a display label and the same optional target-home and
runtime controls. Reuse SSH configuration and authentication instead of exposing
arbitrary shell-command templates in the ordinary connection form.

TUI provides a host picker and connection-management forms/commands for the same
operations and configuration. Its one visible conversation belongs to the selected
host; changing that selection leaves other hosts' work alive. Share management
semantics through a client-side library with platform launch/discovery adapters,
while each UI owns its presentation. Desktop need not be installed or running to
manage connections from the TUI. An agent command center is a useful product
description for both clients, without requiring a new scheduler subsystem.

Appearance is local; provider/sandbox/settings controls clearly target the selected
host. Disconnection status reports the last known state without claiming remote
work stopped or still runs when unreachable. Fresh attach replaces stale live
state after reconnect.

For local exit, propose a remembered **keep server running** preference and a
first-use choice when active work would be stopped: keep running, stop the local
server and quit, or cancel. Normal exit must not stop a shared server another
client uses. Remote hosts normally continue; stopping them is an explicit host
action. Exact defaults and idle-server policy remain open.

A tray icon is useful for returning to the UI, notifications, and server status,
but server persistence should also work after the desktop process fully quits.
Keeping the UI hidden and keeping execution alive are separate lifetimes.

## Candidate delivery order and completion evidence

This is sequencing for discussion, not an active execution checklist. Before
implementation, turn the selected choices into a dependency-based delivery plan.

1. Shared local server and desktop/TUI reuse: qualify simultaneous startup,
   database exclusion, multi-client attachment, server-owned pending approvals,
   timeout/lost-response behavior without automatic resend, fresh reconnect state,
   and explicit shared shutdown.
2. Shared client configuration and connection management: deliver the built-in
   Local host, desktop GUI and TUI editors/pickers, WSL discovery, and SSH entries.
   Demonstrate cross-client connection edits, settings ownership, and host
   selection preserving other work while scoping paths, drafts, and views correctly.
3. Development WSL/SSH connections: use existing Node installations with automatic
   built-bundle transfer and cached target dependencies. Exercise an actual distro
   and SSH host, uncommitted source changes without manual synchronization,
   dependency reuse/invalidation, authentication, host paths, credential setup,
   reconnect, work after desktop exit, logout lifetime, and network loss during
   transfer, acceptance, and execution.
4. Managed remote provisioning: qualify portable packages for the selected
   platforms, clean onboarding, both download paths, interrupted installation,
   and compatible/incompatible server versions. This follows the development
   connections rather than blocking them.
5. Optional tray, notifications, and autostart: define their independent lifetimes
   and validate the chosen exit policy on supported desktop platforms.

These slices all depend on server-owned work. Merely adding a dropdown or spawning
the existing `server --stdio` entry cannot establish background/reconnect behavior.

## Decisions to settle next

- Confirm singleton scope: environment/account/home, with separate explicit homes
  allowed, rather than a physical-PC limit.
- Confirm simultaneous desktop/TUI control of one conversation.
- Choose local exit and zero-client idle policies; keep remote stopping explicit.
- Select the first qualified remote platform and package distribution route.
- Select authenticated host-local IPC after platform evidence.
- Define remote OAuth and update/data-compatibility behavior before claiming
  complete onboarding and unattended upgrades.
