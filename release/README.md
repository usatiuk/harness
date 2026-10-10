# Release inputs and work in progress

`product.json` is the product identity. `node.json` pins complete official Node
22.23.3 distributions and their verified SHA-256 digests. `verification-key.pub`
is the public project key used for manifests and Tauri updates. This signing is
free; Windows/Apple publisher certificates are separate and are not configured.
The verbatim GNU GPLv3 text is in the repository's `LICENSE`.

The private production key is outside the repository at
`C:\Users\stepus53\.harness-release\signing.key`, protected for the current
account. Back up that file securely before public release. Do not commit it,
print it in logs, or attach it to a release. Future protected GitHub release jobs
will receive `TAURI_SIGNING_PRIVATE_KEY` and its password through repository or
environment secrets; a scoped distribution-repository token is also required.
No secrets have been uploaded and no release has been published.

Release-cut tooling is implemented; actual signed platform outputs and the
protected publication workflow still require qualification:

```sh
npm run release:version -- patch # also minor or major; requires a clean checkout
# Commit the coherent version edit before release builds.
npm run release:payloads -- --release
npm run release:desktop          # fresh Tauri build, signed updater, captured output record
npm run release:artifacts -- package PAYLOADS OUTPUT LAUNCHER NODE_ARCHIVE MINIMUM_PLATFORM DESKTOP_BUILD_JSON
npm run release:artifacts -- assemble INPUT OUTPUT windows-x64,linux-x64-glibc,macos-arm64,macos-x64
```

`release:version` edits only product identities and their root/local lock records,
leaving internal npm package and dependency versions independent. Packaging reads
actual native build identities and the desktop record, retains complete payload
archives, and verifies exact bytes and updater signatures. Assembly rejects mixed
sources/versions, undeclared/missing targets, changed runtime layouts and asset
collisions before writing `release.json` and matching `latest.json`. It does not
sign/publish these files. Source export and the protected signing/publication jobs
remain required work. Runtime artifacts refer to a separate immutable
`runtime-node-<version>` GitHub release, which must never become product latest;
cache content identity permits verified mirrors of identical bytes.

The fresh desktop build uses private Cargo scratch and one Tauri invocation;
the generated overlay includes the committed public updater key, required by
[Tauri's bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-cli/src/interface/rust.rs#L789-L800).
The output record binds its executable identity to the generated installer and
update hashes; it is build provenance, not another signature/trust root. Native
`--build-info` exits before home preparation or Tauri initialization. The tooling
tests use controlled native/signature edges; real cryptography, native probes and
platform package qualification remain separately identified in the delivery plan.

Developers start with `npm run runtime:setup`, which uses Rust to prepare the
pinned Node and runs the committed npm installation under that runtime.
`npm run dev`, `npm test`, `npm run check`, and root desktop commands use it too.
Source execution defaults to this checkout's `.harness-dev`.
Normal source CLI startup builds a complete server payload before actual
connection preparation snapshots it. Source rebuilds retain a live owner until
explicit stop; isolated stdio starts reject a live shared owner without changing
its selection.

`npm run release:payloads` builds separate complete CLI/server directories under
`release/output/<target>`. The builder freezes the committed npm topology, copies
native/WASM/worker assets, and replaces scratch output only after a complete
fresh build. Managed targets will not install npm packages. Pass `-- --release`
only from a clean source commit to capture release metadata.

Complete server payloads include the same native bootstrap executable for target
installation/control; they do not include a CLI JavaScript payload or Node.
Payload compilation uses separate native build scratch so it can run while the
source launcher is waiting, including on Windows. The shared offline installation
API verifies transferred release metadata and exact archive bytes, enforces the
complete server layout/build identity before publication and on cache reuse, and
does not activate a server. Explicit source transfers use archive-digest snapshots
and the bundled Node pin; warm installs need no transfer archives. The internal
`--install-transferred-server` helper holds both use guards until stdin EOF.
The controller keeps stdin open until the ready descriptor; cancel closes it
and awaits target exit before deleting its transfer directory. The helper watches
EOF independently of blocking installation, because terminating a local SSH
process does not necessarily retire the target command. Cached-only opens use
shared lifetime protection without installation gates or downloads. Interrupted
native extraction can leave private scratch after process exit; unused-stage
cleanup remains part of explicit cache maintenance.
Release-mode helpers reject source transfers. SSH/WSL now uses this boundary;
the target launches cached payloads offline through their native bootstrap,
holding exact Node/server guards through bridge exit. Detached startup uses the
existing child guard handoff. Neither target npm nor a host-Node choice remains.

For source remote work, run `npm run prepare:remote` on Linux x64 glibc (including
WSL). It builds a complete server and writes `remote.json`, `server.tar.gz` and
`harness-bootstrap` under `release/output/linux-x64-glibc`. Copy those three
files together to the controlling machine and set
`HARNESS_DEVELOPMENT_REMOTE_PAYLOAD` to that directory. The source output is
explicit development input, not a public signed release. Real SSH qualification
uses `npm run test:remote`; Windows WSL qualification uses `npm run test:wsl`
with `HARNESS_REMOTE_WSL` set. Both are headless. Installed signed release
deployment and the minimum glibc baseline remain unqualified.

Run the physically isolated headless payload smoke with:

```sh
node scripts/development.mjs node --conditions=development --import=tsx release/tools/smoke-payloads.ts release/output/windows-x64
cargo test --manifest-path native/Cargo.toml
```

The signed Rust test fixture uses a separate disposable key; its private half is
not tracked. Its descriptors are controlled cache fixtures, not published
artifacts. Shared JSON validation cases are consumed by both TypeScript and Rust.

Source/background servers use local IPC, with management v1 available before
application initialization. Windows headless admission/lifecycle checks pass;
foreign-user/remote-client rejection and Unix socket cleanup are not yet qualified.
The native CLI prepares its own payload/runtime separately. Actual local
connect/start prepares the persisted selected server and its declared runtime;
ordinary utility commands do not select a server. Focused signed fixture and
real-helper tests cover that separation and cancellation/retirement. Detached
startup hands cache-use ownership to the child before SQLite; stdio retains a
borrowed guard through physical child exit. Installed downloads, different real
Node ABIs, manager death and cache pruning still require qualification.
The desktop consumes the same native-prepared paths, keeping its own control
helper between calls and selected Local helpers through physical exit. Development
desktop builds carry a complete server payload and download shared Node; the
`desktop:release` workspace command checks clean source and embeds release mode
for on-demand verified preparation. This entry point does not establish a
published installer or update workflow. Headless desktop preparation/bridge
checks are documented in [testing guidance](../docs/TESTING.md).
Blocking desktop preparation runs in an internal hidden mode of the same
executable, before Tauri/window setup. Cancel terminates and joins that helper;
successful preparation transfers use protection before helper exit. The UI uses
its existing abort signal and early native operation event to cancel preparation.
Persisted settings use numeric version 1; unknown settings and SQLite formats fail
without changing data. Installed launcher integration, platform packages,
publication workflow, updates and cache pruning remain in progress
in the [delivery plan](../docs/plans/cross-cutting/2026-10-10-release-installation-updates.md).
