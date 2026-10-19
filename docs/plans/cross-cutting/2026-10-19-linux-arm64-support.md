# Linux ARM64 support and minor release

Date: 2026-10-19. Status: Active; source implemented, publication pending.
Related delivery: [transcript reading follow-up](../interface/2026-10-19-transcript-reading-follow-up.md).

## Goal and authorized scope

Deliver Linux ARM64 glibc support through the existing native build, remote
preparation, CLI/server, desktop AppImage and updater pipeline, then publish a
**minor** release through `gh`. Commit/push/publication are authorized. The
standard workflow owns version increments; do not modify the user's installed
running server or saved remote hosts.

The user additionally authorized signing-key rotation after losing the previous
recovery copy and explicitly accepted that older installations require a manual
update. Their subsequent release hold covered recovery backup/verification;
Bitwarden backup and local-copy cleanup are now confirmed, and they instructed
continuation. No old-key fallback or verification bypass is permitted.

## Accepted design and invariants

- Canonical target: `linux-arm64-glibc`; Rust: `aarch64-unknown-linux-gnu`.
  Build actual native dependencies, N-API, bootstrap, CLI/server and desktop on
  `ubuntu-22.04-arm`, not relabeled x64 artifacts. Include `linux-aarch64` updater.
- Detect remote Linux x64/ARM64 GNU libc before artifact/cache decisions. Reject
  mismatched development payloads before upload or warm-cache acceptance. No x64
  fallback for missing ARM artifacts; unsupported architectures/libcs reject.
- One normal manifest `targets` map, accepting additional platform-name strings
  while fully validating **every** descriptor. Actual executable host/build/dev
  target enums remain strict. Empty/malformed inventories reject; original
  signed bytes are preserved through validation and cache writes.
- The initially implemented optional ARM root field/normalization is removed at
  the user's request. No split manifests, special ARM field, target registry,
  dual trust or speculative platform implementation remains.
- Rotate only the public repository trust root and the two existing GitHub
  Actions signing secrets. Private recovery values must never enter Git, model
  context or logs. Older published verifiers intentionally reject the new key.

## Milestones and completion checks

### M1 — Target contract and signing recovery

- [x] Verify official Node ARM64 archive and native GitHub runner availability.
- [x] Implement strict host/build/dev support and extensible manifest inventory;
      validate all future-target descriptors and retain raw signed bytes.
- [x] Remove superseded ARM wire extension and regenerate signed test fixture
      using an ephemeral dummy test key (not the production key).
- [x] Rotate production public trust root and repository Actions secrets; prove
      new-key acceptance, tamper rejection and old/new trust separation.
- [x] Confirm Bitwarden recovery backup; delete temporary recovery directory.
      Subsequently verify user-provided `test.txt` cryptographically against the
      compiled new verifier and public key, then delete it. Original-note exact
      byte equality cannot be asserted: no original note hash was retained.

### M2 — Native runtime and release artifacts

- [x] Implement ARM detection/selection/cache/cancellation and mismatch/no-fallback
      regressions at the existing public remote preparation boundary.
- [x] Extend source/release workflow, native payload, launcher, desktop AppImage
      and metadata paths. Native ARM source CI executes real build/OpenSSH checks.
- [ ] Requalify final new-key/open-map/Windows-fixture source on all three hosted
      source CI platforms. The initial run's Windows failures were test fixtures.
- [ ] Build actual native ARM release artifacts, AppImage and updater signatures
      with the existing release workflow. Source CI alone does not prove these.

### M3 — Integration and publication

- [x] Independent behavior, architecture/simplicity and evidence reviews; exact
      trust-root/open-map changes independently approved without private access.
- [x] Final local full check: **2,107 passed / 46 skipped / 0 failed**, including
      type/lint/format (`act_53a8de42`). UI unchanged since **169/169** Chromium.
- [x] Finish native format/tests (**14 unique tests**), production frontend build
      and schema generation with no drift (`act_4b74ad0b`).
- [x] Finish independent final documentation/evidence review (no material findings).
- [ ] Commit/push frozen cleanup and record fresh hosted results.
- [ ] After fresh source CI succeeds, dispatch `release.yml` with `bump=minor`.
- [ ] Require all four native release builds and validate draft's actual signed
      manifest with new-key positive/tamper/old-key-negative checks. Check ordinary
      four-target map, `linux-aarch64` updater and all expected assets.
- [ ] Publish through `gh`, verify public metadata/assets, synchronize the generated
      version commit and record exact release/run/commit evidence. Finish clean.

## Evidence and limitations

- Official Node 24.21.0 ARM64 tar.gz matches official `SHASUMS256.txt`:
  57,824,078 bytes, SHA-256
  `724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5`.
  Extracted ELF is AArch64. Native runner uses Ubuntu 22.04 glibc baseline.
- Actual published 0.8.1 server archive was authenticated against its old signed
  manifest before extraction. Its binding SHA-256 is
  `35a7d2625b6795161c643914172e10b56c9f8d609d16647c01bafd964ea48c0e`.
  It accepts the authentic old manifest, rejects the new key; the new binding
  accepts a new-key challenge, rejects tampering and rejects the old manifest.
  All **5/5** checks were independently re-executed by both trust reviewers.
  Public evidence: `.harness/077cfb09-721f-4efc-97bc-9466a60f36a2/signing-rotation-proof/`.
- New public-key file SHA-256:
  `62fc92c9d79859e1243438d8737c27fa7773f6fac20b002f557b6b3028af555a`.
  Actions key/password replacement metadata: 2026-10-19 21:01:29Z/21:01:30Z.
  Recovery-note validation signs a fresh challenge, verifies using the compiled
  binding, rejects tampering and matches this public identity (`act_7345e1aa`).
  Neither it nor any private/password value was emitted or committed.
- Source implementation/core fixes are committed in `5280625` and `2d8a04f`,
  pushed to main. Run `39321165700` passes Linux x64 and native ARM64, including
  real Docker/OpenSSH; Windows fails canonical-path and isolated-home fixtures.
  Corrected fixtures use `realpath` and Windows `USERPROFILE`, asserting actual
  `homedir()` before and after initialization. Production behavior is unchanged;
  hosted Windows qualification remains required, not replaced by local Linux.
- Parent x64 binding/payload rebuild (`act_604fd240`) and isolated real OpenSSH
  (`act_df048b6f`): **3 passed / 2 WSL-only skips**, including cold prepare, warm
  reuse, live-owner preservation and blocked-install cancellation. Only a tool-
  owned Docker container, loopback SSH and temporary key/config/home are used.
- Focused release/remote tests pass **20**, updated Rust metadata suite **14**
  in author validation and final parent execution (`act_4b74ad0b`).
  Fourteen remote process-boundary cases substitute architecture/bootstrap/
  signature/owner edges; they are not native ARM execution claims.
- Full Chromium after removal of rejected Working-group failure classification:
  **169/169**, retries disabled (`act_9dbd7ef0`). Earlier full local checks passed
  **2,106 / 46 skips**; the final open-inventory regression adds one test.
- Unchanged upstream Rust `glib` 0.18.5 medium advisory is recorded in
  [deferred work](../../DEFERRED.md); no unrelated GTK migration or callsite audit
  is claimed. Installed services and user hosts remain untouched.
