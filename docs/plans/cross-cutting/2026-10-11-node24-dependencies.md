# Node 24 and dependency refresh

Status: Active

Use Node 24.21.0 consistently for source development, CI and managed release
runtime downloads. Refresh dependencies only through simple compatible bumps;
skip changes requiring product refactors or speculative overrides.

The source pin drives CI. Release payload building also requires the exact version
in `release/node.json`; its archive sizes and SHA-256 values come from official
Node distribution metadata. Signed historical release fixtures remain unchanged.

## Completion checks

- [x] Align `.nvmrc`, managed archive metadata, bundler target and setup docs.
      Check official archive metadata and source/release version agreement.
- [x] Refresh compatible dependency versions and audit fixes. Record audit before
      and after, plus anything skipped because it needs more than a simple bump.
- [x] Run `npm run check` and relevant packaging/native checks where local
      prerequisites permit. Record actual results and blocked validation.
- [ ] Review the diff, synchronize durable status, commit and push to main as
      authorized by the user.

## Evidence

Local nvm already has Node 24.21.0. Rust/Cargo are absent from PATH initially.
Linux, Windows and macOS native behavior requires platform validation; local
source checks alone do not establish those behaviors.

The compatible lockfile refresh changes 236 resolved versions within existing
manifest ranges. `npm audit` drops from 18 findings (one critical, nine high,
six moderate, two low) to zero. No overrides, forced fixes or new manifest
major-version ranges were added. Prettier 3.9.10 is included with its mechanical
formatting changes, explicitly authorized by the user. Newer incompatible keyring,
SQLite, router, devcontainers and agents releases are outside this refresh.

Zod stays at the original locked 4.4.3. The first refreshed run passes 1,255 tests
and skips 38, but fails the MCP invalid-settings assertion. A focused run against
the original lockfile passes both MCP RPC tests. This is a real client-validation
regression introduced by the Zod 4.6.5 bump, not a faulty assertion: the MCP wire
preprocessor forwards `unrecognized_keys` issues and returns `z.NEVER`, but the
new pipe handling continues into the downstream JSON union. The typed client then
sends invalid configuration, and only the server rejects it. The [upstream pipe
implementation](https://raw.githubusercontent.com/colinhacks/zod/v4.6.5/packages/zod/src/v4/core/schemas.ts)
explicitly continues pipes when all issues are `unrecognized_keys`. Preserve the
existing client validation and tests by skipping this bump; revisit it before a
future Zod update. This does not change the public protocol or server behavior.

All four Node archive sizes and hashes match official distribution metadata at
<https://nodejs.org/dist/v24.21.0/SHASUMS256.txt>. Three read-only independent
reviews found no actionable correctness, architecture/simplicity or scope issues.

The user installed Rust 1.99.0. Authorized repo-local `npm ci` passes under Node
24.21.0; native modules are freshly built for that version. No system packages
or toolchains were installed during this resumed work.

Final validation under Node 24.21.0 on Ubuntu passes:

- `npm run check -- --maxWorkers=2`: typecheck, lint, formatting, 1,256 tests
  passed and 38 skipped. No assertions, timeouts or product behavior were changed.
- Ten headless Rust cases via `cargo test --manifest-path native/Cargo.toml --locked`.
- Source CLI `npm run dev -- --help`.
- Final `npm run prepare:remote`, whose server and deployment identities report
  Node 24.21.0, and `npm run build --workspace @harness/desktop`.
- Final repo-local dependency installation reports zero audit vulnerabilities.

These results do not establish other-platform native desktop UI, signed release
installation/updates or live-provider acceptance. Source/runtime pins and compatible
bumps are delivered; the incompatible Zod update is intentionally excluded.
