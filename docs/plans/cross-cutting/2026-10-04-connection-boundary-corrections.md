# Connection boundary corrections

Date: 2026-10-04. Status: Complete.

## Outcome

Correct the concrete architecture audit findings in the existing Local/WSL/SSH
design. Keep server-owned work, approvals, independent observers and the simple
account-server model. This follows the completed
[remote delivery](2026-10-03-remote-hosts-background-servers.md); it adds no product
features, profiles, compatibility paths or universal client controller.

## Milestones and dependent tasks

- [x] **1. Connection authority and physical lifetime.**
  - Reconcile every adopted registry against existing and pending connections.
    Changed execution routes detach before replacement; removed entries detach;
    label/runtime-source edits preserve a valid current observer and drafts.
  - Make desktop transport close/failure release its native bridge exactly once,
    including errors before the native connection identifier arrives. Manager
    teardown awaits that same close operation; discarded frames receive no credit.
  - Completion: public client/manager regressions cover another client's route
    edit, removed entries, metadata edits, pending connection replacement and
    normal/protocol/write/ack transport closure. A rebuilt native check qualifies
    actual bridge detachment while the server remains independent.
- [x] **2. Cancellation, failed ownership and diagnostics.** Depends on 1.
  - Propagate Local startup cancellation through readiness and contention waits,
    including bridge EOF before readiness. An already launched owner remains
    independent; cancellation prevents subsequent launch attempts.
  - Remove failed initial ownership records only when no runtime, registered
    child or concurrent operation still needs them.
  - Preserve RPC method and safe error classification without logging request
    contents, credentials or arbitrary provider exception messages.
  - Completion: actual process/public RPC regressions establish prompt Local
    cancellation, retained server ownership, clean failed attachment bookkeeping,
    concurrent attachment safety and useful redacted diagnostics.
- [x] **3. Narrow contracts and remove client/server coupling.** Depends on 2.
  - Keep TUI session UI/helpers separate from launch entrypoints; remove server
    implementation re-exports from client modules and the launcher/screen cycle.
  - Derive provisioning types from their contract; type command results at the
    boundary and encode Local/remote prerequisites in request shapes.
  - Remove obsolete Rust interpretation of SQLite contention diagnostics. Keep
    policy and classification in the common Node layer.
  - Completion: types, affected tests, runtime module graph and browser build
    verify the boundaries. No new generic orchestration framework.
- [x] **4. Validation, independent review and handoff.** Depends on 1–3.
  - Run affected tests and npm run check; rerun actual native/remote qualification
    where lifecycle or launch changes require it.
  - Obtain three read-only reviews for authority/correctness, lifetime/failures,
    and layering/simplicity/evidence. Resolve actionable findings.
  - Reconcile root/interface/testing docs with actual evidence. Commit validated
    increments: two work commits followed by the tied cleanup increment.

## Evidence and remaining work

Audit is read-only at d656c76. Confirmed issues are stale route/session authority
after shared registry adoption, desktop logical closure without native closure,
uncancellable Local readiness, failed initial root bookkeeping, dropped RPC
diagnostic context, and server composition imports/cycles in TUI client modules.
Milestone 1: 14 focused tests pass across desktop registry/transport and TUI route
authority. Real RPC peers cover shared-registry replacement, removal, metadata
retention and cancelled pending attachment. Native edge tests cover all closure
paths, early native admission and failed physical detach. Rebuilt Windows native
application: 3 connection/exit tests pass (32.3s), establishing actual detachment,
independent owner survival, shared-owner exit and pre-initialization bridge closure.
The first native invocation found no tests due to npm argument escaping; direct
Playwright invocation passed. Type/lint checks accompany the increment.

Milestone 2: 116 tests pass across actual Local startup/background processes,
engine, RPC session and TUI scenarios; all three server app API tests pass. New
process gates qualify cancellation before readiness for both direct Local callers
and a bridge's EOF, while the captured already launched owner later becomes ready.
Failed first loads cannot become parents; registered children retain their root.
Public RPC failures leave no shutdown ownership, while existing concurrent
attachment/preparation coverage passes. Composition diagnostics include the method
and fixed error class and exclude injected private exception content and names.
TypeScript and targeted ESLint pass.

Milestone 3: typed Local/remote prerequisites, schema-derived provisioning and
command results, separate TUI screen/session/launch modules, and a neutral JSON
file helper remove the reported leaks and duplicates. Sandbox configuration now
has one Node-independent source; approval/sandbox presentation imports use their
existing client subpaths. Esbuild's workspace graph contains 91 modules, no runtime
cycles and no server composition or execution implementation imports. Focused
cleanup checks pass 32 tests, and review-driven manager/sandbox/TUI checks pass 20.
TypeScript and ESLint pass; the desktop browser/native build succeeds.

Three independent read-only reviews found additional queued-admission,
already-draining native closure and captured stop-resource races, plus two client
barrel import leaks. These are fixed within existing owners/contracts. New paired
manager tests cover queued connect/upload cancellation and replacement survival;
the deterministic Rust regression passes and gates shutdown on actual shared
bridge completion. All three review follow-ups report no remaining actionable
findings. No implementation delegation was used.

Final evidence: npm run check passes TypeScript, ESLint, Prettier and 998 tests
(116 passing files, 9 skipped files, 36 skipped tests; 58.31s Vitest execution).
Rebuilt Windows native application: all five connection/exit/actual WSL tests
pass (1.5m). Actual Ubuntu WSL and isolated Docker/OpenSSH plus rendered TUI:
five tests across two files pass (60.42s). Rust's deterministic shared-drainage
regression passes. Esbuild's 91-module TUI workspace graph is cycle-free and
contains no server composition or agent execution implementation imports.
No platform claim is inferred from substituted adapter tests. No required scoped
behavior remains open. The two work increments are 97f0e98 and 1f00a2b; the tied
third increment removes module/type/config duplication and incorporates the
review-driven ownership corrections.

Validation observation: the first full check passed 993 tests but one stdio test's
temporary directory removal failed with Windows EBUSY. Its focused rerun passes.
No remaining fixture descendants were found when subsequently inspected. The
specific transient lock owner/cause is unknown; no retries, timeout changes or
product fix are claimed. Subsequent checks first caught a typed cancellation-error
lint issue and newly extracted files needing formatting; those are corrected.

Earlier unreproduced validation
observations stay in the preceding delivery plan; do not claim these corrections
explain failures without a matching reproduction.

## Post-delivery isolated desktop startup

The user's normal-home desktop development launch failed because Node could not
resolve `bindings` from cached `better-sqlite3`. The copied packages were present,
but their real parent was `dependencies-<key>`, rather than `node_modules`. Node
follows the code junction and does not search that parent for sibling packages.
Native fixtures beneath the checkout silently resolved repository dependencies,
so their passing results did not establish isolated cache correctness.

A new actual SQLite process regression reproduced the same missing-module error
before the correction. Dependencies now occupy a real `node_modules` directory
beneath their immutable cache root, with the layout included in cache identity.
No running files are changed or old cache migrated. The regression passes after
deleting the source payload. A rebuilt native GUI with a temporary home/cwd
outside the checkout also starts, stops, and starts a second owner from the same
build (12.9s). This qualifies isolated cache/native startup, not standalone release
distribution: debug resources remain checkout-owned.

The desktop now preserves the first native startup failure through a later
readiness expiry or failed physical detach, instead of displaying the generic
pending-RPC disposal error. Review caught both diagnostic precedence interleavings;
the gated real-RPC/controlled-native regression covers them. Its first invocation
incorrectly disposed the remote fixture peer rather than the failing client peer,
which did not reject the client's pending request. The corrected fixture models
the actual adapter closure; no timeout or assertion was weakened.

Merge CI on db76a69 passes Ubuntu but fails Windows: two `findProjectRoot`
assertions returning the runner's short-path home also failed on preceding main
0282afc; the copied-discovery test instead reports a directory-owner rejection.
These results are separate from the cache reproduction and remain open. Do not
claim the cache correction resolves them.

Final focused correction evidence: npm run check passes TypeScript, ESLint,
Prettier and 1000 tests (116 passing files, 36 skips; 54.85s Vitest). Three
independent read-only reviewers and follow-ups have no remaining actionable
finding. The isolated native cache case passed twice, including cache reuse.
The six-case native run passed five cases but one existing Local editing case
hit EPERM renaming staged dependencies. That exact case's focused rerun passed
unchanged (10.1s). The transient filesystem lock/cause is unknown; no assertion,
timeout or retry policy was changed and no fix is claimed for that observation.

## Windows CI and requested exit-default follow-up

- [x] Reproduce lexical/physical path mismatch through an actual account alias.
      Canonicalize project discovery and the asynchronous global-root decision;
      all read/write consumers await that decision. Preserve boundaries when
      `.harness` itself is an alias and verify repository-local file contents.
- [x] Establish the copied-discovery target's owner-private runtime directory
      before copying. Keep its foreign-home rejection and source-owner assertions;
      directory-owner validation remains unchanged in production.
- [ ] Verify both GitHub CI platforms after local validation and commit.
- [ ] Default new client configuration to stopping unobserved Local on desktop
      exit, retaining the explicit keep-running preference and shared-owner check.
- [ ] Finish the authorized two-work/cleanup cadence and clean handoff.

The physical account-alias test failed against the previous resolver, returning
the account alias instead of the actual repository. Review identified an
introduced leaf-home alias regression; physical marker comparisons and the
requested home's physical parent now preserve the existing account boundary.
Public writer/read tests cover missing settings directories and aliased homes.
The copied-discovery setup fixes its earlier prerequisite rather than weakening
the ownership check or expected foreign-home rejection. GitHub validation remains
necessary for the actual elevated Windows runner; local checks are separate evidence.

The CI correction's final local check passes TypeScript, ESLint, Prettier and
1003 tests (116 passing files, 36 skips; 45.92s Vitest). All three independent
read-only review follow-ups have no remaining actionable findings. The prior
desktop startup correction is committed as e303dbe. GitHub validation and the
requested exit-default correction remain open below this delivery increment.
