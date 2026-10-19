# Linux ARM64 support and minor release

Date: 2026-10-19. Status: Active.
Related delivery: [transcript reading follow-up](../interface/2026-10-19-transcript-reading-follow-up.md).

## Goal and authorized scope

The user reports the installed 0.8.1 remote-platform rejection and requests complete
Linux ARM64 glibc support, followed by a **minor**, not patch, release. Commit,
push, and publication through `gh` are authorized; do not restart or modify their
running installed server. The existing release workflow owns version increments.

Deliver the ARM64 target through the existing native build, runtime preparation,
release metadata, SSH/WSL selection, CLI/server and desktop AppImage/updater paths.
Do not merely admit an ARM host and then select or transfer x64 artifacts. Keep
unsupported architectures/libcs explicit. No new platform registry, deployment
manager, cross-compilation fiction, or unrelated remote-shell changes.

The user separately requests the literal subagent tool guidance: “Subagent
communication doesn't need to be human intelligible.” This is a tool-description
change, not a new messaging transport or behavior policy.

## Requirements and design gates

- Canonical target identity is `linux-arm64-glibc`, with Rust
  `aarch64-unknown-linux-gnu` and a verified Node 24.21.0 ARM64 archive.
- Native npm dependencies, N-API binding, bootstrap, server and CLI must actually
  be built and exercised on an ARM64 runner. Relabeling x64 artifacts is invalid.
- Include the native desktop AppImage and `linux-aarch64` updater descriptor.
  State the runner/glibc baseline honestly and preserve supported existing targets.
- Resolve remote platform before selection, warm-cache, source-payload or release
  decisions. Validate development payload target equality before any upload or
  warm-cache acceptance; preserve target-specific identity and cancellation.
- Preserve upgrades for existing clients. Shipped 0.8.1 Rust and JS validators
  reject an unknown key in `release.json.targets`; adding ARM there blindly
  breaks x64/Windows/macOS preparation/update. New-code schema edits do not fix
  shipped verifiers. Choose and test a minimal signed-metadata compatibility seam
  before publication, without weakening artifact/signature validation.
- The parent has preserved the pre-ARM native verifier at
  `.harness/077cfb09-721f-4efc-97bc-9466a60f36a2/old-native-compat/harness-native.node`
  for verification against the actual newly signed release metadata. No installed
  runtime is changed. Final evidence must distinguish this old-decoder check from
  new-parser unit tests and real ARM execution.

## Milestones and completion checks

### M1 — Consistent target and metadata contract

- [x] Verify official ARM64 Node archive URL, size, SHA-256, root and executable;
      qualify an available native GitHub ARM64 runner and glibc baseline.
- [x] Extend existing TS/Rust/native build target mappings and metadata schemas,
      preserving old manifests and rejecting wrong/missing target artifacts.
- [ ] Decide the signed-metadata compatibility seam for shipped clients and add
      an old-decoder/upgrade regression. Dependency: inspect both shipped validators.
      Check: old supported clients can validate the exact newly signed metadata
      they receive, while new ARM clients obtain the ARM target without ambiguity.

### M2 — Remote preparation and real target artifacts

- [x] Detect Linux ARM64 glibc through existing SSH/WSL probes; select correct
      release/Node/bootstrap/cache identities and reject a mismatched development
      payload before transfer. Dependency: M1 target contract.
- [x] Add representative public-boundary regressions for ARM, x64, unsupported
      platform/libc, cross-target cache/source rejection, and relevant cancellation.
      Substitute the OS/process edge only when native ARM execution is unavailable.
- [ ] Extend the existing release build/metadata/signing workflow for native ARM64
      server, CLI, launcher, desktop AppImage and updater assets. Dependency: M1.
      Check: actual hosted ARM build and native runtime checks pass; do not claim
      source compile or a fake architecture probe proves ARM execution.

### M3 — Integration, review and minor publication

- [x] Review all target consumers, compatibility, KISS/DRY/YAGNI and qualification
      evidence independently; resolve material findings before completion.
- [x] Run focused TS/Rust checks, full `npm run check`, production build/schema
      checks, and affected desktop/remote coverage on frozen integrated source.
      Synchronize owning subsystem and testing documents with actual support limits.
- [ ] Commit coherent validated changes and push main; dispatch existing release
      workflow with `bump=minor` through `gh` after remote preflight.
- [ ] Require successful native ARM artifacts/build checks and signed metadata
      validation, plus old-client compatibility verification, before publication.
      Publish with `gh`, verify public manifest/updater target identities and assets,
      and record exact source/run/release evidence here. Do not hand-bump versions.

## Investigation and evidence

- The reported rejection is an explicit x64-only guard in
  `packages/connections/src/remote.ts`; the same constant also drives selection,
  download and cache paths. Removing only the guard would be incorrect.
- Other current target gates include `release/node.json`, TS target/development
  metadata schemas, Rust manifest validation/host selection, build target mapping,
  remote source-build eligibility, release AppImage case, metadata assembly and CI.
- Shipped manifest root objects permit unknown fields, but their `targets` maps
  reject unknown target names. Accepted compatibility seam: the single signed
  wire manifest keeps legacy `targets` unchanged and carries an optional
  `linuxArm64Glibc` root descriptor. New TS/Rust decoders normalize that descriptor
  into the existing canonical target map, rejecting duplicate/ambiguous ARM
  entries. Signature validation and raw signed cache bytes are preserved. This
  avoids split URLs, extra manifests/signatures, update transport forks and
  platform registries; it is a narrow wire boundary, not duplicate runtime state.
  Producer serialization and old-client acceptance require explicit regressions.
- The actual published 0.8.1 Linux server archive is downloaded and authenticated
  against its signed manifest: 13,777,717 bytes, SHA-256
  `0e67ca4c08f190fda59852facd87a35bf62d2730dee9c33720bc6e48a97734f0`.
  Its extracted native verifier is preserved under the evidence directory's
  `old-native-compat/released/server/node_modules/@harness/native/` (SHA-256
  `35a7d2625b6795161c643914172e10b56c9f8d609d16647c01bafd964ea48c0e`).
  This will check the actual newly signed metadata, not just emulate old parsing.
- The official Node 24.21.0 Linux ARM64 tar.gz is downloaded and matched against
  official `SHASUMS256.txt`: 57,824,078 bytes, SHA-256
  `724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5`.
  Official GitHub runner documentation lists native `ubuntu-22.04-arm`; builds
  use that existing image rather than silently raising the glibc baseline to
  Ubuntu 24.04. Actual hosted execution still gates publication.
- Local x64 cannot establish native ARM execution. The existing hosted release
  pipeline must supply that evidence before a complete-support release is claimed.
- Target implementation is frozen: release TS tests **5/5**, full native Cargo
  tests **13/13**, full typecheck and scoped lint/format/shell checks pass.
  Connections tests pass **37** with **4** opt-in integration skips. Fourteen new
  process-boundary cases cover ARM/x64/WSL selection, target mismatch, missing
  release target/no fallback, libc errors and cancellation; their platform,
  bootstrap, signature and root-owner edges are explicitly substituted.
- Parent rebuilds the current root native binding and current x64 development
  payload (`act_604fd240`), then runs the existing isolated Docker/OpenSSH suite
  (`act_df048b6f`): **3 pass / 2 WSL-only skips**, including cold preparation,
  warm reuse, live-owner preservation and blocked-install cancellation. It uses
  only a tool-owned local container, loopback SSH port, temporary key/config/home,
  and cleanup; no saved user hosts or installed owners are contacted or changed.
- Independent correctness and architecture reviews approve target-specific
  preparation and the narrow signed wire extension. A misleading test comment
  about N-API serialization is corrected: N-API returns original signed bytes.
  Independent Node pin/checksum and old authentic-manifest verification pass.
  Exact newly signed ARM production manifest acceptance by the old published
  binding remains a publication gate, not proved by a different test signing key.
- Frozen integrated local validation passes **2,106 tests / 46 skips / 0 failures**
  with all type/lint/format stages (`act_6e7ac136`), native Cargo format and **13**
  tests, production Vite build and protocol regeneration with no drift
  (`act_abdf8b31`). Complete Chromium qualification after all desktop regressions
  passes **169/169**, retries disabled (`act_e8fe52e3`). The literal subagent
  description is present verbatim and its focused suite passes **22/22**.
  These local results do not substitute for hosted native ARM execution.
