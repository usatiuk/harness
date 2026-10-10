# Release, installation, and update research

Date: 2026-10-10. Scope: installed desktop, CLI, shared local/remote server,
separate Node runtime, compatibility and updates. These findings inform the
[delivery plan](../plans/cross-cutting/2026-10-10-release-installation-updates.md);
they are not claims of delivered release support.

## Repository evidence

Read-only inspection found the following:

This section records the initial planning snapshot. Subsequent implementation
and the rebase onto `0dfb0ff` are recorded in the delivery plan; the accepted
SQLite schema is now v6 with additive v3/v4/v5 upgrades, while protocol remains v4.

- `packages/desktop/src-tauri/tauri.conf.json` uses version 0.1.0, identifier
  `local.harness.desktop`, current-user NSIS and server resources. No updater.
- `packages/desktop/tools/package-server.mjs` copies `process.execPath`, its
  license and recursively discovered installed native/runtime packages.
  `packages/connections/tools/bundle-server.mjs` bundles server and worker for
  Node 22, externalizes SQLite/keyring/DPAPI/devcontainers/QuickJS and generates
  a new transitive lock from pinned direct dependencies. Rebuilding can therefore
  resolve different transitive dependencies; release closure needs freezing.
- `.nvmrc` selects 22; remote managed deployment in `remote.ts` pins 22.23.3.
  Desktop does not enforce that exact runtime. Some previously recorded desktop
  builds used developer Node 24.19.0.
- `packages/cli/package.json` is private 0.0.0 with an unbuilt dist bin. CLI source
  runs with developer Node/tsx; remote payload preparation can invoke a
  repository-relative bundler. Installed releases must remove these dependencies.
- `local-runtime.ts` protects live packaged servers with immutable code/Node/
  dependency copies. `remote.ts` verifies portable Node and stages code/dependency
  caches through SSH/WSL, but target npm installs remain part of managed deploy.
- `contracts.ts`, `local.ts` and `commands.ts` bind discovery/control to current
  application protocol. `connect.ts` attaches before starting and stops an
  expected authenticated instance. Neither persists selected product release.
- `background.ts` currently listens on OS-assigned loopback TCP and `local.ts`
  connects to that port after loading private discovery/token state. The user's
  release requirement replaces this transport with local IPC, without a TCP
  compatibility branch. `runLocalBridge` forwards stdio to its authenticated
  owner connection; `remote.ts` launches that command through SSH or `wsl.exe`.
- Tauri Rust needs Node before host commands/connect/exit helper invocation.
  Therefore a JS-only on-demand Node bootstrap is circular. A shared small Rust
  bootstrap plus native CLI launcher is an engineering recommendation shaped by
  these existing two consumers, not a general installer framework.
- `main.rs` performs physical drainage and conditional Local release in normal
  app exit handling. A downloaded updater must explicitly await that same work.
- `packages/code-mode/src/evaluator.ts` loads `worker.mjs` with Node's Worker API:
  it is a worker thread; detached server, CLI and bridges are separate processes.
- SQLite format is 4 with additive 3→4; other populated formats currently request
  reset. `packages/store-sqlite/src/schema.ts` uses an exclusive transaction and
  `PRAGMA user_version`; existing tests cover v3 history preservation and
  unsupported-format rejection. They were inspected, not run for this research.
  No complete public migration/backup/rollback promise exists.
- `packages/connections/src/contracts.ts` already versions `client.json` with
  numeric `version: 1`. `packages/config/src/settings.ts` validates strict
  global/project/local settings without a version field. Existing config writers
  use atomic file replacement and their established writer coordination; there
  is no general config migration runner.
- CI validates Windows/Ubuntu source only. Source repo `usatiuk/harness` is private;
  `gh release list` showed no releases. No tracked project LICENSE/NOTICE was
  found. Publishing destination, terms, keys and OS identities need explicit inputs.
- Existing tests qualify actual Windows app behavior and Linux SSH/WSL paths;
  they do not establish clean installer upgrade/uninstall or macOS/Linux desktop
  release support. No release experiments or GUI tests were run for this note.

## Platform artifacts and Node

[Tauri distribution](https://v2.tauri.app/distribute/) and its
[GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/) provide normal
platform packages and release upload. The monorepo must explicitly prepare its
resources/payloads; the action cannot infer that step. Separate macOS architectures
avoid assuming one architecture's Node/addons make a universal application.

[Tauri AppImage guidance](https://v2.tauri.app/distribute/appimage/) recommends
building on the oldest intended supported environment with WebKitGTK 4.1,
including Ubuntu 22.04/Debian 12 examples. AppImage does not eliminate libc or
webview requirements. CLI/server baseline is independent of the desktop baseline.

The [Node 22 support matrix](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#platform-list)
documents Linux x64 official binaries at glibc 2.28/kernel 4.18 and marks musl
experimental on that line. Native addon/libstdc++ requirements also need matching
old-baseline builds and execution. A newer Node branch's support status is not
evidence for the pinned 22 runtime. [Node release schedule](https://nodejs.org/en/about/previous-releases)
guides LTS choice at release cut.

Fully static musl conflicts with dynamic native addon loading in the current
server. [musl maintainer explanation](https://www.openwall.com/lists/musl/2021/09/24/6)
describes why static dlopen is unsupported and why a private dynamic loader is a
different approach. [Unofficial Node builds](https://github.com/nodejs/unofficial-builds#builds)
provide musl binaries but are not a demonstrated Harness platform. The user
accepted a manylinux-style older glibc baseline; no custom static Node is planned.

[Node SEA](https://github.com/nodejs/node/blob/main/doc/api/single-executable-applications.md)
requires special native addon/assets handling. It would combine concerns the user
wants separate and complicate the worker/package closure. Use normal immutable
payload archives plus pinned Node. A statically linked Rust bootstrap alone does
not make the Node/server payload musl compatible.

## Signing and macOS external runtimes

[Windows signing](https://v2.tauri.app/distribute/sign/windows/) establishes
publisher identity; a new signed build can still receive reputation warnings.
An explicitly labeled unsigned Windows preview is possible, but signing policy
must be decided before representing release experience as qualified.

[macOS signing](https://v2.tauri.app/distribute/sign/macos/) and
[Apple notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
apply to executable distribution. Downloading Node outside the `.app` avoids
mutating a signed application but does not make desktop signing cover that Node
or its native addons. Preserve and inspect actual executable signatures and
entitlements; qualify quarantined downloads, JIT, SQLite and keyring. Notarization/
ticket handling depends on the distributed container; don't assume ZIP tickets
can be stapled like app bundles. [Apple signing procedures](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)
describe code and library validation.

[Node's entitlement template](https://raw.githubusercontent.com/nodejs/node/v22.x/tools/osx-entitlements.plist)
includes JIT and library-validation allowances; source template is not evidence
for the specific downloaded release executable. This remains a macOS release gate.

## Tauri updater boundary

The [official updater](https://v2.tauri.app/plugin/updater/) supports static GitHub
`latest.json`, mandatory update signatures, Windows NSIS/MSI, Linux AppImage and
macOS app archives. Signing updates is separate from OS publisher signing.
Package-manager installations should retain that package manager's ownership.

The [updater v2.9.0 implementation](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/updater-v2.9.0/plugins/updater/src/updater.rs)
starts the Windows installer and exits directly. Its synchronous before-exit hook
cannot await fallible Harness drainage. Add a Rust-owned async activation boundary
that reuses existing teardown before installation. Do not assume ordinary Tauri
exit events cover an updater's process exit.

[Updater JS API](https://v2.tauri.app/reference/javascript/updater/) separates
download/install, but retains its downloaded bytes in an in-process resource.
Rust install of supplied bytes assumes previous verification. Initial session-
scoped installer staging reuses that mechanism without a second disk cache.
If later persisting installers, revalidate cached bytes against the pinned signed
descriptor before installation; never pair old bytes with fresh latest metadata.

App update and server activation are separate. Conditional Local release must
respect other clients/keep-running; force stopping a shared owner would violate
existing behavior. New helper/runtime prerequisites must be cached before app
replacement so an otherwise successful update does not strand offline startup.

## GitHub as the download/update origin

[GitHub release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas)
permit up to 1,000 assets per release, each under 2 GiB, with no documented total
release-size/bandwidth quota. This is sufficient for the selected artifact matrix.
[Release links](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
provide pinned URLs and a moving latest asset URL.

[Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
lock tags/assets after publication and recommend uploading all assets into a draft
first. Release attestations bind the distribution repository's tag, commit and
assets; they do not automatically attest a separate private source checkout.
Public source is not required for public artifacts: use a public distribution
repository with a scoped CI publisher credential. No client token is shipped.

## Lifecycle, cleanup and simplicity conclusions

The user requires local communications to use OS-local IPC. [Node's built-in
IPC API](https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support) covers Unix
domain sockets and Windows named pipes with the same stream interface. Keep the
existing `vscode-jsonrpc` peer and bounded NDJSON framing; do not replace the RPC
stack because its underlying stream changes. Unix socket address lengths are
limited and crash leftovers need owner-controlled cleanup, so use a short
private IPC directory and retain canonical-home/instance validation.

The bridge is a foreground command in the server payload, launched for an active
connection. SSH/WSL carries its stdin/stdout; it attaches/authenticates to the
target account's owner through local IPC and forwards protocol bytes. Target
authentication secrets stay there. EOF disposes the observer, while accepted
work belongs to the persistent owner. It is not another deployed service.

Windows pipe names alone do not enforce locality or account isolation.
[Microsoft documents pipe access controls](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).
The [pinned Node/libuv creation path](https://raw.githubusercontent.com/nodejs/node/v22.23.3/deps/uv/src/win/pipe.c)
does not set `PIPE_REJECT_REMOTE_CLIENTS`; claiming Node defaults fulfill a strict
local-only requirement would be unsupported. Maintained native facilities such
as [Tokio's pipe creation options](https://docs.rs/tokio/latest/tokio/net/windows/named_pipe/struct.ServerOptions.html#method.reject_remote_clients)
expose that flag. Qualify a narrow native creation adapter and account permissions
without moving JSON-RPC or agent ownership into a Rust service. No such adapter
or pipe qualification has been implemented by this planning work.

The user subsequently selected removal of the host-installed development Node
mode. Source development still selects local code and HMR, but execution uses the
same pinned downloaded Node as installed clients/servers. Existing runtime-source
choices are retired, not retained as a fallback. This narrows runtime preparation
and makes source runs exercise the managed runtime path.

[Tauri's architecture](https://v2.tauri.app/concept/architecture/) uses Rust and
the system webview; Node is not included. The shared native helper prepares Node
and Harness's Node-based payloads, not Tauri startup. Linking that helper into
desktop and the independent CLI launcher avoids two installation implementations
without creating an additional process or service.

Use signed exact-release component references, not independent latest queries
for Node/server/client. Persist one selected server release; ordinary old clients
must read it. Check a managed owner's selected identity after database exclusion
and before schema mutation so a late old candidate cannot restart old code.
Use the existing authenticated channel for a small stable management envelope,
not a full legacy conversation RPC adapter.

Node runtime files can be shared on a host; Node processes are independent. All
live processes capture immutable paths. SSH/WSL transfer of verified artifacts
lets managed remote setup work without target internet or npm. The analogous
[VS Code Remote SSH model](https://code.visualstudio.com/docs/remote/ssh#what-are-the-connectivity-requirements-for-the-vs-code-server-when-it-is-running-on-a-remote-machine-vm)
also supports local download and transfer.

[Maintained self-replace](https://docs.rs/self-replace/latest/self_replace/)
offers native launcher replacement including Windows. Actual terminal behavior
still needs qualification: [Microsoft Ctrl+C/Break documentation](https://learn.microsoft.com/en-us/windows/console/ctrl-c-and-ctrl-break-signals)
warns that ignoring Ctrl+C can be inherited by children. Forward stdio/signals
instead of buffering input or disabling the TUI's cancellation.

Use component directories (`runtime/node`, `server`, `cli`) with verified metadata
beside their payloads. Separate release catalogs and installed-client references
are unnecessary for explicit cleanup. Keep one durable server selection to
prevent an old client from downgrading the next start. Live discovery/authentication
belongs in `.running-server`; store the stable server ID separately and retain it
across public-release updates.

The user explicitly ruled out compatibility with private/pre-release installs.
Use the new layout directly, without old cache, runtime-setting or control-file
transition adapters. Data-preservation guarantees start at the first public
baseline. Concrete migration/backup work belongs to actual later format changes,
not a historical compatibility project before the initial release.

Completed cache deletion is not safe merely because the server stopped: CLI/
bridges can still use its files. The user's simple rule is per component: running
consumers prevent managed removal; unused versions can be removed. Use per-entry
OS shared/exclusive locks rather than blocking all cleanup whenever any app runs.
[Rust's standard file API](https://doc.rust-lang.org/std/fs/struct.File.html)
documents shared/exclusive/nonblocking locks and handle-lifetime release, while
warning that platform interactions may be advisory. This is cooperative Harness
protection, not an OS guarantee against arbitrary manual deletion. The chosen
facility must match the project's Rust/toolchain and real detached-process needs.

Explicit cleanup may remove inactive older-client payloads, whether their launcher
is still installed or has been uninstalled. Those clients download their pinned
release again; offline startup is not promised after deliberate eviction. There
is no installed-client registry or mandatory previous-version reserve. Retained
payload receipts determine needed Node versions. Runtime use must also cover
publication of dependent payloads, and pruning rechecks references under exclusive
runtime use, so installation cannot create a reference to a deleted runtime.
Native desktop protection spans helper gaps and teardown; detached servers retain
their own protection after the client exits. Cleanup rechecks the selected server
under the candidate entry's exclusive protection; selection publication holds
target use, preventing a failed activation from leaving selected files eligible
for an obsolete prune decision. Cleanup manages only the new layout.
Defer automatic policy; never substitute PID guessing or a heartbeat supervisor.
This is an implementation gate, not already established coverage.

Numeric JSON format versions and small explicit conversion functions are
sufficient; no generic migration framework is needed. Current strict parsers mean
an additive field may still be an incompatible format change. Config migration
coordinates with every writer across processes, reusing established file locking
where present rather than assuming a process-local queue is sufficient.
Keep SQLite's existing
[application-controlled `user_version`](https://www.sqlite.org/pragma.html#pragma_user_version)
independent of config, product and protocol numbering. Future public schema
changes commit concrete SQL and the new number together under server ownership.
A version tag alone does not migrate data. Unknown/newer formats fail without
overwrite; existing pre-release reset guidance must not become public data-loss
guidance. Before a real public migration, retain one latest completed private
backup per data file and qualify restore. SQLite's
[backup API](https://www.sqlite.org/backup.html) produces a consistent snapshot;
copying only a live database file is insufficient when WAL contents matter.

## Evidence limits

Three read-only research agents examined CLI/bootstrap, desktop/platform updater,
and server/cache/data. Primary sources were checked on 2026-10-10. No executable
bootstrap, release matrix, signing setup, updater, native-file-lock facility,
installer migration, musl experiment or public download was exercised. Final
platform/library selection must preserve the plan's concrete checks.
