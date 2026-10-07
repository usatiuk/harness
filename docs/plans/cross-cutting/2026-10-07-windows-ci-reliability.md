# Windows CI reliability

Status: Active

## Goal and scope

Investigate and fix the Windows CI failures observed after direct desktop delivery
`f43afcd`, then qualify and ship the corrections directly to `main`, without a PR.
The user authorized this follow-up on 2026-10-07. Preserve execution, cancellation,
ownership, credentials and accounting contracts. Do not weaken assertions, change
budgets without causal evidence, add speculative retries or rerun repeatedly merely
to obtain green CI. Production deadlines and overall test deadlines stay unchanged.

## Evidence and decisions

The [initial push run](https://github.com/usatiuk/harness/actions/runs/37541418215)
passes Ubuntu. Windows attempt 1 fails evaluator resource bounds and code-mode
background waiting at 5-second test budgets, plus discovery replacement with
`EPERM`. Attempt 2 passes those cases but fails CLI OAuth navigation (OpenCode Go
selected instead of Codex) and a combined server ownership case at 20 seconds.
Those packages are unchanged from `b529e87`; all 48 tests in the first three files
pass locally unchanged. No cause or fix follows merely from a passing rerun.

An independent actual Windows filesystem experiment reproduces the publication
mechanism: an ordinary Node read handle on the old destination blocks replacement
rename, but unlinking the stale name and publishing to the absent path succeeds
while that reader remains open. The old handle retains old content. Retire stale
discovery only from the server after exclusive SQLite ownership, immediately
before publication. Keep generic JSON replacement atomic and clients read-only.
The exact handle responsible in CI was not captured.

The evaluator case serializes four independent Worker/QuickJS invocations within
one test budget; attempt 2 takes 4,247ms. On verified CI Node 22.23.3, constrained
to one CPU, it reproduces the 5-second timeout and completes at 8,171ms. Its giant
array-fill workload actually reports a computation limit (2,083ms unconstrained),
not memory exhaustion. A single allocation at the configured heap limit reports
`out of memory` in 53ms. Name each independent boundary and assert its actual
reason; keep production limits unchanged.

The service activity case mixes the integration contract with real shell startup.
Control only process spawn using the existing execution seam, retaining real
command/activity/evaluator and output persistence. Wait for the ordinary nested
`activity_wait` call, assert the activity is running and the outer result is
unfinished, then publish output and exit. Real shell capture, failure and process
tree termination remain covered in execution/workspace tests. The exact phase of
the initial CI activity timeout was not captured; no shell defect is established.

CLI navigation waits for a rendered menu label, which can precede passive input
subscriptions. An asynchronous Select mount reproduces the exact lost first key.
Drain React effects before input using public `act`; no renderer adapter, private
state or sleep is required. The server ownership case combines four cold
processes. Instrumented Node 22 phases total 4,591ms unconstrained and 18,774ms
under one CPU: startup transitions dominate; exits remain prompt.
Separate contention, graceful settings restart and crash restart into independent
real-process cases with the same 20-second deadlines and original assertions.
Exact CI timeout phase remains unavailable; future failures identify a scenario.

The first full local Node 22 check reveals a further cancellation fixture
readiness timeout. Initially the server graph was preloaded before installing the
gate/marker, retaining the real CLI entry after release. That attempt is superseded
below: it moved cold-loading cost into an unrelated marker prerequisite. Check
the latest release-file state after subscribing, so an early cleanup release
cannot be missed.

A subsequent controlled-load run captures a separate Stop acknowledgement loss:
control RPC reports a disposed pending response, but the fixture's `import(bin)`
has completed, proving the owner already shut down normally; startup.log is empty.
Background cleanup destroys sockets immediately after peer closure schedules
NDJSON output completion. Drain admitted RPC output before destruction using
Node's `finished(..., {readable:false})`; a shared 20-second signal bounds stalled
peers. A socket-to-transport map replaces the old socket set, distinguishing
pending authentication without duplicate ownership state. Ordinary premature
close/reset/broken-pipe errors are classified peer departure; other errors fail
shutdown. The existing connection factory keeps its signature. The Node-specific
transport factory exposes connection plus completion, enabling a real RPC
regression with Stop queued behind a blocked write and cancellation of drainage.
No writer queue algorithm or wire protocol changes are needed.

Writable completion alone does not resolve all real-process losses: a later
five-file constrained run still fails two Stop acknowledgements. A deterministic
actual `RpcPeer` regression reproduces incoming final-response-plus-EOF loss in
9ms. NDJSON reports closure before vscode-jsonrpc dispatches accepted frames;
peer disposal discards the response queue. Queue one reference-identity closure
marker in the library's existing dispatch queue and intercept it through its
public message strategy. Reader EOF and physical writer closure share that one
marker. No additional message queue, pending counter, polling or timed delay is
introduced. Wire messages cannot match the marker's object identity. EOF with no
response still rejects the pending request; accepted notifications and final
responses dispatch first. This ordering protects a demonstrated asynchronous
protocol lifetime. Writable drainage applies to normal composition teardown;
fatal teardown errors retain immediate transport cleanup.

Independent review identifies initialization overwriting terminal peer closure
after asynchronous completion. Real RPC regressions reproduce both server and
client `ready=true` after closure. Preserve `closed` after either initialization
await; retain received results without resurrecting the connection. Success,
failure and client response/close interleavings are covered through public peers.

## Milestones and completion checks

- [x] **Causal diagnosis.** Preserve both CI logs, inspect owning code/contracts,
      reproduce publication and input failures, and classify timeout phases.
      Check: each correction has evidence distinguishing a product defect from a
      test prerequisite or aggregate budget; unknown causes remain explicit.
- [x] **Discovery publication.** Extend the real crash/restart regression with
      an open stale read handle, observe failure, correct owner-side retirement.
      Check: original failure passes, live-owner exclusion and cleanup remain.
- [x] **Timing and keyboard regressions** (after diagnosis). Correct test
      boundaries and readiness with semantic completion and controlled external
      edges where justified. Check: original assertions and public behavior pass;
      actual process qualification remains representative.
- [x] **Shutdown response lifetime.** Verify the queued-response/cancelled-drain
      regression and original real owner shutdown under controlled load.
      Check: Stop reaches the client before transport destruction and EOF disposal, authentication
      sockets and departed peers clean up, stalled drainage is bounded.
- [x] **Review and validation.** Three read-only lenses cover correctness,
      architecture/simplicity and evidence/scope. Check: findings resolved, root
      `npm run check` and focused regressions pass; no unrelated changes.
- [ ] **Remaining cancellation qualification.** Preserve failure-phase evidence
      and correct reproduced fixture defects; distinguish those defects from the
      uncaptured original hosted timeout. Check: exact cancellation and original
      owner attachment pass under cold startup load and final Windows CI, within
      the unchanged overall deadline; retained diagnostics expose future failures.
- [ ] **Direct delivery.** Commit coherent validated increments, merge/push
      directly to `main`, and check Windows/Ubuntu CI on the resulting revision.
      Check: actual results and remaining limits recorded, checkout clean.

## Validation and delivery evidence

Three independent reviewers identified the publication mechanism and suggested
minimal public-boundary diagnostics. The real crash/restart regression with an
open stale reader reproduces the original `EPERM` before correction. All nine
background cases pass afterward (46.21s). Generic JSON replacement is unchanged.

A minimal asynchronous Select mount reproduced the exact lost first Down key:
three keys focus OpenCode instead of Codex. A pre-input React effect drain fixes
that reproduction. The corrected hosts fixture and its added regression pass all
four cases (11.88s), including real Local OAuth/cancellation. Verified Node 22 and
its matching official SQLite prebuild were used for final validation. Temporary
timing instrumentation and probe files are removed. All 45 cases in the evaluator, service and process
ownership files pass normally (8.72s) and under the same one-CPU restriction that
reproduced the old timeout (22.27s), with original deadlines unchanged. The first
full check passes static checks but fails one further fixture readiness case; a diagnostic full test run
passes 1,024 cases (36 skipped). This passing run does not establish a fix.
The later four-file constrained run exposes the shutdown response loss and
another compound evaluator transfer case; the latter is now separated into
independent cases, retaining partial-output and limit assertions. Initial
shutdown corrections pass 16 actual transport/background/ownership cases; the
stronger queued-response/cancellation regression passes all four transport cases.
After exposing the additional receive-side lifetime, six transport regressions
pass, including responded/unanswered EOF with a preceding notification and
simultaneous physical output closure. Peer/server integration cases also pass.
These intermediate checks preceded the final constrained and full validation.

The final EOF correction passes all 64 cases in five affected files under one CPU
and four workers (75.07s), including the original real-process Stop failures.
Three independent reviewers find no issue in the transport design; their
adjacent terminal-initialization finding is reproduced and corrected rather than
deferred. The full Node 22 check passes 1,031 tests with 36 skipped before those
last peer guards. After the guards, all 20 focused peer/NDJSON cases pass and the
final Node 22.23.3 `npm run check` passes typecheck, lint, formatting and 1,034
tests with 36 skipped (test phase 48.21s). All three review lenses are resolved.
The original local Node 24 SQLite binary is restored byte-for-byte afterward;
an in-memory database smoke test passes on Node 24.19.0.
Raw failed logs are preserved locally; the linked run retains both attempts.
No desktop presentation changed in this follow-up; actual process/RPC tests
qualify the affected boundary without opening additional native app windows.

The validated increments are
[`19a3552`](https://github.com/usatiuk/harness/commit/19a3552) (stale publication,
RPC closure/drainage and terminal initialization, with their regressions) and
[`d51afe7`](https://github.com/usatiuk/harness/commit/d51afe72eea70c90f6cbb2f34f1520bd343af9c7)
(test prerequisites and scenario boundaries). Both are fast-forwarded and pushed
directly to `main`, without a PR. The
[resulting Windows/Ubuntu run](https://github.com/usatiuk/harness/actions/runs/37660099019)
passes on `d51afe7`: Windows passes 1,023 tests with 47 skipped (314.98s), and
Ubuntu passes 1,029 with 41 skipped (141.48s). Both pass typecheck, lint and
formatting. The source checkout is clean and synchronized with origin afterward.

The initial source reassessment keeps stale-record retirement with the exclusive owner and
uses the maintained RPC dispatch queue plus Node writable completion for the two
demonstrated transport lifetimes. It adds no parallel queue, polling, retry or
production timeout increase. Test controls remain at input/process boundaries; cold owner
and shutdown qualification still uses real processes. The final documentation
increment records this evidence and closes the plan; no implementation work
remains open at that source qualification point.

The documentation-only `98a2993` push exposes a remaining failure in
[the final-main run](https://github.com/usatiuk/harness/actions/runs/37661610696):
Windows cancels-a-Local-waiter exceeds its unchanged 30-second test deadline;
all other 1,022 tests pass, with 47 skipped. Ubuntu passes. Source is identical
to the successful run. Reopen completion and diagnose the phase before any
correction; neither a passing source run nor a documentation-only diff proves
this cancellation qualification reliable. Raw failure logs are preserved.

Three read-only reviews agree that cleanup can mask an earlier prerequisite
failure and that an early-failure waiter lacks guaranteed abort. No product
cause is established. Temporary parent phase probes show a one-CPU/four-worker
run with cold TypeScript loading can exceed the bridge's 10-second marker wait;
its waiter completes in 14.14s, while unrelated multi-start scenarios exceed
their deadlines. This stronger load is diagnostic, not final qualification or
proof of the final CI timeout's phase. On ordinary verified Node 22, both
cancellation cases pass (7.96s total). Failure-only parent/child phase records
were added to capture the actual hosted-run boundary; assertions and deadlines
remained unchanged at that diagnostic increment.

The first full local check of file-based diagnostics exposes their own late-write
race: Stop control completes before `import(bin)` returns, and the child can
recreate its diagnostic file during recursive fixture removal (`ENOTEMPTY`).
This is an introduced diagnostic defect, not proof of the original 30-second
failure. Move child phase records to its already-open startup log stream instead
of adding fixture files, and snapshot parent phases before asynchronous reads.

The diagnostic-only
[`a054f77` run](https://github.com/usatiuk/harness/actions/runs/37664207024)
passes both platforms without capturing a failure phase. The corrected log-stream
diagnostics pass the full local Node 22 check (1,034 passed, 36 skipped; test phase
45.96s). A real Node 22 socket experiment also rules out the proposed paused-peer
writable-drain stall: admitted output finishes and drainage settles while the
client remains paused. No additional transport change is justified.

The final fixture gates the detached owner before its actual entry import, so its
marker means only that the owner exists and cancellation is possible. It removes
the artificial background preload. Once released, the owner has its actual cold
imports ahead of it: the nested readiness wait changes from 10s to the existing
20s Local startup allowance. This is an explicit fixture budget correction;
production timers and the overall 30s test deadline remain unchanged. Exact
`AbortError`, unconditional observer abort during teardown, and attachment through
`attachLocalServer` strengthen qualification: the fresh observer cannot launch a
replacement for the captured PID.

Both cancellation cases pass normally (7.65s total). Under the same stronger
one-CPU/four-worker cold-transform load (`TSX_DISABLE_CACHE=1`) that failed the
preload marker, all 62 cases in five affected files now pass (88.53s). The waiter
marker arrives in 1.52s and post-release readiness takes 8.94s; the bridge marker
arrives in 4.20s and readiness takes 7.15s. Both complete cleanup within 12.64s.
This comparison qualifies the corrected fixture and removes the reproduced
marker failure. It does not establish the phase of the original hosted 30s
timeout. Failure-only phase diagnostics remain; temporary success probes are
removed. The final Node 22.23.3 `npm run check` passes typecheck, lint, formatting
and 1,034 tests with 36 skipped (test phase 45.82s). All three independent final
review lenses report no actionable findings. Hosted qualification of this
revision remains open.
