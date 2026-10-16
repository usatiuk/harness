# CI and local test recovery

Status: Active

## Outcome

Restore the ordinary Linux/Windows CI checks and local `npm run check` by fixing
established product defects and invalid fixtures. Preserve actual platform
contracts, security checks and timing bounds; do not skip failures or add retries.

## Evidence and approach

The last green CI run is [38470623876](https://github.com/usatiuk/harness/actions/runs/38470623876).
The first failing run [38478103340](https://github.com/usatiuk/harness/actions/runs/38478103340)
incorrectly expects a Bash tool on Windows. Latest run
[38965775246](https://github.com/usatiuk/harness/actions/runs/38965775246)
passes Ubuntu and fails 14 Windows tests across nine files: shell selection,
physical path aliases, container path mapping, output path separators and home
ownership validation. The current Linux checkout also reproducibly fails the TUI
OAuth fixture before its initial conversation becomes active. Earlier macOS
failures are recorded in `docs/DEFERRED.md`; inspect shared causes, but do not
claim native macOS or Windows qualification from Linux execution.

Prefer canonical temporary fixture roots where production intentionally uses
physical paths. Fix production boundaries only where actual supported inputs
violate their contract. Substitute environmental edges at fixture boundaries and
wait for the actual UI/process prerequisite rather than increasing timeouts.

## Milestones and tasks

- [x] Establish failing hosted runs and current local baseline.
      Completion: inspect first/latest CI logs and reproduce local TUI failure.
- [x] Repair platform fixture assumptions and any demonstrated product defects.
      Depends on baseline. Completion: each failure has a root-cause explanation
      and focused regression evidence; inspect affected public contracts.
- [x] Repair local TUI OAuth startup and assess recorded runtime/QuickJS failures.
      Depends on baseline. Completion: original failing tests pass under the
      intended contract, or required unresolved behavior remains explicitly open.
- [ ] Review and verify the complete change.
      Depends on repairs. Completion: three independent read-only reviews,
      `npm run check`, relevant native Rust checks and Windows hosted CI when
      authorized/available. Record precise platform limits and unresolved causes.
- [ ] Synchronize testing/subsystem status and handoff.
      Depends on validation. Completion: durable docs contain final evidence and
      remaining qualification limits, with no stale deferred claims for fixes.

## Validation record

Before changes, the current Linux full check reports 1,434 passing tests, 41 skips
and one TUI OAuth failure at `hosts.test.tsx:314`; the same failure reproduces in
isolation. Typecheck, lint and formatting pass. Initial evidence captured before recovery implementation.

## Established causes and repairs

- The code-only discovery assertion now selects PowerShell on Windows and Bash
  elsewhere, matching the existing public tool contract.
- Canonicalize temporary workspace roots before deriving Docker mock mappings,
  Git paths and expected persisted workspace identities. Production already
  canonicalizes those paths; Windows 8.3 and macOS `/var` aliases broke fixtures.
- Create the diagnostics fixture home through `canonicalHome`, preserving the
  current-account Windows owner requirement instead of accepting an elevated
  temporary directory owned by Administrators. Windows logs show owner rejection
  before the intended child startup; native Windows verification remains pending.
- Output assertions use native separators and now read the complete spilled file.
- The OAuth fixture substitutes `HOME` for credential isolation but used the real
  checkout workspace. A direct reproduction exposed global account settings
  being parsed as project settings after that substitution. Use a marked fixture
  workspace and await the actual conversation UI before sending sign-in keys.
- The runtime consumer fixture retains the captured executable in place, matching
  production. Copying a Homebrew Node executable alone breaks its relative dynamic
  library linkage; native preparation does not perform that relocation.
- QuickJS processed one microtask per event-loop turn, excluding scheduling delays
  from its computation budget. Using the library's bounded `executePendingJobs`
  API with 256 jobs per turn amortizes scheduling while preserving the CPU budget
  and host-message yielding. In a temporary diagnostic worker substituting a
  one-millisecond scheduler delay, the same 20 ms guest budget took 3,437 ms with
  single-job turns and 139 ms with 256-job batches; both produced the same
  computation-limit error. No product test controls or timeout increases added.
  API contract: [upstream runtime documentation](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md#executependingjobs).

After repairs, 70 focused tests across ten fixture files pass; all five TUI host
tests and 20 evaluator tests pass. The CI native Rust command passes 11 tests.
Full local `npm run check` passes with ordinary temporary-directory defaults:
1,436 tests passed, 41 skipped; typecheck, lint and formatting pass. Three
independent read-only reviews report no remaining blocking findings after removal
of an ineffective Git-ceiling fixture setting. Windows hosted execution and an
actual macOS rerun have not yet been established.
