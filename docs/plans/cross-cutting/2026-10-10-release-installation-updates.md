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

Each account/home has one background server, shared by CLI and desktop. The saved
server selection is independent of the installed client's version. Clients inspect
the management/protocol versions before attaching and explain incompatibility.
Updates explicitly stop and replace the server; recovering in-flight work is outside
scope. Persistent conversations and settings survive uninstall and updates.

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

A manual GitHub workflow accepts a patch/minor/major bump, commits the new version,
builds the platform artifacts, signs them, and creates a draft release. Standard
Cargo, npm, Tauri and `gh` commands own these operations. `release/` contains only
the necessary Node pin, public key, test fixture and generated build output.
The exact GNU GPLv3 text stays in `LICENSE`; license collection/export tooling is
explicitly outside this work. OS publisher signing is unavailable. The project key
protects downloads and Tauri updates; its private half is never committed.

## Constraints and size gate

- Preserve the MCP delivery on remote main (`97eea03`) and unrelated changes.
- Measure gross added code against that base, including tests and workflows:
  `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.rs`, `.ps1`, `.sh`, `.yml`, `.yaml`.
- Frozen baseline `6d59a40`: **13,864 added lines**. Final maximum: **6,932**,
  at least a 50% reduction. Moving unchanged tooling or compressing formatting
  does not satisfy the requirement. This is a ceiling, not a target.
  The audited implementation is **6,374 added lines**, a **54.0% reduction**,
  measured from the complete staged tree, including tests and workflows.
- No custom release publisher, source/vendor inventory, artifact-sealing layer,
  symbol-version parser, automatic pruning or pre-release migration framework.
- No GUI/native visible tests without approval for that run. Headless tests are
  allowed. Keep Windows child commands hidden.
- Coherent validated commits and periodic direct pushes to main are authorized.
  Publishing a release or uploading secrets is not yet authorized.

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
Tauri's package version must match. Build identity captures the source commit,
target and Node pin. The signed release manifest declares component locations,
sizes and hashes. Protocol compatibility is checked by the actual server handshake,
not duplicated in download metadata.

## Delivery checklist

- [ ] Simplify the release pipeline and remove license/source inventory machinery.
      Completion: minimal workflow validates; actual payloads build; no stale callers.
- [x] Replace per-artifact lifetime/retention machinery with one cache-use lock.
      Depends on the payload contract. Completion: running consumers prevent removal,
      cancellation joins helpers, source rebuilds retain the previous owner safely.
- [ ] Validate shared local owner and SSH/WSL bootstrap flows.
      Depends on runtime simplification. Completion: headless CLI/server smoke,
      socket/pipe and available source-remote regressions pass.
- [ ] Complete explicit server/client updates and cache pruning.
      Depends on the simpler runtime boundary. Completion: supported upgrade status,
      stop/install/start and safe explicit cleanup work without an installed-client
      registry or unattended deletion. Do not add a new cleanup subsystem meanwhile.
- [x] Meet the size gate, synchronize docs, complete independent review and checks.
      Completion: gross additions <=6,932; `npm run check` and affected native checks
      pass; remaining external qualification inputs are stated precisely.
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

No release has been
published. Anonymous cold download, real installer/update execution and macOS/Linux
native packaging remain unqualified. The public artifact repository/token, signing
key backup and platform access remain publication inputs. Their absence does not
justify rebuilding license collection or a custom publication service.
