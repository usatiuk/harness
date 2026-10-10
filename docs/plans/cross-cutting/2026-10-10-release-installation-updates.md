# Product releases, installation, and updates

Status: In progress. Implementation authorized on 2026-10-10. Publishing inputs
in M0 remain unresolved; external publication and GUI test runs require their
own authorization. No distribution or updater behavior below is implemented
unless identified under Current state or Delivery evidence.

## Human-readable summary

This is the proposed installed-product design. The detailed sections below explain
its contracts and delivery checks; the current application does not implement all
of it yet.

**What people install.** Harness has a desktop app, a terminal CLI, and a shared
headless server that runs agents and stores conversations. A remote worker is that same
server running under an account on another machine. Desktop uses Rust and the OS
webview. The CLI and server use Node. Users install desktop normally or put a
small native CLI launcher on PATH; application use requires no system Node, npm,
compiler or source checkout. Planned targets are Windows x64, Linux x64 glibc,
and macOS arm64/x64, with Linux x64 servers over SSH/WSL.

**Downloading and storing the pieces.** Desktop and the CLI launcher contain the
same small Rust installation helper. It downloads the exact required Node,
server and CLI payloads on demand, verifies them, and makes complete installations
available. Node lives under `~/.harness/runtime/node`, server code under `server`,
and CLI code under `cli`, in immutable version directories. Compatible clients
on the same host reuse the same Node files; each process still runs independently.
First preparation needs downloads; retained complete installations can start
offline. Verification metadata stays beside each payload.

**One shared server per home.** Desktop and CLI connect to the same server for a
given Harness home/account. Several installed client versions and cached server
versions can coexist, but only one server owns that home's database.
`server/current.json` remembers which server to start, including after shutdown.
An older client must use that selection rather than downgrade it. `.running-server`
holds discovery and authentication for the actual running instance. Clients show
their own version, the running server version, and available updates separately.

**How they communicate.** Local connections use Unix domain sockets on
Linux/macOS and named pipes on Windows, with private per-instance authentication.
There are no local network ports or TCP fallbacks. Windows pipes must restrict
access to local clients and the appropriate account. For remote connections,
SSH/WSL launches a small bridge command from the server payload. That process
forwards JSON-RPC messages between stdin/stdout and the target's local socket;
the authentication token stays on the target. Each connection has its own bridge.
When it disconnects, the bridge exits while accepted work remains with the shared
server. Connecting can start the selected server when needed. The client downloads
and transfers remote runtime/server files, so the target needs no internet or npm.

**Publishing and version checks.** One Harness product version identifies a
coherent desktop/CLI/server release. The Git repository can remain private;
GPLv3 releases include the exact corresponding source and build instructions. A public
GitHub distribution repository hosts installers, launchers, payloads, Node files
and signed release/update metadata. Each client knows its exact release metadata
address and trusted verification key. Downloads are pinned to verified versions,
not independently chosen "latest" components. Clients share a server when their
protocol contracts match; incompatibility gives a clear upgrade action. A small
stable control contract still permits inspecting and stopping a server when
conversation RPC is incompatible.

**Updating.** Desktop uses Tauri's official updater, checking on startup and
periodically while open, with a setting for automatic checks/downloads. Installation
requires Restart to update. `harness update` updates that CLI installation and its
launcher. Required runtime/helper files are prepared before client replacement.
Updating a client does not automatically replace its shared server. Server updates
are explicit per-host operations: prepare the target, explain that clients and
running work will be interrupted, stop the expected instance, then start the
selected version. Transcripts survive; interrupted turns are not automatically
resumed. Failed server activation stays visible rather than silently selecting
an older server.

**Development.** Source execution uses the same pinned downloaded Node as installed
execution, while retaining workspace code, tsx and frontend HMR. There is no
selectable host-Node runtime mode. Local development uses an isolated Harness
home; remote testing uses a separate test account. Build metadata contains version
and target identities, while actual filesystem paths are resolved on the machine.

**Data and cleanup.** Compatibility and data-preservation guarantees begin with
the first public release; pre-release migration and cleanup are outside scope.
Configuration files have a numeric format version; SQLite already has its own
format version. Later changes use concrete forward migrations, with a consistent
backup before changing existing public data. Uninstall retains conversations,
settings, credentials and the shared download cache. Running consumers protect
their exact payloads with OS file locks; explicit cache pruning removes unused
versions and reports busy versions without stopping them. It keeps the selected
server, invoking client's requirements and Node versions needed by retained
payloads. There is no mandatory previous-version reserve. An inactive old client's
payload can be removed even if its launcher is still installed; it downloads that
version again next time. No installed-client registry or cleanup daemon is needed.

**What remains to deliver.** All milestone completion gates remain open. The
runtime, payload, local IPC and management foundations have focused evidence.
The CLI's selected-server preparation and startup paths have focused checks;
installed qualification, desktop/remote integration, public data/version
qualification, packaging/publication, updates and explicit cleanup remain to be
completed. Distribution access and publication inputs also remain open.
Actual installed tests must establish each
platform's behavior. A qualified Windows preview can ship first; full delivery
still requires the remaining targets and update checks. Visible GUI tests require
approval for each run.

## Outcome

Ship installable desktop and CLI clients that need neither a source checkout nor
system Node/npm, with one shared headless server per execution account and a
separately cached Node runtime. Publish all downloadable artifacts and update
metadata on GitHub Releases. Preserve ordinary source development and existing
client/server ownership. Make installation, compatibility, updates, failure,
and retained versions understandable without introducing an update daemon.

Delivery is complete when the selected Windows, Linux, and macOS targets pass
their installed qualification, anonymous release installation works, desktop
update checks/downloads and explicit activation work, CLI/server update commands
work, and the retention/prune milestone passes. A qualified Windows preview may
ship earlier; it does not close remaining platform or update milestones.

Evidence, alternatives, and primary sources are in the
[release research](../../research/2026-10-10-release-installation-updates.md).

## State before implementation

This is the initial planning snapshot, before release implementation and the
subsequent rebase onto native-search commit `0dfb0ff`. That rebase advances the
accepted SQLite schema to v6 with additive v3/v4/v5 upgrades; protocol remains v4.

- Desktop packages its build machine's Node executable, server/worker bundles,
  and copied native/runtime dependencies. Tauri currently builds a per-user
  Windows NSIS installer. macOS/Linux packaging and installer upgrade/uninstall
  behavior remain unqualified.
- Local packaged servers execute immutable copies under
  `~/.harness/.server/runtime`. Remote managed Linux x64 glibc deployment uses
  `~/.harness/runtimes`, `builds`, and `dependencies`, pins Node 22.23.3, transfers
  locally bundled code, and runs target `npm ci`. These are distinct cache
  layouts, not a shared installed-product contract.
- Source CLI uses developer Node/tsx and workspace server resolution. Its
  private manifest points to an unbuilt `dist/bin.js`; no release CLI exists.
- Connections attach an existing authenticated owner before starting another.
  SQLite exclusion protects the database. Refresh stages code; restart is
  explicit. Disconnect does not stop accepted work. Desktop exit conditionally
  releases Local according to its existing keep-running/other-client policy.
  Current local transport is authenticated loopback TCP; the public-release
  contract below replaces it with OS-local IPC.
- Discovery requires literal current protocol v4, and management currently
  initializes application RPC. There is no independent cross-version control
  envelope, persistent selected server release, or downgrade protection.
- Desktop reports product 0.1.0 while several CLI/server/control identities use
  0.0.0. `.nvmrc` selects only Node major 22; desktop runtime follows the builder.
- Server packaging re-resolves a transitive dependency lock. Source CI covers
  Windows/Ubuntu; no release pipeline, macOS release job, published GitHub
  release, updater configuration, or completed-cache pruning exists.
- Store format is v4 with one additive v3 upgrade. Other populated formats fail
  with reset guidance. Current credentials are a pre-release format. This plan
  establishes a preservation promise beginning with the first public baseline;
  private/pre-release builds have no compatibility guarantee.
- `client.json` already has numeric `version: 1`. Global/project/local settings
  documents currently have no format version. There is no general config migration
  runner or pre-migration backup behavior.

## Product and artifact contract

### One product release, separate artifacts

Use one product SemVer and private source commit for desktop, CLI, and server.
Protocol, plugin contracts, store schema, release-manifest format, management
format, and Node version describe separate contracts; a product bump does not
automatically bump them.

| Component               | Contents and responsibility                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Desktop                 | Tauri executable, frontend, native bootstrap, embedded build metadata; normal OS application installation                    |
| CLI launcher            | Small native executable using the same bootstrap library; terminal/process forwarding and launcher replacement               |
| CLI payload             | Bundled CLI JS and its actual runtime/assets dependency closure                                                              |
| Server                  | Existing composition, `server.mjs`, code-mode `worker.mjs`, complete native/runtime dependency closure                       |
| Node runtime            | Exact pinned upstream/runtime distribution, licenses and necessary runtime files; separate reusable artifact                 |
| Release metadata        | Signed manifest binding product version, source commit, targets, compatibility, artifact identities and runtime requirements |
| Desktop update metadata | Tauri `latest.json` plus its signed platform updater artifacts                                                               |

The remote worker is the existing server on another host. `worker.mjs` is a
code-mode worker thread within that server, not a separately deployed service.
Server archives exclude Node but contain everything else needed to run their
declared runtime/target. CLI archives similarly exclude Node. Native dependencies
are built/installed in CI, never compiled or fetched through npm on a managed
user's machine. Runtime downloads are shared files, not a shared Node process.

Initially support Local Windows x64, Linux x64 glibc, and macOS arm64/x64. SSH/WSL
managed servers remain Linux x64 glibc. Separate macOS architecture artifacts
are simpler than universal Rust plus mismatched native resources. Linux arm64,
Windows arm64, remote Windows/macOS adapters, and musl payloads are not implied
by this matrix.

Keep the existing Node 22 LTS line initially, selecting one exact supported patch
and upstream digest at release cut. All release jobs and native closures use that
runtime; never copy arbitrary developer Node. Reassess the line before it leaves
support. Minimum OS/libc requirements are the intersection of the launcher,
Node, native dependencies, and desktop webview requirements, recorded per target.

### Build metadata and paths

One release input drives Cargo/Tauri versions, bundled CLI/server/client identity,
provider User-Agent versions, and artifact metadata. Keep internal workspaces
private; publishing this product does not require publishing each npm package.
Generated build metadata contains:

```text
mode: development | release
productVersion, sourceCommit, target
protocolVersion, pluginContracts, storeSchemaVersion
version-specific releaseManifestUrl, releaseVerificationPublicKey
bootstrap/management format versions required by this build
```

Embed a version-specific manifest URL and verification key before compilation;
generate/sign the final manifest after artifact bytes exist. Do not embed the
final manifest's hash into artifacts that the manifest itself hashes.
Reject missing release inputs, dirty/unidentified release sources, development
paths, placeholders, and incompatible runtime metadata in production packaging.
Ordinary development builds do not pretend to be published releases.

Never embed a builder's absolute checkout/home/cache paths. Resolve OS app
resources, canonical `HARNESS_HOME` (default `~/.harness`), remote account home,
and explicit development payload locations at runtime. Capture absolute Node,
payload, and release identity once per client/helper process; don't re-resolve a
mutable latest pointer during a connection or shutdown.

## GitHub publication and trust

Keep the source repository private if desired and use one public distribution repository, provisionally
`usatiuk/harness-releases`; its actual name and credentials are M0 inputs.
Publish installers, native CLI launchers, payloads, runtime archives, notices,
signed `release.json`, manifest signature, and Tauri update assets there.
The user selected GPL-3.0-only; the verbatim license was downloaded from GNU.
Include corresponding source/build instructions and dependency notices with each
binary release. Do not rely on an inaccessible private source repository to
satisfy source distribution. Initial OS packages omit Windows/Apple publisher
signing; label their OS warning/Gatekeeper limitations. Project-owned download
and updater signatures remain mandatory and need no paid OS certificate.
Runtime bytes are uploaded only when their identity changes; later manifests
may reference their original immutable release URLs. Retain those referenced
releases/assets. Do not make runtime-only uploads the product's latest release.

Use exact release URLs for installation. Use GitHub
`releases/latest/download/release.json` and `latest.json` only to discover a newer
stable product release. Stable is the first automatic-update channel; preview
releases are explicit installs. Resolve latest once, validate the signed manifest,
then pin all downloads to that release. A failed discovery never prevents a
cached launch. Do not require GitHub API authentication for client downloads.

The manifest format is small and versioned: product/source identity; explicit
supported target/minimum platform requirements; protocol/plugin/schema support;
component-to-runtime references; per-artifact HTTPS URL, byte size, SHA-256 and
expected entry points; launcher requirements. Targets include OS, architecture,
and Linux libc. No client constructs arbitrary package names from untrusted data.

Use maintained signature verification compatible with Tauri/minisign tooling,
not custom cryptography. Embed trusted public keys in clients; private release
signing keys stay in protected CI inputs with a recoverable backup. Windows
Authenticode and Apple signing identities are separate from download/update
signatures. GitHub release attestations are useful additional evidence, not a
replacement for the client trust root. The public distribution tag's commit is
not the private source commit; record both honestly.

Verify signed metadata, target, size and digest before installation/execution.
Reject corrupt signatures, unsupported formats, wrong runtime/ABI, unsafe archive
paths/links and incomplete extraction. Bound downloads and expanded archives;
preserve package layout and legitimate internal links without allowing writes
outside the unique staging root. Use maintained HTTPS/archive/signature libraries.
Handle required GitHub asset redirects without forwarding secrets; clients carry
no publisher/source-repository credential.

Build each artifact once, qualify those exact bytes, then assemble all assets in
a draft release and publish it as immutable. A publication failure is resumed
against that same draft; never silently overwrite an already published version.
Provide a manually dispatched GitHub Actions workflow with a `patch`, `minor` or
`major` bump input. It computes one next version, records a release commit/tag,
builds/qualifies the artifact matrix and matching source archive, assembles a
draft, and publishes only complete metadata/assets. Concurrency prevents two
release runs from independently bumping/publishing the same source state.
No release occurs merely because an ordinary change was pushed.

Newest stable selection changes only after the intended matrix and manifests
are complete. An intentionally Windows-only preview clearly declares its scope.

## Shared bootstrap and cache

### Preparing Node and Harness code

Tauri itself starts in Rust and renders the frontend in the OS webview; it does
not include Node. Our server and CLI need Node. Add one small Rust installation
helper compiled into the desktop and the native CLI launcher so either client
can obtain the required runtime and code without depending on the other client
or on system Node. It verifies downloads, prepares the immutable cache and returns
absolute paths. This is shared library code, not an extra service/process.

Use the pinned downloaded Node for installed and source execution alike. Remove
the remote managed/development runtime selector, PATH-based host-Node branch and
associated UI/config choices. Omit the retired runtime-source field; no converter
for old saved runtime choices is required. Development chooses workspace code rather
than release code, not a different Node installation policy.

Keep application RPC, host registry, SSH/WSL routes, server lifecycle policy,
credentials and conversation behavior in existing TypeScript ownership. Pass
captured prepared-installation metadata through a typed native boundary. Do not
create a second Rust implementation of the agent server or conversation client.

Enforce the existing canonical-home and user-private ownership/permission boundary
before native bootstrap executes cached code, including Windows ACLs. Do not defer
that prerequisite to a JS helper that is already executing from the cache. Adapt
release `prepareLocalRuntime` to consume the prepared immutable paths instead of
copying them into a second managed cache. Source execution selects workspace code
with the same managed Node; remove superseded cache paths without transition adapters.

The CLI launcher forwards arguments, cwd, environment, stdin/stdout/stderr,
signals and exit status. Unix can exec the pinned Node payload; Windows must
preserve console input/cancellation while waiting for the child. Bootstrap
progress goes to stderr so redirected protocol stdout remains clean. The
launcher must not consume TUI input or disable Ctrl+C for its child.

### Cache layout and installation

Use directories named for the components they contain. Desktop stays in its
normal OS installation location; the native CLI launcher stays in its chosen bin
directory. Their downloaded Node-based payloads share this home-level cache:

```text
~/.harness/
  store.db, settings.json, client.json       # existing user data
  runtime/node/<node-version>-<target>/     # shared Node binaries
  server/<harness-version>-<target>/        # server code and its dependencies
  cli/<harness-version>-<target>/           # CLI code and its dependencies
  server/current.json                      # server version to start
  .running-server/                         # private live endpoint/authentication
  staging/<attempt-id>/                    # incomplete downloads/extraction
```

Keep verified release metadata and an installation receipt beside each complete
payload; there is no separate release catalog or installed-client registry.
The CLI payload exists because the native launcher starts the Node-based CLI;
the server payload is the shared background server. Neither includes another
copy of Node. Remote server-only installs need no CLI payload.

`server/current.json` records the selected server artifact, not whether a process
is running. It survives shutdown so an older installed client cannot silently
start an older server. `.running-server` contains discovery/authentication for
the current instance. Store a stable server ID under `server/identity.json` and
retain it across restarts and public-release updates. Importing the pre-release
control directory or host identity is not required. Selection and identity files are not pruneable
payload directories.

Preserve actual current data filenames/backends. There is no
move of user data into versioned directories, broad home reorganization, or
separate dependencies download channel. Complete payload archives simplify
installation; deduplicating their native dependency trees is not needed initially.
Credentials retain existing OS vault/app-data/file locations; the diagram does
not relocate them into a new home subdirectory.
Use this layout directly. Pre-release cache migration, reuse and cleanup are
outside scope; the installer and prune command manage only this new layout.

Published version/target directory names refer to immutable artifacts; the
verified receipt binds them to exact bytes. Never reuse an existing directory
for different bytes under the same version/target. Source-built server/CLI
payloads use `dev-<target>-<digest>` names so rebuilds also remain immutable.
A release pins Node including its patch; native ABI compatibility
alone does not authorize substituting a different Node. Multiple releases may
reuse the same runtime. Different required runtimes coexist. The host's OS/
architecture bytes cannot be shared with a different remote platform.

Use unique staging and per-artifact cross-process installation coordination.
Download outside long host lifecycle critical sections, verify, extract, validate
expected files, and atomically publish a complete directory on the same volume.
Readers never accept a partial directory as ready. Cancellation cleans only the
attempt's stage. A competing installer reuses the identical complete artifact.
No retry of a signature, metadata, ABI, or deterministic packaging failure.

Cold first launch with an empty cache requires access to release downloads.
Display progress, cancellation, and a specific retryable network error. Once
prepared, launch from the captured verified cache without checking latest or
requiring internet. Stage a new client release's mandatory local runtime/helper
payloads before replacing the installed client, so the next launch works offline.
Persist verified metadata with the cached bytes for that purpose. Explicit cache
removal can require a later download; communicate that consequence in its preview.

## Shared server selection and compatibility

### Communication contract: local IPC and remote bridges

Local client/server communication uses Unix domain sockets on Linux/macOS and
named pipes on Windows. No local IP listener, port allocation, forwarding or TCP
fallback. Node's built-in `net` stream API supports both endpoint types; retain
the existing bounded newline-delimited JSON-RPC transport, `vscode-jsonrpc`, and
shared public types. Transport choice does not change application semantics.

Discovery under `.running-server` records a typed local endpoint, home and owner
identity instead of a port. Windows client addresses use the local pipe namespace,
never a remote UNC host. Unix sockets use a short user-private runtime/temp
directory so arbitrary `HARNESS_HOME` lengths cannot truncate an endpoint.
Derive names from canonical home and instance identity; validate directory
ownership/permissions and endpoint namespace before connecting or removing files.
Retain the private per-instance token, bounded authentication and exact
home/server/instance checks before admitting RPC. Windows pipe creation must
enforce local-only access and qualified account permissions; use a narrow
maintained native creation adapter for switches the Node API does not expose.
Keep JSON-RPC and execution ownership in TypeScript.

The owner creates its endpoint and publishes discovery after SQLite exclusion.
Only that owner removes its endpoint/discovery; stale Unix socket cleanup requires
SQLite exclusion and validated paths within the managed IPC namespace. A client
disconnect closes its observer, not the server.

SSH/WSL launches a foreground bridge command from the installed server payload
using the target's cached Node. The bridge attaches to that account's shared owner
through local IPC, authenticates using the target's private token, then forwards
RPC bytes between the owner's stream and stdin/stdout. The token stays on the
target; stdout contains only protocol and stderr carries diagnostics. The server
may be started through the existing explicit managed-start path when needed.

```text
client -> SSH or wsl.exe stdin/stdout -> target bridge -> local IPC -> shared server
```

Each SSH/WSL connection has a disposable bridge; the server is shared and
persists independently. Connection loss disposes the bridge/observer while
accepted server work continues. Desktop's native host already uses the same
stdio bridge boundary for Local. CLI Local may connect directly through IPC.
There is no separately installed bridge service, runtime or CLI payload on the
remote host, and no remote server network listener.

### One owner, multiple installed clients

Retain one SQLite owner per canonical home/execution account. Each client has its
own product release and pinned bootstrap/helper requirements. Clients may share a
server when application protocol and mandatory plugin contracts match, even when
their product versions differ. Do not require exact product-version equality.
Advertise optional features only when a concrete optional behavior exists.

On an unselected home, the first managed start selects that client's declared
server release. Thereafter ordinary starts read the persisted selected release;
they never overwrite it with their own older bundled/default version. An older
client may attach a compatible newer server or report that the client needs an
upgrade. A newer client encountering an incompatible server offers an explicit
server update. Unsupported RPC does not trigger a second owner or a reset.

Discovery/control must expose actual running product/build, protocol, management
format, stable server ID, instance ID and home. Keep three facts distinct in UI:
the client's version, the running server's version, and an available/staged update.
Show supported, supported/update available, or incompatible with the exact
client/server upgrade action. Refresh alone never changes the running owner.

### Stable management before application initialization

Introduce a narrowly versioned management envelope over the authenticated
IPC channel and remote stdio bridge. It supports inspection and
instance-targeted stop, including conditional release on desktop exit, without
successful conversation/plugin RPC initialization. Preserve bounded framing,
private directory/token security and canonical home/instance checks. It is not
a second conversation API, unauthenticated HTTP service, or generic supervisor.

Strict application protocol validation stays at initialization. Discovery can
read supported management envelopes carrying an unfamiliar application protocol.
Future application protocol changes must not break management v1 accidentally.
Unsupported management formats fail with explicit manual upgrade/stop guidance;
never kill a PID merely because a stale discovery file names it. First public
release includes this contract. Support for older private/pre-release owners is
not required.

All released start, stop, selection and activation paths coordinate on one
per-home lifecycle boundary. After SQLite ownership but before migrations/runtime
startup, a managed owner checks that its release is still selected. This rejects
an old direct/background candidate that survived another client's upgrade.
The current SQLite constructor acquires ownership and initializes schema in one
operation. Introduce only the narrow owned-before-initialization hook needed for
the selected-release check; a real later public migration can use that boundary
for its backup. Store code must not import connection or release policy.
The existing SQLite lock remains the database authority; do not add a second
durable owner registry or a durable update workflow engine.

The outer management operation owns that gate. Its authenticated stop handler
and spawned owner must not reacquire it while the manager awaits shutdown or
readiness. The spawned owner reads atomic selection after SQLite exclusion;
this is an explicit lifetime/order contract, not nested competing managers.

## Installation and update flows

### First install and remote setup

1. Install the desktop in its normal OS location, or install/extract the native
   CLI launcher into a per-user command location and add that location to PATH.
   A small shell/PowerShell install script may fetch the native launcher; it must
   not be the application's runtime/process manager.
2. Native bootstrap obtains its exact signed release metadata and prepares
   required local Node/client/server helper payloads. UI/TUI progresses normally.
3. Attach a compatible authenticated owner or start the selected release. An
   incompatible existing owner yields an actionable update screen.
4. For SSH/WSL, probe the target before deployment. Download the declared Linux
   runtime/server archives on the client, verify and transfer through existing
   transport, check transfer digests, then stage atomically on that account.
   A remote internet connection, compiler, npm and system Node are unnecessary
   in managed mode. Existing SSH auth/host verification remain in force.

Direct remote HTTPS download is a later optimization, not required for release
installation. Runtime/version resolution is the same for local and remote;
transport and actual filesystem/platform bytes differ. Server execution remains
on the chosen host; GitHub hosts program artifacts, not running agents.

### Desktop automatic checks and explicit installation

Use the official Tauri updater, static GitHub `latest.json`, and signed updater
artifacts. Check on startup and, while open, at a bounded interval (initially
six hours); provide Check now and one automatic-check/download preference.
No scheduler runs when the client is closed. Offline checks are nonblocking.
No automatic install/restart or activation of remote servers.

Resolve the signed target release once, then read its version-specific Tauri
update metadata. Match updater product version, target and artifact URL/digest
to that manifest before download/activation. Never pair independently moving
latest manifest and updater responses; reject mismatches rather than installing
a shell whose runtime prerequisites were not prepared.
Prepare required target runtime/helper artifacts, download the installer, and
show Update ready / Restart to update. Initial desktop installer download is
session-scoped using Tauri's verified update resource; payload/runtime staging is
persistent. After closing, re-check/re-download rather than claiming an installer
is still ready. Durable desktop installer caching is not an initial requirement.

Implement one fallible Rust-owned activation command that blocks new bridge/
helper admission, awaits the existing physical teardown and conditional Local
release, then invokes Tauri install/relaunch. Windows updater installation exits
the process directly; relying on the ordinary RunEvent::Exit callback loses
teardown. Reuse the shutdown helper for normal exit and update; never use an
unawaited/synchronous callback as the sole correctness gate. If preparation or
teardown fails, show the error and allow retry/reconnection without installing.

Preserve keep-running and other-client policy; an app update is not permission
to force-stop the shared server. A compatible owner used by CLI keeps running
on immutable files. New desktop reconnects and offers server activation separately.
Preserve the existing localStorage drafts and per-host/server route keys through
intentional app restart; verify draft restoration with the same stable server ID.
Linux AppImage uses Tauri updater; any later package-manager installation delegates
app updates to that package manager rather than competing with it.

### CLI updates

`harness update` checks stable release metadata, stages the exact new CLI/runtime
and required local helper payload, then updates that CLI installation for the
next launch. Already-running CLIs keep captured immutable code/runtime paths.
Notifications can use cached/background checks during interactive sessions;
normal noninteractive commands do not gain blocking update/network work.

The native launcher is itself versioned and upgradable. Use a maintained native
self-replacement library for Windows's loaded-executable constraint; no assumption
that the launcher will never change. Stage and verify replacement before handoff,
wait for the old process as required, and preserve a runnable installation on
failure. Desktop replacement remains Tauri's job. A failed launcher replacement
does not select a CLI payload requiring that newer launcher. Independent CLI
installations retain independent selections while sharing immutable cache files.

### Server updates and failures

Desktop and CLI expose the same per-host Update server and restart operation:

1. Resolve/capture the target release and stage all required artifacts before
   disturbing the current owner. Show that shared clients disconnect and running
   turns/activities are interrupted. Obtain explicit activation intent.
2. Under the home lifecycle gate, re-read selected/running identity. Reject a
   changed expected instance/selection rather than stopping a replacement.
3. Persist the target selection before stopping the old owner, preventing an
   older launcher from racing in with its old default. Selection means what the
   next owner must run; the observed old owner remains distinct until stopped.
4. Stop that exact instance, await actual shutdown/database release, then start
   the selected immutable runtime/server and await authenticated readiness.
5. Reconnect the requesting client; other clients can reconnect explicitly.
   Durable transcripts survive. In-flight work is reconciled, never resumed
   through stream/process/session migration.

Concurrent activations serialize; stale intent does not silently target the new
instance. Interrupted activation leaves the selected target and safe diagnostics;
the next explicit start can finish it. If stop failed, the old owner is still
reported as running. If new startup failed, retain the target and error instead
of silently choosing old code. Recovery to an older release is explicit and
allowed only when its data/schema and management compatibility are established.
No automatic schema downgrade or post-migration binary rollback promise.

## Data preservation and development

### File and database formats

The first public release establishes supported schema/config/credential baselines.
There is no pre-release database, configuration or credential migration requirement.
Preservation applies to data created by that baseline and later public releases;
unsupported formats fail without automatic deletion or mutation.

Use a numeric `version: 1` on client and global/project/local settings documents
at the first public baseline. `client.json` already follows this pattern.
Inline profiles and plugin fragments do not need a duplicate envelope version.
A file's format version is independent of product and RPC versions. Bump it when
a change makes an existing reader/writer incompatible, not for every release.
An additive field is not automatically compatible with the current strict parsers.

When a later public release changes a config format, read its version, apply the
specific known conversion, validate the result, and atomically replace the file
under writer coordination shared by every process that can modify that file.
Reuse existing cross-process file coordination where present; a process-local
queue alone is insufficient. Make a private backup of the original
before replacement. A missing file creates a fresh current-format document;
an existing unknown/newer format gets an upgrade/unsupported error without
being overwritten. A version field identifies the input; it does not itself
perform the migration.

SQLite already uses `PRAGMA user_version`, currently 6, and an exclusive
transaction for fresh schema creation or the concrete additive 3→4→5→6 steps. Keep
that mechanism and numbering. Later public changes add concrete SQL steps such
as 6→7; schema changes and the format-number update commit together. Only the
server owning the database migrates it, before admitting application clients.
The CLI and desktop do not independently edit the database. Unsupported newer
formats give compatible-upgrade guidance without changing the database. There
is no automatic schema downgrade or old-binary rollback.

Before a later public migration changes existing data, produce a consistent
private backup under exclusive ownership. For SQLite, use its backup API or a
qualified closed/checkpointed procedure; copying only a live `store.db` can miss
WAL contents. Keep one latest completed pre-migration backup per data file,
replacing it only after the new backup succeeds, and report its path on failure.
Qualify migration failure, preservation and manual restore against actual public
fixtures when that change exists. Do not build a generic migration framework or
speculative historical converters for the initial release. Secret storage remains
in the OS-specific backend; do not export credentials into a plaintext backup.

### Uninstall and development

Uninstall removes client files, not the home, credentials, conversations or shared
download cache. Explicit cache maintenance handles unused payloads separately;
no installed-client registration or unregister hook is needed. Harness-managed
removal refuses an in-use component and asks the user to close/stop it; it does
not force-stop a server another client uses. Once the component exits, removal
can succeed. Shared Node files still needed by another retained payload stay.
Manual OS deletion of an app bundle is outside this cooperative protection;
removing it still must not delete the Harness home. A full user-data reset remains
an explicitly separate manual action.

Keep `npm run dev`, `desktop:dev`, workspace export conditions and Vite HMR.
Run source clients, servers, workers and their dev/test entry points with the same
pinned downloaded Node; retain tsx/workspace code and locally built payloads,
without fetching a published latest server for source development. Repository
setup tools may start under an existing Node, but application execution resolves
the managed runtime before launch. Dependency preparation uses the pinned runtime
so native addons match it. There is no developer-runtime fallback or runtime-mode
setting. Use the existing `HARNESS_HOME` override to isolate local
dev from everyday installed use, via an ignored per-checkout dev home if unset;
honor an explicit override. No profile/home chooser is added to product UI.
Preserve project-root discovery under this override with actual regression
evidence. Server source changes require an explicit restart; frontend HMR does not.

Local development isolation covers the server/database/config home, not a new OS
credential profile. Existing system credential backends may remain shared;
credentialed tests need their existing explicit test boundary, not a new product
account/home selector.

Remote source testing transfers locally built code and uses the same pinned
downloaded target Node and complete target payload preparation. Remove the
host-installed Node/npm execution path. Local dev isolation does not isolate a
remote account: use a dedicated test account/fixture and make that boundary explicit.
Release packaging/tests can consume locally generated signed fixture manifests
without publishing or depending on mutable GitHub latest metadata.

## Retention and pruning

Initially list cache size/retained releases and clean only this attempt's failed
staging files. Do not delete completed caches based on the server PID, discovery,
or an installation mutex: CLI and bridges can still need those files, and POSIX
unlink can break later addon/worker loading even when Windows would deny deletion.

M7 adds explicit `harness cache prune --dry-run` and prune. By default keep the
selected server and the invoking client's required payloads. No previous release
is kept merely for rollback. Preview candidate version directories, their size,
and busy entries. The preview is advisory; recheck use immediately before
deletion. Under the candidate's exclusive use lock, re-read `server/current.json`
and retain the entry if it is now selected. Selection-changing operations hold
the target's shared use through readiness validation and selection publication,
so they cannot select files concurrently being removed. There is no inventory
of installed clients: an older inactive client's
payload can be removed whether or not its launcher is still installed. That
client downloads its exact release again on next launch and needs network access.
Cached launch remains offline while its requirements are retained. Pruning affects
only known managed payload directories, never selection/identity, user data,
unknown files or another attempt's staging.

Use one maintained OS shared/exclusive file-lock facility, with a lock per
immutable payload/runtime outside its removable directory. Consumers hold shared
use; removal tries exclusive use nonblockingly and reports a busy entry if it
cannot acquire it. A running version protects its own files, without preventing
removal of a different unused version. Locks are cooperative Harness protection,
not a promise that arbitrary POSIX file deletion is impossible.

Acquire use before preparing/capturing paths or launching consumers, and hold it
until those paths can no longer be used. This includes the native desktop between
helper calls and through teardown, CLI, bridges and detached servers. A detached
server must retain its own protection after its launching client exits; a parent
lock alone is insufficient. Worker threads are covered by their server's lifetime.
Process exit/crash releases OS-owned handles; no PID sweep, heartbeat, lease
database or cleanup daemon is needed. Installation publication uses the existing
per-artifact coordination and the same use protection, so start/install cannot
race a successful removal. Revalidate directory readiness after acquiring use.

Derive Node retention from the verified receipts of payloads that remain.
Delete Node only when no retained payload requires it and its own exclusive-use
lock succeeds. Preparation holds the required Node use lock through publication
of its dependent payload, preventing a concurrent prune from publishing a new
reference to a removed runtime. Recheck receipts while holding exclusive Node
use; a concurrent payload removal may conservatively retain Node for one more
prune, which is harmless. No installed-client dependency registry is necessary.

Route destructive prune through the native bootstrap before starting a Node
maintenance payload, avoiding self-blocking. Define one lock acquisition order
for consumers/install/removal. Report removed, retained and busy entries; do not
wait indefinitely or stop running applications. If the process-lifetime facility
cannot be demonstrated, completed-cache deletion remains unavailable and M7 stays
open. Automatic pruning is outside scope.

## Delivery milestones

Implementation and incremental local commits are authorized; checkboxes remain
open until their completion checks pass. Execute coherent slices and record
observed results. Push, publication and visible GUI test runs need separate
authorization.

- [ ] **M0 — Publication inputs and release contract.** Decide distribution repo,
      first release/version/channel, project binary distribution terms/notices,
      permanent application identity, exact supported Node patch/targets and signing
      identities. Define the manifest/build metadata schema and download trust root.
      **Check:** generated fixture descriptors reject wrong versions/targets;
      required inputs and scoped CI credentials are documented; no placeholders in
      release mode. **Dependencies:** none. Missing accounts/keys are publication
      blockers, not reasons to advertise unsigned macOS builds as fully qualified.
- [ ] **M1 — Reproducible component artifacts.** Bundle CLI separately; freeze
      native/transitive dependencies from the committed graph; build complete server
      and CLI payloads with target-specific assets under the pinned Node; generate
      coherent identity and notices. Remove release reliance on source resolution or
      target npm installation. Use a pinned maintained Linux build image meeting
      the declared CLI/server libc/libstdc++ baseline, separate from the desktop
      GTK/WebKit build baseline. **Check:** unpacked payloads outside the checkout run
      real CLI/server, SQLite, keyring/DPAPI where applicable, code-mode worker and
      required WASM/package assets with no npm/compiler. Manifest describes exact
      bytes/ABI/layout. **Dependencies:** M0.
- [ ] **M2 — Shared native bootstrap and immutable cache.** Add the shared Rust
      library and native CLI launcher, release-source versus development-source
      handling, safe extraction/publication, captured installation metadata, and
      typed integration with existing host helpers. Remove host-Node runtime modes
      from UI/config/adapters. Use managed Node for source execution as well and
      standardize managed caches without pre-release transition paths.
      **Check:** cold/failed/cancelled/concurrent
      preparation, offline cached launch, runtime sharing and side-by-side versions,
      non-ASCII/spaced/canonical homes, stable server identity/authentication across
      public-release restarts/updates, terminal signals/stdio and helper shutdown;
      source CLI/desktop/remote execution with no application Node on PATH, and
      preserved source iteration/HMR under the pinned runtime.
      **Dependencies:** M1. No general deployment framework.
- [ ] **M3 — Cross-version management and server selection.** Separate stable
      management/discovery from application initialization; persist selection;
      replace loopback TCP with OS-local IPC/discovery, coordinate starts/stops/
      activation and validate selected release before schema startup. Expose
      actual version/compatibility and explicit activation in both
      clients. **Check:** mixed clients, stopped newer owner plus old-client launch,
      late old candidate, protocol mismatch inspection/stop, stale instance, concurrent
      updates, process loss between selection/stop/start, real SSH/WSL bridges/owners,
      no IP listener/fallback, long homes, stale Unix sockets, Windows local-only
      pipe permissions, unauthorized clients, and disconnect preserving accepted work.
      **Dependencies:** M2.
- [ ] **M4 — First public data baseline.** Declare the supported database,
      configuration and credential formats; add numeric settings-file versions,
      preserve baseline data across public updates, and fail unsupported formats
      without mutation. Require concrete
      migration/backup evidence only when a post-baseline release changes a format.
      **Check:** fresh home, first-public-baseline data/settings/credentials after
      an update, newer/unknown format without mutation, uninstall retaining data;
      actual later format changes additionally qualify migration failure and
      backup/recovery. No pre-release adapters or live session recovery.
      **Dependencies:** M1; integrate with M3 before public upgrade promises.
- [ ] **M5 — Platform packages and immutable publication.** Add protected build/
      signing jobs and draft assembly, using Tauri tooling plus exact payloads;
      qualify Windows x64 NSIS, Linux x64 AppImage, and macOS arm64/x64 DMG/app/update
      archives. Validate manifest cross-references and exact draft bytes locally or
      through authenticated access before explicitly authorized publication. After
      publication, require an anonymous signed-manifest/artifact installation smoke
      before declaring M5 complete. **Check:** installed platform matrix below,
      the approved unsigned macOS runtime/addon path and Gatekeeper limitations,
      notices, exact-byte tests,
      install/upgrade/uninstall, busy managed removal without forced server stop,
      and no incomplete/latest race. **Dependencies:**
      M0–M4. Windows preview may precede other platforms with explicit qualification
      labels; unfinished targets stay open.
- [ ] **M6 — Client update integration.** Integrate official Tauri updater and
      fallible shared shutdown, background checks/download preference, target helper
      prefetch, manual CLI/launcher replacement, and explicit server update. Preserve
      drafts and running owners under app updates. **Check:** two successive signed
      fixture releases on every supported platform; offline/failed/wrong-signature
      updates; Windows updater bypass of normal exit; other-client/keep-running
      owners; runtime change; launcher failure; package-channel ownership; no hidden
      turn restart; latest changes between manifest/updater reads without mixing
      releases. **Dependencies:** M2–M5. Update-ready status reflects actual
      session-scoped installer availability.
- [ ] **M7 — Safe explicit cache maintenance.** Add payload-derived retention,
      per-entry lifetime use locks, preview and explicit prune without an
      installed-client registry.
      **Check:** inactive old client re-download after explicit eviction, retained
      payloads' Node requirements, live desktop between helper/teardown calls,
      live old bridge/CLI/owner, concurrent preparation/start/prune, process crash,
      no live deletion, removal of an unused version while another runs, runtime
      reference publication and selection/failed activation versus prune,
      native maintenance without self-blocking,
      and no user-data traversal.
      **Dependencies:** M2–M6. This is not a
      first-Windows-preview publication gate; it remains required for this overall
      delivery, rather than silently claiming cache cleanup exists.

## Qualification and completion evidence

| Surface                  | Required actual evidence                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64 desktop/CLI  | Clean per-user NSIS install, WebView2 handling, no system Node, PowerShell/tools, DPAPI, native drag/window behavior, active/idle upgrade, CLI Ctrl+C and redirected stdio, uninstall/data preservation               |
| Linux x64 CLI/server     | Oldest declared glibc/libstdc++ baseline plus representative newer distro; complete native closure, worker/WASM, headless credential behavior, real SSH and WSL installs, no target internet/npm/compiler             |
| Linux x64 desktop        | AppImage on declared GTK/WebKit baseline and newer distro, real local server, credential/backend behavior, startup/error UI, signed update, uninstall/manual removal retaining home                                   |
| macOS arm64 and x64      | Separate real matching targets, approved unsigned packages with explicit Gatekeeper limitations, quarantined downloads, Node JIT/native SQLite/keyring, no system Node, cached offline launch, app/CLI/server updates |
| Mixed versions/lifecycle | Compatible and incompatible clients, selected release after owner exits, late candidates, stale management intent, interrupted activation, no duplicate owner or silent downgrade                                     |
| Artifact trust/cache     | Tampering, metadata mismatch, hostile archive entries, truncated transfers, full disk/permissions, concurrent cold starts, unique stage cleanup, cache sharing, safe retention/prune                                  |
| Data                     | First-public-baseline and later release fixtures, settings/credentials retained, unsupported formats without mutation; concrete migration/backup qualification when a public format changes                           |

Run focused public-boundary and real-process tests while implementing, then root
`npm run check`. Native installed tests establish process/platform behavior;
mocked download/RPC tests do not. Use signed local fixtures for deterministic
two-release scenarios and a real anonymous GitHub smoke after authorized publish.
Record actual minimum-platform results; compile success is not qualification.

Visible native GUI tests run only at the end of a slice and only with explicit
user approval for that run. No GUI tests are authorized by this plan request.
Document failures/root causes without weakening checks or masking them with retries.

Synchronize README install/update/dev instructions, PLAN status/index,
interface/persistence architecture, protocol/control schemas, TESTING commands
and actual release coverage, and DEFERRED records as implementation lands. This
plan remains future behavior until those completion checks pass.

## Scope boundaries

No npm workspace publication, custom update service/CDN, background scheduler,
silent server/remote-fleet restart, independent Node updater, process/session
migration, general backwards-compatible conversation RPC, speculative feature
flags, universal macOS packaging, musl/custom Node build, store sandbox packaging,
tray/autostart, system service installer, delta updates, automatic cache prune,
or compatibility/migration/cleanup for private or pre-release installations.
Use Tauri's updater/packagers, maintained native bootstrap dependencies, existing
SSH/WSL transport and SQLite ownership. Revisit other channels/targets only for
a concrete user need and actual qualification capacity.

## Planning evidence

- Current repository and release/connection/data boundaries inspected on
  2026-10-10; private source repository and absent release workflow confirmed.
- Three read-only research and independent draft-review lenses cover CLI/bootstrap,
  desktop/platform updates, and server lifecycle/cache/data. Findings corrected:
  authenticated draft versus anonymous published validation, pinned updater/
  manifest identity, native prune avoiding self-blocking, and lifecycle-gate
  ownership while awaiting child shutdown/startup. No remaining material draft
  findings were reported; implementation/qualification remain entirely open.
- User simplification: one pinned downloaded runtime for source and installed
  execution; retire the selectable host-Node development path. Shared Rust helper
  prepares Node/CLI/server artifacts, not Tauri itself. This subsequent plan
  correction is self-reviewed; no implementation or runtime tests are claimed.
- User simplification: explicit Node/server/CLI directories and adjacent metadata,
  without release catalogs or installed-client registration. Explicit eviction
  can require inactive clients to download again. Three bounded independent
  reviews checked cache identity/lifetime and verified native desktop lifetime
  protection; no material findings remained at that review boundary.
- User scope decision: no compatibility with private/pre-release installations.
  Remove old cache/runtime-setting/control-file transition requirements and
  pre-release data migration checks. Public preservation begins at the first
  released baseline; migration/backup work is tied to actual later format changes.
  This subsequent scope correction is self-reviewed.
- User transport decision: local IPC only (Unix domain sockets / Windows named
  pipes), including the target-side bridge connection for SSH/WSL. Source and
  primary Node/Windows/Tokio documentation were checked; Windows native pipe
  creation policy remains a required M3 qualification, not a Node-default claim.
  This subsequent communication-contract correction is self-reviewed.
- User cleanup clarification: protect each running component and permit removal
  of unused versions independently; no mandatory previous-version reserve.
  Config uses numeric format versions and SQLite retains its existing mechanism.
  Three bounded read-only reviews checked these changes. The selected-release
  versus prune race was corrected by rechecking selection under entry protection
  and protecting selection publication. No application or GUI tests were run.
- Documentation validation: Prettier passes for all ten affected Markdown files;
  56 local links and the repository skill reference resolve; `git diff --check`
  passes. Application checks are not required for this documentation-only change.
- The planning phase was documentation only. No application changes, builds, native GUI
  tests, commit, push, repository creation, keys, or publication performed.

## Delivery evidence

2026-10-10, foundation in progress:

- Downloaded the original GPLv3 text from GNU. Product 0.1.0, exact Node 22.23.3
  official artifact URLs/checksums and four target descriptors are recorded.
  A project signing key is generated outside the repository; only its public key
  is tracked. No GitHub secrets, distribution repository or release are created.
- The shared Rust bootstrap downloads/verifies the pinned runtime, extracts into
  unique staging and publishes immutable cache entries. OS use locks protect
  active entries. Fourteen Windows Rust tests pass, including actual Tauri signature
  interoperability, tampering/wrong-key rejection, hostile TAR fixtures,
  failed/concurrent preparation, real child-process locks and signed offline reuse.
  Unix-only link and signal behavior remains to be qualified on Linux/macOS.
- Separate Windows CLI/server payloads retain the committed npm dependency
  topology and native/WASM/worker assets. Physically copied payloads outside the
  checkout pass CLI version, public RPC, a completed code-mode demo turn and
  SQLite history after process restart, under downloaded Node 22.23.3.
- Managed setup prepends its Node to PATH so npm lifecycle scripts share the
  application ABI. A development-home isolation defect is corrected: the
  account's ordinary global settings cannot become a project layer. All 28
  focused configuration cases pass; 21 release/provider identity cases pass.
- Three read-only foundation reviews found false standalone dependency evidence,
  stale output files, package-link relocation, validator disagreement, Unix
  signal lifetime and archive bounds. Corrections are in progress with focused
  regressions. Their identified foundation defects are corrected; these reviews
  do not establish unimplemented milestones.
- Full repository `npm run check` passes typecheck, lint, formatting and 1,065 tests
  (36 skipped) under the managed runtime. No GUI tests were run.
- A bounded Windows NAPI pipe-admission adapter uses explicit current-account
  DACLs, remote-client rejection and cancellable overlapped admission. A real
  headless smoke passes Node's public accepted-fd adoption, duplex I/O, replacement
  instances, canceled accept and immediate cancellation races. This is primitive
  evidence. The app and bridge now use local IPC, with no IP listener/fallback.
  Thirteen real Windows server/bridge/auth/lifecycle cases pass; independent
  integration review reports no remaining material ownership findings. Six
  simultaneous pending listeners also leave filesystem work and idle closure able
  to complete. The low-standard-descriptor concern was withdrawn after inspection
  of the pinned Node CRT: even headless startup reserves descriptors 0–2.
  Foreign-user and remote-client rejection and Unix stale-path retirement still
  need actual qualification.
- Management v1 inspection/stop/release are independent of application initialize.
  A real incompatible-handshake scenario still inspects the owner, rejects a stop
  aimed at another instance, and stops the intended instance. All 25 affected
  management/client cases pass. Persistent selected-server integration remains open.
- Before the native-search rebase, settings files require numeric version 1; profiles
  and RPC fragments stay versionless. Unknown versions fail before mutation. SQLite format remains 4,
  with its existing additive v3 step; unsupported formats now fail before changing
  persistent journal mode. Updated real settings fixtures and the full check
  pipeline pass: 1,074 tests, with 36 skipped, plus typecheck/lint/formatting.
- Local and remote owner control share the management-only stop boundary.
  Remote stop does not initialize an application client or assume a product
  version; it checks the captured home/server/instance and waits for closure.
  Fifteen focused real-process/management cases pass, including an application-
  incompatible remote owner and replacement-instance rejection.
- Console-launch gaps use standard hiding flags; interactive CLI console and
  inherited test-worker behavior are preserved. Three independent read-only
  reviews checked the scoped fix and
  [headless-testing evidence](../../research/2026-10-10-headless-testing.md).
  Native GUI tests remain visible and require approval per run; Windows Sandbox
  is optional on supported hosts. No isolated CI/VM infrastructure is planned.
  The full check above ran from a hidden command window; no GUI test ran.
- Rebased the complete uncommitted release work onto remote main `0dfb0ff`,
  retaining native search/finalized output, Gemini registration and its SDK,
  Mistral Conversations, and the chained SQLite v3/v4/v5 upgrades to v6 with
  historical context-checkpoint invalidation. Seven content conflicts and a
  cleanly merged stale Mistral User-Agent assertion are reconciled. Three
  independent read-only reviews find no remaining loss of upstream intent.
  The initial snapshot and earlier full-check/payload evidence above predate
  this rebase. The updated payload build and isolated RPC/turn/SQLite-restart smoke
  pass. Final combined-tree `npm run check` passes typecheck, lint, formatting and
  1,173 tests, with 36 skipped; no GUI tests ran. The pre-rebase checkpoint is
  retained, and work remains uncommitted. Before follow-up fixes, restoration
  checks verified all unaffected tracked files and all restored new files against
  that checkpoint, accounting for the deliberate merge resolutions.
- Local start/stop managers hold one OS lifecycle gate through their awaited
  operation; server owners do not reacquire it. After SQLite exclusion, startup
  checks the captured selection synchronously before schema initialization.
  Selection rejection leaves existing database bytes intact. Independent review
  removed a premature scoped-control callback API whose unawaited operations
  could escape lock ownership. The focused 58-case lifecycle/selection/SQLite/
  background/Docker run passes, including actual contended cancellation and a
  pending candidate retired before another owner is adopted. Windows phase
  diagnostics show native security preparation consuming the default five-second
  test allowance under full-suite load; these real integration cases use the
  existing thirty-second convention, with product deadlines and assertions intact.
  An unrelated Docker stat case timed out once in that full run; its focused
  regression and final full run pass without changes, and that transient's root
  cause is not established.
  Initial-selection rejection alone does not qualify ordinary older installed
  clients; the subsequent focused preparation evidence below still requires
  installed qualification, remote integration and update activation.
- CLI preparation is separate from server preparation. The native launcher loads
  only its own CLI/runtime; an actual local connect/start asks its native helper
  for the saved selected server and that server's declared Node. Utilities do not
  select or download a server. Eighteen Windows Rust tests pass, including signed
  CLI A/server B fixtures with different declared runtimes, offline use protection,
  first-start selection, malformed selection rejection and a selection change
  during preparation. These cached placeholder fixtures do not establish execution
  against two real Node ABIs or published release artifacts.
- Twelve headless real-helper regressions pass at the TypeScript process boundary:
  fragmented UTF-8 and bounded descriptors, exact captured paths/selection/cache
  keys, cancellation before/after readiness, EOF retirement through physical close,
  malformed/partial/missing output, premature successful/failed exit and failed
  OS spawn. Only the native-helper spawn edge is substituted; these tests do not
  override the production verification key or qualify installed downloads.
- Detached managed candidates borrow cache-use guards before spawn. The server
  acquires its own guards and exchanges a private Node IPC held/accepted message
  before SQLite admission; cancelled observers retain protection until handoff
  or physical candidate exit. Failed acceptance delivery retires the unaccepted
  child. Stdio commands and clients hold a borrowed guard through child exit,
  avoiding a second handshake for that lifetime. The focused 27-case CLI/helper/
  background run passes. The cancellation regression establishes release of the
  observer while its gated candidate remains protected, followed by authenticated
  readiness of that same PID. It does not qualify manager process death, OS prune
  exclusion or all installed lifetime/crash cases; those remain M2/M7 checks.
- After the CLI preparation/ownership corrections, the full managed
  `npm run check` passes typecheck, lint, formatting and 1,188 tests (36 skipped;
  136 passing files and nine skipped files). Fresh Windows CLI/server payloads
  pass the outside-checkout CLI stdio RPC/demo-turn/SQLite-restart smoke. All
  execution was headless; no GUI, commit, push or publication occurred.
- Desktop's shared preparation is implemented: Tauri consumes a captured exact
  Node/server pair; the old secondary copied runtime/dependency-junction cache
  is removed. Complete development payloads are copied and hashed once into
  immutable source snapshots, including their native modules. The desktop keeps
  its own control helper between calls and through app exit, while Local bridges
  separately hold their selected runtime. One narrow command executor owns
  bounded pipe reads, cooperative EOF cancellation and awaited physical exit for
  error/deadline paths. Release builds explicitly validate clean source identity
  and select release mode; development builds carry the complete source payload.
- Normal source CLI startup builds the same complete development server and asks
  the retained native helper to snapshot it. Source rebuilds attach to an already
  running owner; after explicit stop, the next shared start selects the new
  snapshot. Isolated stdio first checks for a live owner under the lifecycle gate
  and rejects it before changing selection. Release selections still require
  explicit activation and cannot implicitly downgrade.
- Headless preparation evidence includes real Rust desktop commands with the
  complete payload and verified pinned Node, oversized-helper physical retirement,
  and a real native-prepared bridge through RPC/SQLite, EOF persistence, live-owner
  reuse and rebuilt restart. The first smoke passed semantic assertions but
  failed Windows cwd removal with `EBUSY`: protocol-stop completion precedes
  physical Node exit. The smoke now awaits the OS process exit before fixture
  deletion. This does not qualify installed signed downloads, native UI,
  manager-crash/cache-prune lifetime or other platforms. The following slice
  implements cold preparation cancellation and app-shutdown admission.
- Native Unix child execution preserves the inherited foreground process group,
  so interactive terminal reads are not placed in a background group; explicit
  termination forwards to the child while the parent retains use guards.
  [Rust's process-group documentation](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#tymethod.process_group)
  describes how a new child group changes foreground terminal signal delivery.
  Interactive Unix qualification is not claimed from redirected Windows tests.
- After desktop integration, the full managed check passes typecheck, lint,
  formatting and 1,188 tests (36 skipped; 136 passing files, nine skipped files).
  Twenty native-bootstrap Rust tests and six desktop Rust tests pass; the latter
  includes two child fixtures. The native-prepared bridge smoke now passes
  through actual owner-process exit and fixture cleanup. No visible UI ran.
- The normal source CLI entry caught a Windows Node resolver defect: Rust's
  verbatim canonical checkout path produced `EISDIR` for the script entry. The
  launcher now uses the existing `dunce` library's equivalent ordinary spelling.
  The standard source `--version` command passes, and the bridge smoke also
  checks the actual native source launcher from outside the checkout, including
  that the utility command does not select a server. Fresh standalone CLI/server
  payloads pass the selected-executable RPC/demo-turn/SQLite-restart smoke.
- All M0–M7 completion gates remain open. No installed GUI
  tests, remote/platform qualification, updater activation, prune, publication,
  commit or push are claimed.

### Desktop cancellation and admission slice

- Run blocking cache preparation in an internal, hidden mode of the desktop
  executable, before any Tauri/window initialization. It uses the existing Rust
  bootstrap and retains use guards until the parent has acquired the same guards.
  Canceling preparation terminates and physically joins that helper; it cannot
  leave a blocking task waiting for an install lock or HTTP response inside the app.
- Register connecting operations before preparation, under the same admission
  mutex used by shutdown. Shutdown cancels and awaits those operations as well as
  already-spawned bridges; helper-cache mutex waiters are cancellable too.
- Check real lock contention, physical helper retirement, guard handoff, and
  shutdown during preparation without starting a native window. A killed download
  can leave private staging just as a process crash can; M7 must remove only stages
  proven unused. Installed UI and other-platform qualification remain open.
- [Tokio's blocking-task contract](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)
  explains why aborting the existing async wrapper cannot cancel a started
  blocking task. The process boundary is limited to preparation, rather than
  adding cancellation machinery throughout HTTP, archive and OS-lock code.
- The existing native channel now sends the operation ID before preparation;
  Local host Cancel/disconnect forwards its existing signal. Successful late
  admission after cancellation still detaches the bridge before returning.
- Eleven desktop Rust tests pass, including two child fixtures, three actual
  desktop-executable preparation cases and one controlled Node EOF-frame case.
  The focused transport/host regressions cover the early cancellation link.
  A valid JSON response ending at EOF is rejected before guard acquisition.
  The shutdown test qualifies admission/cancellation and awaited completion;
  this composes with actual helper retirement tests, but is not a real Tauri
  shutdown/native UI qualification. Other-platform/installed qualification stays
  open. Windows test fixtures copy Node across volumes, since hard links from
  the D: cache into C: temporary directories failed with `CrossesDevices`.
- The final full managed check passes typecheck, lint, formatting and 1,193 tests
  (36 skipped). Twenty shared native-bootstrap/launcher tests pass as well.
  Correctness, architecture/simplicity and evidence reviewers found no remaining
  material issue after the early cancellation link and framing fixes. The adapter
  suite also covers rejected cancellation commands followed by late admission
  and physical detach. No GUI, commit, push or publication ran. All M0–M7 gates
  remain open; next is replacing the remote legacy provisioning paths.

### Remote complete-payload installation (in progress)

Replace the current four-file/target-npm provisioning path. The target runs the
same native bootstrap from its complete server payload; it does not install a
CLI JavaScript payload or a separate bridge service. On first installation the
client transfers that target helper into a private attempt directory after
verifying its declared bytes. The helper installs transferred Node/server
archives through the existing bounded verifier/extractor, installation and use
locks, and atomic cache publication. It never needs target internet or npm.
Installing a payload does not activate it or change `server/current.json`.
Release transfers carry the original signed manifest; source transfers are
explicit development mode with complete target-native bytes and an archive
digest. Source archive digests name immutable remote development snapshots;
local source snapshots retain their existing copied-tree digests.

- [x] Add the shared offline install boundary and complete-server bootstrap
      executable. Check: altered/truncated bytes, metadata bounds, wrong
      target/runtime and missing entries fail before server publication; cache
      reuse needs no transport and retains component use guards.
- [ ] Replace SSH/WSL provisioning and the retired runtime-source choice.
      Depends on the offline boundary and complete Linux payload build. Check:
      real cold/warm target installs, no target npm/Node/network dependency,
      canonical paths, cancellation and selected-server behavior.
- [ ] Qualify the actual native helper, bridge/owner lifetime and mixed client/
      server cases. Synchronize command/docs evidence and independent review.
      These checks are headless; visible desktop tests still require approval.

The offline boundary and Windows payload inclusion are implemented and verified.
Remote integration, complete Linux artifacts and all overall M0–M7 gates remain
open. The first task's evidence establishes the shared boundary on native Windows,
not execution/ABI qualification of other-platform payloads.

- Twenty-nine native bootstrap/launcher tests pass. Signed fixture metadata now
  describes actual complete and deliberately incomplete tar archives, signed
  using a fresh disposable fixture key; its private half was removed. Cold server
  installation consumes exact fixture archive bytes with a controlled cached Node
  receipt. These fixtures do not execute their Node/addon/helper placeholders.
- Both source and release cache reuse bypass absent transfer archives and retain
  use guards. Bounds cover manifest, signature, archive and build metadata;
  required server files, mode/target/Node and signed version/source are validated
  before publication and on reuse. Actual helper cases prove descriptor output,
  guard retention through stdin EOF/physical exit and unknown-field rejection.
  Two helper cases also pass with release mode enabled, including rejection of
  development transfer descriptors.
- Three independent read-only reviews found the incomplete-release and warm-source
  gaps. Both are fixed at the shared boundary and covered by regressions; follow-up
  reviews report no remaining material issue in this slice.
- The first rebuilt payload attempt found that Windows cannot replace the source
  launcher while it waits for payload construction. Payload Cargo builds now use
  separate `native/target/payloads` scratch, preserving the waiting executable.
  Fresh Windows CLI/server payload builds and their isolated CLI/RPC/demo-turn/
  SQLite restart smoke pass. The prepared desktop bridge smoke also passes real
  shared Node, RPC/SQLite, EOF persistence, live-owner reuse, explicit stop,
  rebuilt restart and physical retirement. The full managed check passes
  typecheck/lint/formatting and 1,193 tests (36 skipped).
- Rebuilt complete desktop resources pass all eleven existing headless desktop
  Rust checks after the shared validation change. This includes the internal
  actual-executable preparation/cancellation cases; no native window is created.
- Windows sandbox private-ACL and immutable-binding hard-link restrictions were
  reproduced and checks rerun headlessly outside the sandbox without changing
  assertions. No GUI, commit, push, secrets upload or publication ran.
- The read-only Ubuntu probe confirms Linux x64/glibc 2.43, the current account,
  a C compiler and archive tools, but no Linux Cargo/Rust/Node on PATH. A Windows
  npm entry is visible through WSL PATH and must not be used for Linux builds.
  Next prepare an isolated Linux source/build tree with build-time Rust and the
  pinned managed Node, produce a complete Linux payload, then replace and qualify
  the SSH/WSL caller. This probe is not minimum-glibc release qualification.

### Complete remote caller replacement — implemented, qualification in progress

- [x] Build complete Linux source payloads in an isolated source/build directory
      with pinned Node 22.23.3 and private Rust 1.90.0, without changing Windows
      dependencies. Native tests pass 33 cases on Linux; cached boundary tests
      pass 31 on Windows. The Linux builder uses glibc 2.43, not the declared
      minimum release baseline.
- [x] Replace target npm/host-Node provisioning with controller-side downloads
      and SHA-checked transfers to the shared native installer. Remove the saved
      runtime selector from schemas and both clients, with no pre-release adapter.
      Source remote inputs are explicit complete Linux deployment files from
      `prepare:remote`; released selection uses signed original metadata and
      preserves a previously selected server's own runtime.
- [x] Add cached-only native inspection/bridge launch. It validates cached
      complete server layout, signed/source identity and exact Node and holds
      use protection before Node imports through physical bridge exit. The
      detached owner now uses the existing IPC guard handoff.
- [x] Exercise source cold/warm installation, shared Node, bridge loss,
      live-owner preservation and source restart through actual isolated SSH.
      Initial run passes three tests (including two auth failures), with two
      WSL/TUI cases skipped. The fixture has no Node/npm/compiler/curl installed.
- [x] Finish current full managed checks and three independent review lenses.
      Review found and corrected the omitted detached-start guard handoff and
      unobserved text-upload stdin errors. New early-exit/corrupted-bootstrap
      regression runs pass through actual SSH and WSL; the full managed check
      passes typecheck, lint, formatting and 1,193 tests (36 skipped). All three
      follow-up reviews report no remaining material finding in this slice.
- [x] Qualify actual WSL and rendered TUI through the new headless runner.
      Correct its settings version/discovery paths; do not reuse earlier legacy
      deployment evidence as current qualification.
- [x] Qualify abort while a target native installer is blocked on its install
      gate, including physical target retirement before staging cleanup.
- [ ] Qualify the signed-release remote branch and minimum-glibc distribution.

These steps do not close M2/M3 or the overall release goal. Installed cross-version
ABI/process-death/prune boundaries, packages, updater activation, workflow and
publication inputs remain open. No visible GUI tests or external publication ran.

The WSL TUI failure was a fixture prerequisite: Ink's input listener is installed
by a passive React effect after rendering. The remote fixture now uses the same
`act` effect flush as existing TUI tests, without sleeps or weaker assertions;
the original real conversation/approval/reconnection scenario passes.

Lock-wait qualification exposed a real SSH defect: killing the local transport
left a target native installer in `locks_lock_inode_wait`. Preparation now watches
stdin EOF independently of its blocking work, and the controller closes stdin
and awaits exit before cleaning its own transfer stage. The corrected original
SSH run passes three tests (two WSL cases skipped), and WSL passes two tests
(three SSH cases skipped). A review also found unnecessary installation waits
in cached bridge opens. Those opens now validate immutable complete directories
under shared lifetime protection, retaining permission, receipt and entry checks.
The revised native suite passes 32 Windows and 34 Linux cases; the complete
Linux payload is rebuilt. Fresh real SSH and WSL cached-bridge-under-gate
assertions pass, as does the full managed check (1,193 tests, 36 skipped).
Three read-only follow-up reviews report no
remaining material finding after fixture cleanup and cached-read corrections.

These lock-wait tests run before native extraction. Process exit skips Rust
destructors and can leave internal private scratch during another phase;
explicit unused-stage cleanup and its crash/lifetime proof remain required in M7.

### Release artifact assembly and version cut — in progress

- [x] Add one clean-checkout patch/minor/major version command, updating product,
      npm root, native workspace and desktop identities and lockfile records.
      Check: mismatched inputs fail before edits; the emitted version is coherent
      and can be committed/tagged by the later protected workflow.
- [x] Package finished release CLI/server payloads and native launcher, binding
      target/build identity and exact size/digest without rebuilding them.
- [x] Assemble the declared target matrix and Tauri update metadata from exact
      packaged bytes; reject mixed versions/commits, incomplete matrices and
      duplicate/conflicting assets before producing metadata for signing.
- [ ] Wire protected manual GitHub release jobs and qualify their actual output.
      Public repository/credentials and anonymous installation remain external
      publication gates; local tooling alone does not establish M5 completion.

The version and artifact contract checks pass twelve focused cases using real
Git, files, tar and hashes, with controlled upstream-runtime, native-process and
signature edges. Nine cases are new. The full managed check passes typecheck,
lint, formatting and 1,202 tests (36 skipped). Native bootstrap/launcher tests
pass 34 cases on Windows and 36 on Linux; twelve headless desktop Rust tests
pass, including the actual early build-info entry before window/home setup.

Review found three integration gaps: mirror URL spelling incorrectly changed
Node cache identity, desktop signatures alone did not bind build identity, and
assembly omitted parts of Node's archive layout. Cache reuse now validates
content/layout independently of transport URL without rewriting receipts.
Desktop packaging consumes a record from one fresh Tauri build, rechecking the
native identity, recorded installer/update bytes and project signature. Assembly
requires the entire runtime pin and canonical asset name. A release-only overlay
supplies Tauri's required updater public key. Three read-only reviews were used;
actual fresh signed platform builds, source export, protected workflow and
publication remain unfinished required work. No visible GUI tests ran.

The foundation is committed locally as `99724cd`. A fresh release-mode Windows
CLI/server payload build passes. The first actual Tauri invocation produced its
NSIS installer but waited for a password prompt: Windows did not carry the empty
password environment value to that child, and the wrapper had omitted Tauri's
noninteractive mode. The verified headless build process was retired; the open
user app was untouched. The wrapper now passes `--ci`, which makes Tauri use its
noninteractive signing contract instead of prompting. Fresh signed output
qualification remains open until that corrected invocation completes.
