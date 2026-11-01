# Consistent tool path handling

Status: Complete — source validated; parallelism limitations recorded below

## Goal

One rule for every model-facing `path`: it resolves against the workspace root. Previously `glob`'s
`path` was a raw pattern prefix, so an absolute path silently returned `no matches`, while
`read_file`/`write`/`edit`/`apply_patch` resolve absolute paths against the root
(`packages/execution/src/local.ts` `#resolve`).

## Original behavior (evidence)

- `packages/workspace/src/tools.ts` `scopedPattern` concatenates `path`/`pattern` with no
  resolution; `GlobTool.execute` maps zero hits to `"no matches"`.
- `packages/execution/src/local.ts` `classify` labels out-of-workspace calls for approval; docker
  `#cpath` (`packages/sandbox/src/docker.ts`) maps inside-workspace absolute paths into the
  container.
- Verified live: `minimatch("packages/core/package.json", "D:\\projects\\harness/packages/*/package.json")`
  is `false`, and `\` is an escape character in minimatch patterns.

## Approach

- Add `resolveScope(root, path)` to `packages/execution/src/glob.ts` (the shared glob substrate):
  returns the workspace-relative POSIX dir for the scope; an absolute path inside the workspace
  maps in; anything resolving outside is an error. Backslashes are separators on Windows hosts; a
  drive-letter path on a non-Windows host is an error.
- `GlobTool.execute` resolves `path` through it and returns an error result instead of
  `"no matches"`; the `glob` description states the contract.
- A scope is a literal directory, while only `pattern` is glob syntax. Move the existing
  `scopedPattern` helper into the execution glob substrate so its existing minimatch dependency
  owns escaping (including braces, leading comment/negation markers and POSIX backslashes).
  Keep matching and pruning on the same combined pattern.
- Use native `node:path.resolve` for normalization rather than duplicate string cleanup.
  Containment is lexical, not a new symlink-isolation guarantee.
- Non-goals: read/write/edit/apply_patch behavior unchanged (approval-gated on local, mapped on
  docker); the projectless `list` throw stays; no changes to `classify`/`targets`.

## Milestones and tasks

- [x] Implement `resolveScope`; verify relative/absolute/root/outside/sibling-prefix behavior
      in `packages/execution/src/glob.test.ts`.
- [x] Wire `GlobTool` and its description; verify real local listing, literal scope names,
      outside errors and successful empty results in `packages/workspace/src/tools.test.ts`.
- [x] Synchronize execution architecture, root status and testing guidance.
- [x] Run final focused/full Vitest, changed-file formatting and `npm run check`; record actual
      results and any environment limitations below.
- [x] Resolve independent correctness, simplicity and evidence review findings.
- [x] Restore the compatible local native dependency environment with user-authorized clean
      `npm ci`; verify a real in-memory SQLite open on Node 26.
- [x] Establish final full-suite evidence: all tests pass with two workers and source-test
      launch environment; retain default-command limitations rather than claiming those fixed.

## Review decisions

- Fix the demonstrated literal-scope bug: raw interpolation made `foo[1]` match `foo1`
  instead of the real directory. Installed minimatch's existing `escape` API handles wildcard
  syntax; braces require `magicalBraces: true`, and leading `!`/`#` require explicit escaping.
- Reject broadening POSIX drive-prefix rejection to `C:` without a separator: this is a valid
  POSIX relative filename and no demonstrated requirement needs a change.
- Do not extract a common containment abstraction across file approval, Docker mapping and
  glob scope errors. Those ownership/failure contracts are different; sharing this small
  predicate would expand the change without removing a demonstrated defect.
- An initial new test wrongly expected literal backslashes on Windows. Installed minimatch
  normalizes candidate backslashes to separators there, matching Windows filesystem semantics.
  Replace that invalid cross-platform premise with a real POSIX-only filesystem test.
- Remove the stale implementation comment left at `GlobTool` after moving its helper.

## Validation evidence

- Windows, Node 26.13.0: focused final tests pass **52 tests, 1 POSIX-only skip**.
- Initial `npm run check` passed typecheck and lint but stopped at Prettier: existing ignored
  `.harness/jobs.json` is unformatted and `.harness/runs{,-green,-old,100}.json` contains UTF-16
  output, which Prettier reads as invalid JSON. These unrelated local artifacts were preserved;
  the initial workaround excluded them only at the command line.
- A subsequent `npm run check` passed typechecking, then stopped at **54 ESLint errors** in the
  unrelated untracked `.tmp-db-inspect/*.mjs` scripts. Source lint passed with that directory
  excluded. This work did not modify those scripts; they were no longer present at the final run.
- First full `npx vitest run`: **1,988 passed, 132 failed, 91 skipped**, 1 unhandled error; 162 files
  pass, 26 fail, 17 skip. Many failures expose the existing `better-sqlite3` binary's ABI
  mismatch: compiled for ABI **137**, while Node 26.13.0 requires **147**. A direct in-memory
  database open reproduced it independently of the changed code.
- The user authorized removing `node_modules` and reinstalling after the Node upgrade. Clean
  `npm ci` passes (lockfile unchanged), and an in-memory SQLite open succeeds on Node 26.
  npm reports 22 audit findings (2 low, 18 moderate, 2 high); no dependency upgrades or
  audit fixes are included in this scoped change.
- After reinstalling, `npm run check` passes typecheck and lint, then stops on the same
  generated `.harness` formatting artifacts. A first post-install suite runs **2,086 passed,
  34 failed, 91 skipped**, with 1 unhandled error. Source inspection traces the remaining
  server-selection failures to inherited `HARNESS_SERVER_SELECTION` / `HARNESS_PREPARED_SERVER`
  launch environment, not the glob change. Clear only those variables in the test subprocess.
- Initial Git cases separately timed out at 5 seconds, with EBUSY cleanup failures. With clean
  launch environment but default parallelism, **2,112 passed, 8 failed, 91 skipped**: five
  background-release and three worktree-change timeouts. These unchanged suites pass with bounded
  concurrency; this supports contention as a contributing factor, not a proven root-cause fix.
  No product code, timeout, retry or assertion changes were made for these failures.
- Changed-file Prettier and `git diff --check` pass.
- Affected packages pass **94 tests, 13 skips** across execution/workspace.
- All three independent review lenses resolve with no blockers: correctness (including final
  re-review), simplicity/boundaries, and tests/evidence/scope.
- Isolated diagnostics for worktree changes, connection startup diagnostics and server app API
  pass **25 tests, 2 skips** after clearing the launch-only environment.
- Final full suite, clearing only `HARNESS_SERVER_SELECTION` and `HARNESS_PREPARED_SERVER`
  in the test shell: `npx vitest run --maxWorkers=2` passes **2,120 tests, 91 skips** across
  **188 passing files, 17 skipped files**, with no unhandled errors. Host reports 16 available
  processors; the worker limit changes only test execution concurrency.
- Before the formatting follow-up, `npm run check` passed typecheck and lint but stopped at generated `.harness`
  JSON formatting. `npx prettier --check . "!.harness/**"` passes the source tree without
  mutating those artifacts or repository formatting policy.
- At the user's request, add `.harness` to `.prettierignore`, alongside `.harness-dev`.
  Runtime output is not authored source; this removes the generated-file formatting blocker
  without modifying the artifacts. Integrated `npm run check -- --maxWorkers=2` passes
  typecheck, lint, default `prettier --check .`, and **2,120 tests, 91 skips**, with the two
  launch-only environment variables cleared. Evidence: `D:\temp\paths-commit-check.txt`.
- Logs: `D:\temp\paths-npm-ci.txt`, `D:\temp\paths-reinstalled-check.txt`,
  `D:\temp\paths-clean-env-tests.txt`, `D:\temp\paths-bounded-tests.txt`,
  `D:\temp\paths-final-format.txt`.
- Commit is authorized; no push or release was requested.
- Existing Docker substrate tests ran and passed in the full suite; this does not establish the
  new `GlobTool` scope cases on Docker. SSH, WSL and POSIX filesystem execution of those cases
  remain unqualified by this Windows run.
