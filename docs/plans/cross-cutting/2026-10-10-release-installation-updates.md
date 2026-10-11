# Product releases, installation, and updates

Status: implementation in progress. The simplification requested October 10
supersedes the former source-export, license-inventory, sealed-publication and
per-artifact retention designs. Those are removed requirements, not delivery gates.

## Summary

Harness ships a desktop installer and a small native CLI launcher. Neither needs
system Node. They download separate server/CLI payloads and share a pinned Node
runtime in `~/.harness/runtime/node`. A remote Linux host uses the same bootstrap;
SSH/WSL carries stdin/stdout to a bridge that connects to its local owner.
Local communication uses Unix sockets or Windows named pipes, never a TCP port.
CLI installation is a direct download to a directory on PATH, such as
`~/.local/bin/harness`; no additional install script is needed. Public CLI asset
names are stable (`harness-linux-x64`, `harness-macos-arm64`, `harness-macos-x64`,
`harness-windows-x64.exe`) so GitHub's `releases/latest/download/` URL selects the
latest published version. Signed metadata still pins the release-specific URL.

Each account/home has one background server, shared by CLI and desktop. The saved
server selection is independent of the installed client's version. Clients inspect
the management/protocol versions before attaching and explain incompatibility.
Connecting or opening a client prepares the newer of its required server version
and the saved selection. It never downgrades. A newer compatible running owner is
reused. An older idle owner is stopped and replaced through the existing lifecycle
lock. Active work prevents replacement: finish or stop it, then use Reconnect or
reopen the CLI. There is no separate server-update action or background waiting
queue. Recovering in-flight work is outside scope. Persistent conversations and
settings survive uninstall and updates.

Client updates are explicit: Settings uses Tauri's updater; `harness update` uses
the same signed release metadata and existing download cache. The CLI prepares its
Node/JavaScript payload before replacing the launcher and takes effect on its next
invocation. Neither action force-upgrades a busy server. Unix replaces the launcher
by atomic rename. Windows retains one `.previous` binary because running images
cannot be deleted; the next update removes it once older CLI processes have exited.
A replacement failure restores it; a crash between Windows renames requires manual
restoration from that file. No deletion helper, registry or cleanup daemon is needed.
CLI updates compare against the invoking binary and serialize within its shared
home; independent `HARNESS_HOME` installations are not coordinated.

Downloads are signed and hashed, staged, then installed atomically. Installed and
deployed server code is immutable, so rebuilding does not replace code already
loaded by a running owner. Ordinary source development and tests use local
Node/npm and workspace code; only deployed remote servers need downloaded Node.
Source CLI and Tauri share `.harness-dev/source`, separate from packaged development
and ordinary installations. Stop source processes before rebuilding native modules
on Windows; no development-specific executable cache is needed.
One shared
cache-use lock covers a running CLI, desktop helper and server. Explicit pruning
requires exclusive ownership and refuses while a consumer is running. There is no
installed-client registry, dependency-use graph or cleanup daemon.
`harness cache prune` previews disposable payload and staging directories;
`--apply` removes them only when the cache is unused. Persistent data and the saved
selection remain. Missing selected or client-pinned versions download on the next
launch; cleanup does not track installed clients or retain historical downloads.
Pruned development server selections need redeployment from their source checkout.

A manual GitHub workflow accepts a patch/minor/major bump, commits the new version,
builds the platform artifacts, signs them, and creates a draft release. Standard
Cargo, npm, Tauri and `gh` commands own these operations. Source, tags, assets and
update URLs use the public `usatiuk/harness` repository. Publishing uses the job's
built-in GitHub token; no separate downloads repository or publishing token exists.
`release/` contains only
the necessary Node pin, public key, test fixture and generated build output.
The exact GNU GPLv3 text stays in `LICENSE`; license collection/export tooling is
explicitly outside this work. OS publisher signing is unavailable. The project key
protects downloads and Tauri updates; its private half is never committed.

## Constraints and simplification history

- Preserve the MCP delivery on remote main (`97eea03`) and unrelated changes.
- The one-time simplification audit reduced **13,864 added code lines** at
  `6d59a40` to **6,374** at `95ac3b3`, measured against `97eea03` and including
  tests/workflows. The requested halving was met. The user clarified that this
  was not a permanent line budget; judge subsequent work by necessary behavior
  and simplicity, without compressing formatting or moving machinery elsewhere.
- No custom release publisher, source/vendor inventory, artifact-sealing layer,
  symbol-version parser, automatic pruning or pre-release migration framework.
- No GUI/native visible tests without approval for that run. Headless tests are
  allowed. Keep Windows child commands hidden.
- Coherent validated commits and periodic direct pushes to main are authorized.
  The user authorized making `usatiuk/harness` public and uploading the signing
  key to its CI secrets. The user authorized publishing `v0.1.2` on October 11.

## Platform and data boundaries

Initial artifacts target Windows x64, Linux x64 glibc, macOS x64 and macOS arm64.
Linux builds use Ubuntu 22.04; older distributions are unqualified. There is no
custom ELF baseline parser. Static musl support is not promised for Node/native SQLite.
The remote target requires internet for first-use downloads. Source remote fixtures
can transfer a built Linux server archive; that is a development/test boundary.

Versioned settings/client JSON reject unsupported formats clearly. SQLite has
an existing schema version and concrete migrations; preserve the native-search
schema v6 and additive migration behavior. Data-compatibility guarantees begin
with the first public release. Future destructive migrations require a concrete
migration/backup design when needed, not a speculative framework now.

The product version comes from root `package.json`; native Cargo versions and
Tauri's package version must match. Payload metadata captures the mode,
target and Node pin. Git commit provenance belongs to the workflow's tag and release
notes, not a second runtime identity check. The signed release manifest declares component locations,
sizes and hashes. Protocol compatibility is checked by the actual server handshake,
not duplicated in download metadata.

## Delivery checklist

- [x] Simplify the release pipeline and remove license/source inventory machinery.
      Completion: minimal workflow validates; actual payloads build; no stale callers.
- [x] Replace per-artifact lifetime/retention machinery with one cache-use lock.
      Depends on the payload contract. Completion: running consumers prevent removal,
      cancellation joins helpers, source rebuilds retain the previous owner safely.
- [x] Validate shared local owner and SSH/WSL bootstrap flows.
      Depends on runtime simplification. Completion: headless CLI/server smoke,
      socket/pipe and available source-remote regressions pass.
- [ ] Complete connect-time server upgrades, explicit client updates and cache pruning.
      Depends on the simpler runtime boundary. Completion: supported upgrade status,
      stop/install/start and safe explicit cleanup work without an installed-client
      registry or unattended deletion. Do not add a new cleanup subsystem meanwhile.
      Cache pruning passes the native command regression and three independent
      reviews. Desktop updates use Tauri's updater through one explicit check/install
      command in Settings. Connect-time server replacement uses existing
      reconnect/start/stop boundaries and the engine's existing busy predicate.
      CLI update code is implemented; signed update/remote qualification remains open.
- [x] Complete the one-time halving audit, synchronize docs and review the checkpoint.
      Completion: checkpoint additions reduced below 6,932; its full and native
      checks pass; remaining external qualification inputs are stated precisely.
- [ ] Qualify hosted artifacts and public installation when publication inputs
      and platform access are available. Completion requires actual artifacts and
      install/update execution; a workflow file alone does not establish this.

## Evidence and current gaps

The pre-simplification checkpoint `6d59a40` is rebased onto MCP main. Its managed
check passed typecheck, lint, formatting and 1,290 tests (36 skipped). Fresh
development CLI/server payloads passed an outside-checkout headless RPC/demo turn
and SQLite restart. Prior native and source SSH/WSL checks establish behavior of
the previous implementation, not the replacement being written now.

The deep audit removed the custom publisher/sealer, source/license inventory,
per-artifact receipt/use graph, redundant metadata and unused native command modes.
The development runtime wrapper was a scope mistake and is deleted. Source CLI,
Tauri development and tests use normal Node/npm; packaged builds and deployed
remote servers retain the shared runtime. CLI stdio uses its preparation lease
through child exit without acquiring a second redundant lease.

The simplified source path passes `npm run check -- --maxWorkers=2`: typecheck,
lint, formatting and **1,214 tests**, with 36 skipped. Two workers bound Windows
process contention; assertions and deadlines are unchanged. An earlier unrestricted
run had process/Docker timeouts whose exact timing cause remains unisolated.
Seven bootstrap/launcher Rust cases, nine packaged desktop headless cases and one
source desktop case pass. Three final independent reviews found the source-home
conflict and loader mismatch; both are resolved. Source native rebuilds require
stopping loaded source processes, avoiding another development cache mechanism.

The Windows development server payload builds through ordinary npm. A fresh
outside-checkout managed-server smoke passes native archive installation, RPC v4,
a demo turn, physical exit and SQLite history after restart. Its mutable build
output is deliberately broken before restart; the captured installed bytes work.
This qualifies the server payload, not release CLI installation or native UI.

Explicit cache cleanup passes the actual native launcher command regression:
running-consumer refusal, preview, removal across all four cache locations,
persistent-file preservation and repeat invocation. The Windows junction regression
passes without touching external data. Nine bootstrap/launcher cases pass; Unix
symlink behavior remains unqualified on this machine; the regular Windows/Ubuntu
CI now runs the headless Rust cases. This increment passes the full check:
typecheck, lint, formatting and **1,214 tests**, with 36 skipped. A Node 22 run
was stopped after a reproducible SQLite Node 24 ABI mismatch.
Node 24 then passed 1,212 tests but failed two OAuth cases. Rebuilding SQLite for
the documented Node 22 makes all 34 focused OAuth/code-mode integration tests pass;
the passing full check uses that consistent environment.

Desktop update installation verifies Tauri signatures including the signed version,
then joins the same shutdown boundary as normal window exit before Windows exits
into its installer. Linux/macOS request a restart after installation. Download or
installation failures remain visible; failure after closing connections explicitly
requires reopening the app. Development builds update by rebuilding. Native
installation and restart remain unqualified until actual artifacts are available.
This increment passes the full check (1,214 tests; 36 skipped), the headless browser
update flow, nine bootstrap/launcher cases, seven source and nine packaged desktop
Rust cases, a rebuilt development payload and a release-mode configuration check.
The packaged tests use the verified qualification cache; a first invocation pointed
at an incomplete scratch runtime. The independent shutdown re-review is resolved.

Windows CI for the cache increment (`1676986`, run `38085508682`) failed in the
development archive/helper test; Ubuntu passed. Preserved diagnostics in
`b4a52b4` (run `38086729395`) show "Harness directory has another owner".
The fixture created the runtime cache through ordinary recursive directory
creation instead of the bootstrap's account-owned boundary; elevated Windows
default ownership can differ from the account SID. The fixture now creates that
cache root through `canonical_home`, retaining the product ownership check.
Local headless execution passes; hosted correction evidence remains open.

The additional simplification removes Git commands, embedded source commits and
commit comparisons from payload builders, the native launcher and metadata assembly.
Versions, platform/Node requirements and signed archive checks remain. The workflow
already records the source commit in its tag and release notes.

Connect-time server upgrades pass the full local check: typecheck, lint, formatting
and **1,218 tests**, with 36 skipped. The actual two-version local owner regression
protects approval-held work, replaces an idle owner, preserves identity/history
and reuses the newer owner for an older client. The engine's existing busy predicate
also protects plugin-owned background work; idle shutdown closes admission before
acknowledgement. Nine native bootstrap/launcher cases and the production frontend
build pass. Three narrow independent reviews are resolved. The first full run
exposed a stale isolated-server test that expected idle upgrades to fail; it now
checks upgrade after stop and rejection of a downgrade. Signed cold downloads and
release-mode SSH/WSL upgrade execution remain unqualified.

The CLI update increment passes eleven headless bootstrap/launcher cases, including
replacement of a mapped Windows executable, and native compilation. Actual Windows
release CLI/server payloads build successfully. Three narrow independent reviews
are resolved; the documentation scopes version comparison and serialization to
the invoking CLI/shared home rather than promising installation-wide coordination
across independent homes. The combined signed-download/update remains unqualified.

The current full check passes typecheck, lint, formatting and 1,218 tests (36
skipped). Ten headless Ubuntu native cases pass, including Unix symlink and cache
pruning behavior. Fresh source payloads pass two WSL and three isolated SSH cases.
Actual Windows and Linux release CLI/server payloads build and report the product
version. The Windows NSIS installer builds, and the production native verifier
accepts its updater signature against the project public key. No installer is
executed or published. Sandbox temp-module rename and NSIS extraction failures
are resolved by rerunning the unchanged commands outside the sandbox.

Hosted Windows run `38087887143` subsequently failed the new release-selection
test's five-second deadline. The test acquired the same private lifecycle gate
five times, repeating Windows ACL subprocess setup; the similar source-selection
scenario already took nearly four seconds on that runner. The SemVer/platform
sequence now holds one real gate, preserving every assertion and the original
deadline. Its five focused cases pass. Hosted correction evidence remains open;
no product behavior changes. Actual installation/update execution on the user's
machine is prohibited, and local tests/builds are paused pending clarification.

No release has been
published. Anonymous cold download, real installer/update execution and macOS/Linux
native packaging remain unqualified. The public repository now hosts source and
future releases together. Its `harness-release` environment now contains
`TAURI_SIGNING_PRIVATE_KEY`, uploaded through `gh` file input without exposing it
in chat or committing it. No cross-repository publisher secret is needed.
Signing-key backup and hosted artifact execution remain
publication inputs. Their absence does not
justify rebuilding license collection or a custom publication service.

The single-repository simplification is pushed as `c6620cb`. Release workflow
run `38089290253` exercises its patch-bump/build/sign/draft path on GitHub; actual
publication and local installer/update execution remain excluded. Its results,
including macOS/Linux installer builds, must be recorded before qualification is
claimed. The earlier local installer predates the origin change and is not a
qualified artifact for the final download URLs.
The workflow's source gate passes all checks and 1,216 tests (38 skipped), then
creates version/tag `0.1.1` at `c9a9a4c`. The arm64 macOS payloads and desktop
compile, but requesting only `dmg` causes Tauri to omit the updater app archive.
The release command now requests `app,dmg` on macOS; hosted verification of this
correction remains pending. The first run's other platform results remain open.

The Linux release desktop also compiles, then AppImage packaging fails because
the bundle configuration omits PNG icons. The existing generated platform icons
are now explicitly listed in Tauri's bundle configuration. No new icon generation
or packaging tool is introduced. Hosted verification remains pending.

Windows/Ubuntu CI run `38089276939` passes at `c6620cb`, including the full source
check and headless native cases. The preceding Windows run `38089010793` passes
the corrected selection test but times out during background-test cleanup: its
phase diagnostics show startup took 23.4 seconds, all conversation/history
assertions completed by 29.6 seconds, then cleanup crossed the 30-second deadline.
The passing unchanged successor does not establish a product defect; assertions,
timeouts and retry policy remain unchanged.

Release run `38090212226` completes successfully at `485f19d`, tagged `v0.1.2`:
all four native CLI/server payloads and desktop installers build, including both
macOS updater archives. The draft job assembles the manifest/update feed and
verifies their artifact signatures through the production native verifier before
uploading 25 assets. This qualifies the minimal build/sign/draft workflow.
Windows/Ubuntu source and headless native CI also pass at `696c876` in run
`38090119791`. The local checkout is fast-forwarded to the workflow's version
commit; no local installer or update is executed.

The user initially retained the `v0.1.2` draft, then authorized publication on
October 11. It is now published in the same public repository. Anonymous reads of
the release manifest and latest updater feed succeed and list all four platforms.
Actual installer execution, released remote cold deployment and a two-release
update remain open. OS publisher signing/notarization is unavailable; the project
signatures protect downloaded payloads and updater artifacts without providing
an OS publisher identity. No additional release service is required.
No downloaded executable, installer or update has been run on the user's PC;
remaining install/update qualification must run on hosted machines.

The CLI installation follow-up uses direct curl/download commands, without adding
installer scripts. `v0.1.2` retains its signed manifest's original launcher assets;
four additional short asset names contain identical bytes, checked against that
manifest's hashes and sizes before upload. Future builds emit those short names
directly and sign their release-specific locations. Metadata assembly tests assert
the new launcher URLs. Source CI qualification of this naming change remains pending.

The user's Windows installer launch exposes a packaged-mode defect in `v0.1.2`:
Tauri 2 enables its dependency's custom protocol but does not enable the app's
same-named feature. The app therefore chooses source runtime preparation and tries
to spawn from the CI checkout directory, causing Windows error 267 on an installed
machine. Desktop runtime selection now follows Tauri's own `dev` cfg alias instead
of the app feature, across source development and packaged builds on every platform.
No extra build flag or guard is needed. Packaged preparation tests now use the
dependency feature that the Tauri CLI actually enables. The release script checks
the actual built executable's existing pre-window preparation mode before upload.
Hosted correction and a patched release remain open. No installed program is
launched on the user's PC.
Three narrow read-only reviews (correctness, simplicity, evidence) find no material
issue in the correction. Existing binary fingerprints corroborate the root cause:
the app had no own Cargo features while its Tauri dependency had custom protocol.
This is independent of Rust debug/release optimization.
