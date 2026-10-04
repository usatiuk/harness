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
