# Testing

The [sandbox context and presentation follow-up](plans/cross-cutting/2026-10-18-sandbox-context-and-message-presentation.md)
adds real Bubblewrap checks for process-shared private `/tmp`, hidden host
temporary files and fresh `/run`. Active-prompt tests capture a real service/model
request and control Docker provisioning/exec to verify mapped cwd, remote-user
write access and probe failure propagation. Backend default tests cover usable
and unavailable Bubblewrap, server/settings agreement, explicit choices, canonical
`none` RPC values and saved `local` compatibility without file rewriting.
Headless message tests cover phase-independent text/actions, copy and selection;
existing protocol/reducer/OpenAI replay tests preserve phase data semantics.

Harness uses Vitest for tests, TypeScript for static checking, ESLint, and
Prettier. Tests are co-located with source as `*.test.ts` or `*.test.tsx` under
`packages/*/src/`.

Current coverage boundaries, platform evidence, and gaps are documented in the
[testing subsystem](subsystems/testing/README.md); its active checklist is in
[the testing plan](subsystems/testing/PLAN.md).

## Commands

```sh
npm test                         # all Vitest tests
npm test -- path/to/test.ts       # focused test file
npm run typecheck                # root, CLI, and desktop TypeScript projects
npm run lint                     # ESLint
npm run format:check             # Prettier verification
npm run check                    # complete local and CI validation
npm run test:native              # build and exercise actual Windows Tauri app
npm run prepare:remote           # build a complete Linux source deployment on Linux/WSL
npm run test:remote              # exercise isolated real SSH with that source deployment
npm run test:wsl                 # headless Windows WSL + rendered TUI qualification
npm run desktop:build            # release executable and NSIS installer
```

## Desktop right sidebar

`packages/worktrees/src/changes.test.ts` uses real Git repositories to exercise
staged/unstaged/untracked and committed comparisons, divergent upstreams,
pagination, unborn HEAD, renames, conflicts, index removals, CRLF conversion,
literal names, addition/deletion counts, binary index-removal transitions,
binary/oversized files, unsafe paths and cancellation. A controlled
filesystem ENOENT reproduces the atomic-save read race. `packages/server/src/changes.test.ts`
drives DesktopSession through the real public RPC boundary and verifies that
reads follow the conversation's current worktree after switching.

The sidebar cases in `conversation.spec.ts` cover a root-anchored nested family,
live side transcript updates, read-only controls, narrow layouts, icon toggling,
continuous all-file scrolling, file-tree jumps, wide tree placement, comparison
selection within the tree, full-length vertical guides without horizontal branches,
resizing beyond 900px and clamping after window shrink, per-file colored line counts,
actual-pane-width unified/split switching and multiline pairing, a static main
root, slow requests surviving list polling, and diff position across tabs. Delayed
8,000-line preceding-file updates preserve a clicked file anchor through responsive
reflow. Native mouse selection and real clipboard reads cover inline and split
text without gutters; continuous selection across virtual scrolling remains
unqualified. Geometry checks verify flush edges and equal 45px sticky headers;
resizing covers tree height and width, the 240px default/180px minimum, and width
retention through sidebar close/reopen. Separate-root checks restore actual pixel
widths, share dimensions with descendants, retain them through router replacement,
isolate host/server scopes and reset after reload. Pointer dragging verifies the
actual 180px clamp, not only its advertised separator value. Folder checks observe
the actual grid
transition and verify reduced-motion behavior. File controls cover independent
collapse, polling retention, keyboard expansion, tree reopening, metadata and
raw combined-patch/unavailable-count preservation after list replacement. Diff
context-menu coverage checks actual line wrapping/gutter visibility, checked state,
keyboard navigation/dismissal, sidebar reopening and page-reload persistence.
Long-line checks launch Chromium without Playwright’s headless `--hide-scrollbars`
argument and verify actual allocated scrollbar height, opaque thumb styling and
horizontal scroll movement. Hunk metadata checks measure the actual initial `@@` glyphs and hit-test
the row across unified/split and wrapped/scrolled layouts. Header checks verify
rename order/20px geometry and the fixed 12px worktree icon on a narrow window.
Preference unit tests validate malformed/partial saved values at the storage boundary. Tool-preview regressions preserve failed
and generic details while successful previews omit raw details, and feedback
controls appear only on assistant text.
The browser fixture controls data and transport delay; it does not qualify a
native desktop build or real SSH/WSL execution. Exact evidence and broader-suite
limitations are in the [delivery plan](plans/interface/2026-10-18-right-sidebar.md).

## Model retry middleware

Transient model failures retry through one bounded middleware for every model
call. Classification lives in adapter error modules (`openai-core`,
`anthropic-core`, `gemini-api`, `opencode-go`) with table-driven fixtures using
real documented SDK error shapes; inheritor packages (`mistral`, `litellm`,
`custom-providers`) verify their distinctive gateway bodies classify through the
shared helpers. Middleware semantics (bounds, `retryAfterMs` floor, cap
fail-fast, abortable backoff, no re-issue after the first yielded event) are
unit-tested in `packages/model-retry`. Engine tests prove agent and compaction
calls traverse the chain with the right `model.retry` purpose and stamp usage
`attempts`; `packages/service/src/rpc-session.test.ts` proves retries reach
attached clients only for user-audience purposes. The desktop Working line and
its settings control have focused Chromium cases in
`packages/desktop/tests/browser/conversation.spec.ts` (run with `npm run
test:browser --workspace @harness/desktop -- --grep ...`; Playwright browsers
must be installed once via `playwright install chromium`). Live-provider
classification remains unqualified; fixtures use documented error shapes.

When running the suite from inside a running Harness session, unset
`HARNESS_SERVER_SELECTION` (`env -u HARNESS_SERVER_SELECTION`): the managed
server selection leaked into tests makes source-run server harnesses fail the
selection assertion.

## Desktop streaming publication

`conversation-view.test.ts` uses a controlled clock to verify the 100 ms text and
reasoning publication cap, trailing content, terminal/control flushes, immutable
snapshots, long-history row reuse and timer cancellation. `session.test.ts` drives
the real service/RPC boundary to verify background deltas do not notify global,
connection, sidebar or selected-chat subscribers, and transport EOF preserves final text.
Transcript tests preserve old timing snapshots across completion and prepend.

`performance.spec.ts` uses production routes and the existing isolated session
fixture, with render counters added only by its test bundler. It covers a
1,000-message history, a 500-delta burst, closed/open large diffs, draft retention,
final-state publication, disconnected memoized controls and current-state restart
confirmation. This fixture does not establish production subscription isolation;
the RPC regression supplies that evidence. Run with the desktop browser command
and `performance.spec.ts`. Engine checks measure rendering work, not actual native
frame presentation. The [delivery plan](plans/interface/2026-10-17-desktop-streaming-performance.md)
records results and baseline-reproduced history-anchor drift (12 px automatic
prepend and 34 px idle regrouping). Final combined checks pass 1,518 tests (41
gated skips); Chromium passes 87/89, including all new performance/control cases.

## Test profile isolation

Desktop testing must not overwrite the developer's running profile or credentials.
Use mocked browser fixtures or explicitly isolated test homes and credential
backends; never use `.harness-dev/source` as a test target. Native credential tests
must also isolate platform storage (including APPDATA/LOCALAPPDATA on Windows),
not merely the server home. Do not seed or restore fixture accounts in dev storage.

## Global compaction threshold

The engine suite covers automatic/configured thresholds, partial and absent
capacity metadata, independent input/output limits, zero automatic allowances,
cached-input checkpoints, appended large tool results, two compactions between
tool steps in one turn, and changed model/provider options. Explicit thresholds
remain active when metadata is incomplete. Configuration tests reject
project-level compaction settings; protocol tests reject invalid token counts.
Real application RPC verifies global persistence, new-conversation resolution and
clearing without changing unrelated settings. Chromium checks the numeric Defaults
field and clearing; Ink drives the production selected-host JSON editor against
an isolated real server and verifies persisted values through RPC. The original delivery
passed 1,316 tests (38 skipped) and all 32 browser cases. Current follow-up
validation passes 1,339 tests (38 existing skips), 135 focused engine/RPC/TUI
cases and the isolated GUI save/clear regression. Detailed evidence is tracked
in the global compaction threshold plan.

## Compact tools and live activities

Live-preview regressions retain recent calls between settled steps and the next
model response, exclude empty reasoning, interleave new reasoning with calls,
keep long reasoning bounded, and retain the latest group's peek after terminal
turn updates. Earlier groups over three entries collapse completely; only the
latest group uses the five-entry threshold. Outer expansion hides duplicate peek
content, while individual peek rows expand directly. Transcript timing coverage verifies terminal updates with an
unchanged cell array and a stable final elapsed label.

Creation defaults are checked through the production browser form and real
application RPC: model/preset, sandbox and tool mode survive the next form, while
unrelated approval settings and tool allow lists remain unchanged. Clearing a
preset preserves other defaults. The full check passes 1,298 tests (38 skipped),
and all 31 Chromium cases pass. Tests use isolated homes and mocked browser state.

The [desktop follow-up](plans/interface/2026-10-11-compact-tools-activities.md)
uses production routes in Chromium to verify combined reasoning/tool work summaries, compact
one-line argument previews, expanded output, running-only activities, one-second
automatic refresh, overlapping-request prevention, completion/navigation cleanup,
disconnection while still mounted, and a late peek response after unmount. Canvas
tests exercise expanded tool history anchoring, including keeping a child in place
when an earlier page loads its parent. Eval presentation checks flat child rows,
separate begin/result inspection, failure-only labels, right-side tool chevrons and
native keyboard expansion. A 60-second server-clock-skew scenario verifies live
and completed labels use desktop observation time. Unit cases cover suffix-bearing
call IDs and preserving a live group’s observed timing when history prepends. Quiet
active previews are checked with long reasoning exceeding 2,000 characters,
five-entry tails with mixed reasoning/tool rows, two-line reasoning previews at
narrow width, tail persistence across expansion, identical reasoning rows in
tail and expanded details. Character-by-character streaming checks that two lines
fill before the preview advances exactly one wrapped line, using spaced text and
emoji. Long unbroken ASCII/emoji cases cover text moving below the label without
stalling or splitting characters. Other cases cover
label-only expanded thought summaries, supersede
folding, no opening animation on virtualized latest-tail restoration or
superseding an expanded group, fold-at-any-size earlier groups,
hover/focus highlighting, blank-reasoning chronology, bounded tool widths, and
reading-anchor preservation on expansion. A DPR 1.25 screenshot comparison
checks that scrolling output cannot bleed above a sticky header. A separate
Chromium instance enables native scrollbars and samples row geometry throughout
expansion to catch horizontal shifts. Streaming growth preserves open row
details across the tail boundary. Terminal-state peeks remain directly
inspectable. A representative 100-call run with 1,000-line writes verifies the
latest collapsed group mounts five tail calls, keeps the hidden 95 unmounted,
and mounts output and diff DOM only for opened calls. Qualification and
the baseline-reproduced 12px automatic-history anchor failure are recorded in the
[Work-group cleanup plan](plans/interface/2026-10-18-desktop-working-group-collapse.md). Vitest covers desktop grouping, nested Eval result ordering, row identity and
subagent commentary delta replacement without changing the final result.
Automatic-history cases cover prepend anchors, overlapping-request prevention,
explicit retry after failure, and multipage collapsed history with keyboard
continuation. A real RPC regression verifies concurrent session callers share one
history operation, preserve state after failure, and retry without duplicate items.
A replacement-view regression verifies reload does not share the detached view’s
history request.
Native test expectations follow the collapsed groups and automatic loading; those
Windows WebView2 cases cannot run on this Linux host. Final `npm run check` passes
1,297 tests (38 skipped). All 30 Chromium browser cases pass, including 28
conversation cases and two MCP settings cases.
Large-row collapse can remount a virtualized summary and lose keyboard focus.
Diagnostic captures confirmed a detached original summary and focus on the body;
keyboard activation tests target the current summary with `locator.press` for each key.
Further captures showed Enter reaching a focused summary before the virtualizer
replaced its cached 43,091 px height with the collapsed 135 px height. The test
waits for the measured item height to match its DOM height before reopening.
These tests qualify activation after measurement. Rapid reopening during
remeasurement can lose focus or reset the disclosure; that virtualization
limitation remains open.
Browser fixture output does not establish native WebView or live-provider behavior.

## Auto-approval inspection

The [auto-approval delivery](plans/execution/2026-10-11-auto-approval-revamp.md)
uses the normal workspace `ReadFileTool`; execution and sandbox packages are
unchanged. `npm run check -- --maxWorkers=2` passes on Linux/Node 24.21.0:
1,274 tests passed, 38 skipped; typecheck, ESLint, and formatting pass. The second
independent review and its final follow-up found no remaining blocker. The production desktop settings save regression
passes in Chromium with
`PLAYWRIGHT_BROWSERS_PATH=/tmp/harness-playwright-browsers npm run test:browser --workspace @harness/desktop -- conversation.spec.ts --grep 'settings saves'`.

Public service tests use actual temporary files with scripted providers. They
cover file-dependent verdicts, nonzero line offsets/limits, 20 reads without a
count cap, mixed YES/read output, provider-native continuation, interruption,
expiry, temporary-context non-persistence, and parent-turn usage. Controlled
clocks verify the single timeout across short steps and stopping review while an
ordinary read remains pending. Inspection fixtures do not execute unsafe scripts.

Live judgment remains model-dependent. Eight explicitly approved Mistral reviewer
calls returned YES for harmless inspection, but those fixtures were not exact
reproductions of the running conversation: the minimal case omitted history and
guidance, and the reconstructed comparisons initially retained wire wrappers and
omitted catalog temperature. Neither the context nor temperature comparisons
establish a fix. No shell commands or file tools executed during those calls.

A user-initiated retry captured directly in the running reviewer received the
current policy and denied `find /home/stepus53/projects/harness -maxdepth 2 -name
"*.md" | head -30` as “Unnecessary for reviewing the project based on provided
documentation.” This contradicts the policy's explicit prohibition on
necessity-based denial, ruling out stale instructions and a verdict-parser defect.
Its seven context items contained the user question, two read calls, README/PLAN
results, supplied guidance, and the proposed call, with no earlier denial or user
restriction. The user subsequently reported GPT 5.6 Luna works correctly as the
reviewer; no automated Luna qualification was run. Temporary debugging was
removed, and no reviewer context was persisted. Further live calls require
explicit approval.
Offline checks establish plumbing and prompt propagation, not judgment or
resistance to project-instruction injection. Ordinary reads retain their existing backend
semantics: relative paths are workspace-rooted but local access is unconfined,
the tool reads whole files before producing bounded line windows, and review
cancellation cannot forcibly stop its local IO. Removed custom-reader and byte-cap
checks are not evidence for the simplified implementation.

## Window shell layout

The production composer fixture now includes `WindowShell`. Native-frame and
fullscreen regressions check full viewport content/main height and Settings at
the bottom of the sidebar, including when the custom header is hidden. Before
the correction, native-frame mode placed content in the zero-height titlebar row:
the content measured 0px, main 30px and Settings bottom 93px in a 720px viewport.
Explicit content placement in row 2 restores content/main to 720px and Settings
bottom to 708px (the sidebar's 12px bottom padding). Fullscreen matches this;
custom chrome retains its 32px header and 688px content. The same regressions check
that the main panel's top-left corner is square with native decorations/fullscreen
and retains its 12px radius with the custom header.

The October 11 follow-up passes `npm run check -- --maxWorkers=2` (1,256 tests,
38 skipped). The geometry and screenshot were verified using the existing in-app
browser with compiled production shell/routes. The Playwright CLI suite could not
launch its 19 cases because its Chromium headless executable is not installed;
no browser or dependencies were installed. The native WebKit application and the
complete browser suite still require verification in their respective runtimes.

## MCP and shared human approvals

`packages/mcp/src/{mcp,oauth}.test.ts` uses the real official SDK across stdio
processes and loopback HTTP. It covers public Hybrid/code-only eval calls, raw
names with punctuation, discovery without direct promotion, schema/result
adaptation, startup isolation, pagination, invalid catalogs, no replay after
ambiguous disconnect, cancellation, permission inheritance, scoped children,
credential target binding, redaction, resource-header isolation, and OAuth
DCR/metadata clients/PKCE/refresh/restart/cancellation/expiry/logout.
Config/protocol regressions cover legacy `direct` normalization, and a service
regression verifies legacy overrides after SQLite reopen and successful continuation.
The [tool-mode delivery plan](plans/cross-cutting/2026-10-17-simplify-mcp-and-remove-direct-mode.md)
records validation evidence and remaining UI coverage limits. The
[eager-tools follow-up](plans/cross-cutting/2026-10-17-eager-tools-and-name-inventory.md)
checks scoped, stable name inventories, global-only settings, reload, and eager
built-in rosters in both modes; RPC/TUI and browser controls verify persistence.
`server/src/mcp.test.ts` exercises real typed RPC settings, write-only secrets,
namespace separation, reserved-key rejection before JSON normalization, safe
credential-backend errors, and client-owned sign-in lifetime. Approval and shared-server
regressions cover ordinary Ask human, auto-review bypass, zero-client expiry,
and existing multi-client racing decisions and reattach snapshots.

`cli/src/mcp-settings.test.tsx` renders production Ink controls. Desktop browser
fixtures substitute the RPC data edge and exercise production MCP/settings
controls with Chromium, including server-specific sign-in cleanup when another
server is still signing in; run `npm run test:browser --workspace @harness/desktop`.
Portable bundling and a real bundled NDJSON server were also exercised with
stdio/HTTP/OAuth fixtures, file-secret persistence across restart, and observed
child-process cleanup. The credential qualification overrides `os.homedir` only
at the test boundary to isolate the existing file backend. See the
[MCP delivery evidence](plans/cross-cutting/2026-10-10-mcp-tools-and-settings.md)
for full-check results and review status. macOS browser/fixture evidence does not
establish native Windows/DPAPI, Linux keyring, or real third-party OAuth acceptance.

In the upstream MCP delivery's macOS run, the unchanged QuickJS microtask test takes approximately
7.8 seconds against its existing five-second test timeout, while returning its
computation-limit error. Homebrew Node's `libnode` linkage prevents a copied
standalone-runtime test; an official standalone Node archive passes that check.
Bounded Vitest workers avoid observed `EMFILE` watcher failures in process tests.
CLI host checks pass from an isolated project root; this user's home `.harness`
marker otherwise causes unrelated global settings to be read as project settings
when the tests set a temporary Harness home. The unchanged conversation-canvas
geometry case intermittently fails in the full browser suite and passes alone;
its timing cause remains unisolated. The affected MCP/approval settings scenarios
pass. Tests/timeouts remain unchanged.

The v0.5.0 qualification's first hosted Windows attempt fails two unchanged
tests: `index.test.tsx` sees the initial frame instead of the sandbox-change
message, and the image-only SQLite/reconnect history case exceeds five seconds
(10.9 seconds including cleanup, versus 1.1 seconds in the previous passing
Windows run). The lifecycle test sends input without awaiting mount/subscription.
The identical-source rerun passes image history but repeats the lifecycle failure.
The lifecycle regression now awaits subscription and the rendered command before
submitting, retaining all behavior assertions; all seven local file tests pass.
Fresh hosted Windows/Ubuntu source and native checks pass in run 39115855339.
The image timeout cause remains
unisolated; no assertion, timeout or retry policy is relaxed.
See the [release delivery evidence](plans/interface/2026-10-18-desktop-working-group-collapse.md#minor-release-delivery).

## Managed runtime and release foundation

The [Node 24 refresh](plans/cross-cutting/2026-10-11-node24-dependencies.md) passes
`npm run check -- --maxWorkers=2` on Ubuntu with Node 24.21.0: 1,256 tests passed,
38 skipped, and typecheck/lint/formatting passed. Ten headless Rust cases,
`npm run dev -- --help`, `npm run prepare:remote`, and the desktop frontend build
also pass. Final `npm audit` reports zero vulnerabilities. These checks do not
qualify native desktop UI, signed release installation/updates, or live providers.
The same `npm run check` invocation is not green on macOS; the pre-existing
failures are tracked in
[deferred work](DEFERRED.md#macos-check-failures-outside-the-validated-ubuntu-evidence).

The Zod 4.6.5 bump fails the MCP RPC malformed-settings assertion; both cases
pass against the original dependency lockfile, and retaining Zod 4.4.3 restores
the full suite. The assertion protects client-side validation before transport.
Do not replace it with a server rejection assertion: that would hide the new
preprocessing/pipe regression. The skipped upgrade is tracked in
[deferred work](DEFERRED.md#zod-dependency-refresh).

Source CLI, Tauri development, Vitest and `npm run check` use ordinary Node/npm.
Use `.nvmrc` and run `npm ci` so native dependencies share the selected Node ABI.
Stop source processes before reinstalling/rebuilding loaded native modules on Windows.
Source CLI and Tauri use `.harness-dev/source` unless `HARNESS_HOME` is set;
packaged development uses a separate home and immutable payloads.
Installed apps and deployed remote servers use the shared downloaded runtime. Native
bootstrap/launcher tests use `cargo test --manifest-path native/Cargo.toml`.
The Unix home regression runs in a child with an empty PATH, accepts an owned
home and still rejects writable permissions. It also passes with a symlinked
temporary directory and the v0.1.6 AppImage's bundled library path. These checks
cover account lookup independently of host utilities. The rebuilt v0.1.7 AppImage's
headless helper passes account validation before publication; its SHA-256 matches
the released asset. After publication, cold `--prepare-runtime` succeeds under
the bundled library environment in an isolated home and returns existing Node,
server entry and payload paths. No GUI, server attachment or profile migration
is claimed by that check.
Desktop helper tests use `cargo test --manifest-path
packages/desktop/src-tauri/Cargo.toml`; those command modes run before window setup.
These are headless checks. Visible native E2E requires approval for each run.
The update relaunch regression covers the relaunch command construction and a
poisoned-parent child-process fixture proving a relaunched process never sees the
AppImage launcher environment (`LD_LIBRARY_PATH`, `PYTHONHOME`, `PYTHONPATH`,
`APPIMAGE`, `APPDIR`). Hosted Linux update/restart execution with that fix is not
yet qualified end to end.
The connect-time upgrade regression builds two server versions and starts real
owners over the local socket/pipe. It checks approval-held refusal, unchanged busy
selection, idle replacement, persistent identity/history and older-client reuse.
Host regressions cover the existing plugin deactivation blockers and admission
closure. They do not establish signed downloads or released SSH/WSL upgrades.
CLI replacement tests use real files and, on Windows, a mapped native executable:
replace while its old image runs, refuse to delete that image, then replace again
after physical exit. The ignored `held_image` test is a subprocess fixture invoked
by that regression. These checks remain headless and do not establish the combined
signed-download/update command against public release artifacts.
The current CLI update increment passes `npm run check -- --maxWorkers=2`
(1,218 tests, 36 skipped), eleven Windows and ten Ubuntu native cases, and fresh
source remote qualification: two WSL cases and three isolated SSH cases pass.
Windows and Linux release CLI/server payloads build and report the product version.
A Windows NSIS release installer builds and its updater signature verifies against
the project public key. It has not been installed or published; cold release
downloads and combined updates remain unqualified. Hosted release run
`38090212226` builds all four CLI/server and desktop targets for `v0.1.2`, verifies
the manifest and updater signatures through the production native verifier, and
uploads one 25-asset draft. Windows/Ubuntu full source checks and headless native
tests pass at `696c876`. Packaging establishes neither installer execution nor
native desktop interaction on macOS/Linux.
The draft is published as `v0.1.2` on October 11; anonymous manifest/update-feed
reads resolve all four platforms. These reads execute no downloaded program and
do not establish installation or updates. Install/update execution on the user's
machine remains prohibited; qualification must run on hosted machines.
Use a fresh `HARNESS_HOME`, such as `.harness-dev/simplification`, for the
replacement checks: old disposable development caches use the removed receipt
format. No pre-release cache migration is required.

The release pipeline is being simplified under the
[delivery plan](plans/cross-cutting/2026-10-10-release-installation-updates.md).
Discarded license/source inventory, sealing and custom publisher suites are not
qualification requirements. Retained tests should exercise signature/hash
rejection, atomic installation, one shared cache-use gate, helper cancellation
and physical exit, shared socket/pipe ownership and an actual CLI/server RPC turn.
The native launcher cleanup regression exercises `harness cache prune [--apply]`
without downloading Node: preview, refusal under a live shared cache lease,
removal across all cache locations, persistent files and repeat invocation.
The bootstrap test rejects redirected runtime directories (Windows junction or
Unix symlink). Both Windows and the rebuilt Ubuntu qualification pass.
The regular Windows/Ubuntu workflow now runs these headless Rust tests as well
as `npm run check`; it opens no native UI.

Source SSH/WSL qualification uses `HARNESS_DEVELOPMENT_REMOTE_PAYLOAD` from
`npm run prepare:remote`; WSL also uses `HARNESS_REMOTE_WSL`. A remote target needs
internet for pinned Node downloads. Use isolated homes and demo providers so tests
leave the user's data and credentials alone. No dedicated runner or Sandbox is
required; Windows Sandbox is optional for visible tests on supported Windows
editions. Otherwise approve and accept their windows during the final test run.

The October 10 simplification passes `npm run check -- --maxWorkers=2` (1,214 tests,
36 skipped), seven bootstrap/launcher Rust cases, nine packaged desktop headless
cases and one source desktop case. The fresh managed Windows server archive passes
outside-checkout RPC v4, a demo turn, physical exit and SQLite restart after its
mutable build output is deliberately broken. This is server-payload qualification;
it does not establish released CLI installation, native UI or public updates.
Earlier unrestricted process/Docker timeouts remain timing findings without a
proven cause; the bounded full run changes no assertions or test deadlines.

Checkpoint `6d59a40`, after rebasing onto MCP main `97eea03`, passed the full
managed check with 1,290 tests and 36 skipped. Fresh payloads passed the headless
outside-checkout CLI/RPC/demo/SQLite smoke. Replacement evidence is pending.
Hosted `v0.1.2` release builds now pass on all four targets. Anonymous cold
installation, installer execution, combined updates and macOS/Linux native desktop
interaction remain unqualified. Earlier native/source SSH/WSL evidence does not
establish execution of these released artifacts.

The desktop updater's headless browser regression exercises the production
Settings component with a controlled native boundary: no installation before an
offer, capture of the offered version, visible installation failure and a fresh
check before retry. Seven source desktop Rust cases pass, including two concurrent
shutdown callers joining physical preparation retirement. Nine bootstrap/launcher
cases pass after removing redundant Git provenance checks. Sandbox ACL/profile
failures were retried outside the sandbox; no visible GUI tests were run.
This does not qualify actual downloads, signed installer execution or restart.
The increment's full check passes 1,214 tests (36 skipped); the rebuilt development
payload, nine packaged desktop Rust cases and release-mode updater configuration
check also pass. Packaged tests point at the verified qualification cache, rather
than the incomplete default scratch cache.

## Native search and output finalization

Native-search and output-finalization regressions cover provider-owned defaults,
independent native `toolChoice` forwarding, phases including null/absence, display-only hints, readable
reasoning and opaque metadata, model switching, compaction and interruption.
`service/src/native-output.integration.test.ts` uses real SQLite and public RPC
to prove previews are not persisted, finalized content survives reopening, and
sidecars remain private. Shared transcript tests compare live and reloaded order.
Gemini transport tests use its official SDK with controlled fetch responses.
Mistral uses the existing pinned OpenAI HTTP/SSE transport against real local
Conversations fixtures for both API/Vibe modes, with and without hosted search.
They verify discovery, wire requests, native history and cancellation without
retry. Anthropic stream/request regressions preserve finalized encrypted
search blocks, mixed local-tool history and cumulative final input/cache counts.
Interruption regressions cover closed and open readable suffixes, reported and
unknown accounting, removal of incomplete native metadata, no local execution
after abort, and authoritative terminal events without a transport-EOF dependency.
Native-history regressions preserve search pairs separated by readable output and
exclude unmatched entries from rewound prefixes. Installed-SDK transport tests
also cover cancellation after the complete response body has already arrived.
Paused search state is discarded. Lifecycle regressions reject events after
completion while retaining first accounting and preventing local execution.
Context regressions invalidate checkpoints when provider options change and keep
cumulative billing input out of prompt-size checkpoints. Storage and wire schemas
reject phases on user/system messages. See the
[delivery plan](plans/models/2026-10-10-native-search-and-assistant-phases.md)
for run evidence and the unestablished server-process timeout. These controlled tests do not establish
live vendor acceptance, OAuth entitlement, cryptographic acceptance or billing;
credentialed qualification remains unperformed for this delivery.

## Windows test windows

CLI/server tests and browser renderer tests should run without extra console or
application windows. Noninteractive subprocesses use Node's `windowsHide: true`
or Rust's `CREATE_NO_WINDOW`; the interactive CLI keeps its caller's console.
Development commands preserve inherited stdio and the existing console
relationship through npm and test workers. Browser tests already use Playwright's
headless mode. This does not make the real Tauri application headless.

Native E2E tests deliberately show the app, move the pointer and exercise native
dragging, resizing and menus. Run them at the end, with explicit user approval
for each visible run; accept that their windows can steal focus. Windows Sandbox
is an optional place to run them when available, with the build/test prerequisites
prepared inside it. Sandbox is unavailable on Windows Home, and its viewer is
itself visible. No dedicated runner infrastructure or hidden app mode is required.
See [the process-launch research](research/2026-10-10-headless-testing.md) for the
verified limits and remaining evidence gaps.

Before the native-search rebase, the 2026-10-10 console-launch corrections passed
the full check pipeline under
managed Node: typecheck, lint, formatting and 1,074 tests (36 skipped). Validation
used a hidden command window and did not run native GUI tests. The first sandboxed
attempt was blocked by temporary-file rename permissions before any test ran;
the unchanged checks passed outside that execution sandbox.

After rebasing release work onto `0dfb0ff`, the complete combined check passes
typecheck, lint, formatting and 1,173 tests (36 skipped), and rebuilt CLI/server
payloads pass the isolated RPC/turn/SQLite-restart smoke. These checks remain
headless. New real-process lifecycle/selection tests use the existing thirty-second
integration allowance after phase diagnostics established that native Windows
security preparation exceeded the five-second default under full-suite load;
product deadlines and assertions are unchanged. An unrelated Docker stat case
timed out once; focused and final full runs pass unchanged, with that transient's
root cause still unestablished.

## Shared-server delivery

Each consumer holds one shared cache-use lease. Preparation callers acquire it
before spawning a helper; the helper returns captured paths and exits. Callers
retain their lease through physical child exit, and detached owners acquire their
own lease. Explicit pruning requires exclusive cache ownership. Current validation
and remaining qualification are tracked in the
[release plan](plans/cross-cutting/2026-10-10-release-installation-updates.md).

Desktop preparation has separate headless checks; none opens a Tauri window:

Desktop runtime selection follows Tauri's `dev` cfg alias. Packaged tests enable
`tauri/custom-protocol`, matching the dependency feature set by the Tauri 2 CLI;
the app's old same-named feature is not used to select runtime behavior.
`scripts/check-desktop-package.mjs` checks the actual release-build executable's
pre-window runtime preparation mode before upload, catching accidental use of
source checkout paths. Cold signed downloads/server startup remain separate checks.

The removed one-off published-release harness executed downloads, installers and
CLI updates only on GitHub-hosted machines. Its completed runs remain evidence:
it ran outside the checkout, checked two published CLI versions, preserved SQLite
conversations, no server downgrade, shared Node and the installed desktop's
pre-window runtime preparation. Its actual desktop bridge and older CLI also
reuse the same live owner over the local socket/pipe. Ubuntu also prepares a fresh
SSH account for released remote cold deployment, idle upgrade, shared Node,
preserved conversations and older-client reuse. All four targets pass for
v0.1.2 → v0.1.3 in run `38122675683`. SSH setup removes the temporary account's
inherited GitHub runner ACL; production ownership checks remain unchanged.
Windows passes an unchanged rerun after a release-download connection drop.
Run `38124352678` additionally passes one Windows updater case in the existing
native harness: published v0.1.2 installs the signed v0.1.3 update, exits and
restarts with a verified new server. The old release's startup defect requires
invoking the native update command directly. On the elevated runner, WebView2
debugging uses its executable-scoped HKLM policy, and the test uses the account's
normal home because NSIS relaunch does not inherit test-process environment
overrides. This is hosted-only setup; local native tests retain their existing
temporary homes and need explicit approval. No diagnostic file upload is retained.
Published WSL2 deployment and macOS/Linux desktop updater execution remain
unqualified. The additional WSL1 fixture was removed as unnecessary scope.

Release `v0.1.5` is published after run `38127043428` passes the pinned-Node full
check (1,256 tests, 38 skipped), Windows x64/Linux x64 glibc/Apple Silicon macOS
builds and production signature verification. Its public manifest/update feed
both report `0.1.5` with those three targets. Intel macOS was removed at the
user's request; the preceding `v0.1.4` workflow was canceled before publication.
Standard Rust release caches are saved for all three retained targets, and
Windows/Ubuntu main CI passes at `841d116`. This patch was not installed or
updated on the user's PC; the existing qualification gaps above remain open.
Run `38128269021` passes v0.1.3 → v0.1.5 on all three retained targets, including
actual Windows desktop update/restart and released SSH upgrade. The one-off
workflow and custom RPC script are now removed: a test tied to an old release pair
while the updater follows latest creates unnecessary maintenance. Ordinary source,
IPC/lifecycle and native tests remain, as do release build/signature checks.
`packages/desktop/tests/native/published-update.spec.ts` remains an optional Windows
updater test against an installed older executable, selected with
`HARNESS_NATIVE_EXECUTABLE` and `HARNESS_RELEASE_VERSION`; run it through the
existing Playwright native configuration only with explicit local GUI approval.

The combined Mistral correction and provider-settings integration passes the
Node 22 full source check: 1,251 tests, 36 skipped, with two workers. All 17
headless browser cases and the production desktop build pass. An earlier full
run had one unchanged real-container Docker glob test exceed its five-second
deadline; the whole file subsequently passed all 11 cases in isolation (glob:
866 ms). Its timing cause remains unestablished; assertions and timeouts are
unchanged. Edge initially failed before assertions when its sandboxed temporary
profile could not be written; the unchanged unsandboxed headless suite passed.
No live vendor, native GUI or installed-app execution was performed locally for
this integration.
The same Docker glob case exceeded five seconds in the first v0.7.0 release
source gate (run 39136528641). Its unchanged 11-case file passes locally and in
hosted Ubuntu CI 39136524848; fresh release run 39136864606 passes the full gate.
The timing cause remains open; no deadline, assertion or retry policy changed.
After validation, the user's Node 24 development command failed because this
checkout's SQLite binary targeted Node 22. Rebuilding only `better-sqlite3` for
Node 24 restored its in-memory open/query/close smoke check. No persistent database
or configuration was changed; native dependencies must match the invoking Node.

A reported source-desktop creation failure exposed an invalid `preset: null`
inside generic overrides. The desktop-to-service in-memory RPC regression first
reproduced Default/no-preset creation failures, then passed after omission; it also
verifies explicit presets and clearing an inherited default in persisted records.
Mistral API reasoning regressions use the real SDK with synthetic local HTTP/SSE
to verify documented model-specific options, aliases, omitted defaults and exact
effort delivery. Neither regression executes a live vendor or the user's app.
Final pinned-Node CI for this correction passes on Windows (1,247 tests, 47
skipped) and Ubuntu (1,256 tests, 38 skipped), including the headless Rust checks
in run `38126203710`. The local Node 24 full check retains two unchanged MCP OAuth
failures; no dependency/runtime switch or test relaxation was made to hide them.

```sh
npm run prepare:server --workspace @harness/desktop
node packages/desktop/tools/native.mjs cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --features tauri/custom-protocol --locked
node packages/desktop/tools/native.mjs cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --test preparation --locked
```

The replacement Rust tests exercise native preparation, failure before window
initialization and a real server configuration command. Source development has
a separate workspace-path check that installs no runtime or server payload.
The blocked-helper cancellation case substitutes a controlled Node process that
reports readiness and exits on stdin EOF. It checks parent cancellation, physical
retirement and lease release; it does not exercise an actual desktop helper
blocked on a native installation lock or download. Runtime fixture copies use
`fs::copy`, since the checkout and temporary directory may be on different volumes.
Separate admission/shutdown tests check cancellation and awaited completion with
controlled operation state. These are composed headless checks, not actual Tauri
shutdown, native UI or installer/update qualification. Replacement run evidence
remains pending in the release plan.

Stop's protocol acknowledgement can precede physical Node exit. Process tests
must await actual exit before removing their working directories.

The connection-delivery evidence below predates the runtime simplification.
Retained scenarios need fresh qualification under the replacement implementation.

Public RPC regressions in server/src/shared-server.test.ts qualify multi-client
approval decisions, disconnected accepted/queued work, fresh reconnect without
partial stream suffixes, failed second-client attach, shared detachment and request
drainage. Real-process tests in server/src/background.test.ts qualify simultaneous
startup, unauthorized rejection, zero-client pending approval and completion,
bridge-parent exit, crash/stale discovery, canonical-home reuse, copied-home
isolation, unsafe existing homes, initialized-client stop and classified startup
failure. Stale-owner recovery retains an ordinary open discovery reader while
the new SQLite owner retires the stale name and publishes a new instance; the
old handle remains readable. A real bridge against an authenticated paused receiver verifies EOF
detachment with outbound backpressure. Registry tests include concurrent edits
by separate client processes.

`connections/src/connect.test.ts` launches real failing child processes to verify
current-attempt startup diagnostics, exclusion of stale log output, silent failures
and the 8 KiB bound. Desktop host tests use real RPC peers with a stalled initialize
request to verify that reconnect rejects with the retained startup diagnostic
instead of RPC disposal text. Rebuilt native desktop display remains unqualified.
The 2026-10-16 correction passes 21 focused tests and all 14 real server lifecycle
tests outside the desktop sandbox. The full check with pinned Node 24, canonical
`TMPDIR=/private/tmp` and two workers passes typechecking, lint and formatting;
1,375 tests pass and 63 skip. Two failures remain: the QuickJS runaway-loop test
times out and the TUI OAuth fixture never reaches its active overlay. Their causes
are unresolved by this scoped correction. The initial sandbox run also encountered
temporary-path alias assertions and child file-watcher `EMFILE` failures; canonical
paths and the unsandboxed rerun eliminate those failures.

Architecture-correction regressions exercise shared-registry route replacement,
removal and metadata retention through real in-process RPC peers. Native-adapter
tests substitute Tauri to verify normal/protocol/malformed/oversized/write/ack
closure, early admission failure, failed detach and discarded-frame credit.
Paired desktop/TUI manager gates qualify cancellation before registry adoption
and a replacement observer surviving an old stop request. These are adapter and
manager evidence; rebuilt native Local cases establish actual process detachment
and owner/exit behavior. The native Rust completion-gate regression verifies app
shutdown waits for an already-draining bridge. Actual Local process gates cancel
before readiness, then establish the captured owner's independent completion.
Public RPC and engine tests cover failed first ownership, preserved registered
children and redacted method/class diagnostics. The TUI workspace runtime graph
contains 91 modules, with no cycles or execution implementation imports.
These passed on native Windows. Common provisioning/reconnect tests also pass on
real Ubuntu WSL and isolated Docker/OpenSSH Linux x64 glibc. Five native GUI cases
qualify Local-first editing, disconnected management, reconnect, persistent exit
and last-client stop-on-exit, native bridge exit before RPC initialization, and real WSL
provisioning cancellation including fixture process exit. A real WSL conversation
survives host switching and desktop exit, restores its draft and approval, then
completes after reattachment to the same owner. TUI tests render the command center
with real Local/WSL owners and qualify registry edits, host selection, switching,
client exit and fresh attachment to the pending turn.
The current Local runtime regression executes captured Node and real SQLite with
its sibling dependencies from an isolated payload outside the checkout, without
copying them into another cache. It also rejects malformed prepared descriptors.
A native case starts the actual GUI against an isolated temporary home/cwd, stops
its owner and starts a second owner from the same cached build. This qualifies
isolated cache resolution; its debug executable still uses checkout-owned packaged
resources. Earlier native homes beneath the checkout allowed repository
`node_modules` to mask a broken transitive dependency-cache layout.
Startup diagnostic tests retain the first native failure through later readiness
expiry and a secondary detach failure. SSH BatchMode
cases reject password-only and unknown-host routes without prompting. Current delivery evidence is tracked in
[the delivery plan](plans/cross-cutting/2026-10-03-remote-hosts-background-servers.md).

That delivery's full check passed 1006 tests (116 passing files, 36 skipped tests).
Rebuilt native qualification passes all 20 cases; actual SSH/WSL and
rendered TUI qualification passes five cases across two files. The native Rust
shutdown regression passes. Three independent reviews and follow-ups report no
remaining actionable findings in the
[correction plan](plans/cross-cutting/2026-10-04-connection-boundary-corrections.md).
An earlier full run had a stdio fixture directory removal fail with Windows EBUSY;
its focused rerun and final full check pass, but the transient lock owner/cause
remains unknown. Earlier unreproduced RPC errors and a QuickJS test timeout remain
recorded in the preceding plan's validation observations;
passing reruns are not evidence of a cause or fix. Fixture RPC failures include
their server startup log before cleanup. A sandbox-blocked Vitest startup was
retried outside the sandbox, without changing tests or timeouts.
The post-delivery six-case native run passed five cases, including isolated cache
startup, but one existing case hit EPERM renaming staged dependencies. Its exact
focused rerun passed unchanged. The transient lock/cause remains unknown; no
retry policy, timeout change or fix was claimed at that stage. The subsequent
probe and publication correction are described below.
Configuration regressions compare real account/home aliases, preserve repository
discovery when `.harness` itself is a junction, and verify global versus local
write destinations before settings directories exist. Expected fixture roots use
physical paths. Copied-discovery tests establish the private target directory
before copying, preserving the separate ownership and foreign-home assertions.
GitHub CI run 37196302969 passes Ubuntu and the elevated Windows runner for those
corrections.
Fresh native desktop configuration asserts that keep-running is unchecked and
normal exit removes the Local owner/discovery. Shared-client coverage leaves the
other client usable; background-work fixtures explicitly opt in through one helper.
Preference editing waits for persisted checked state rather than Playwright's
immediate `check()` assertion against asynchronous controlled state.
The first complete default-exit native run passed 17 of 20 cases; the preference
assertion and two startup cases pass on focused rerun. One startup reported the
previous cache-promotion EPERM; the exact transient filesystem cause remains unknown.
The first parallel remote run did not display typed TUI input, while its unchanged
five-case rerun passes. The frame-before-passive-input-effect timing gap is a
possible fixture explanation; neither accidental user input nor a product fix is
established. See the correction plan for final validation and unresolved observations.
The former dependency-cache publication encountered Windows rename denials and
startup timeouts. Its probe and retry evidence is historical and recorded in the
correction plan; that cache implementation is removed.
The final rebuilt suite passes all 20 cases (3.9m); this does not establish the
causes of earlier uncaptured startup timeouts or typed-TUI input loss.

`npm run test:remote` requires Docker and OpenSSH on the controlling client. It
creates a loopback-only SSH container, ephemeral key, verified known-host entry
and private client configuration, then removes the fixture. The separate Windows
`test:wsl` runner uses `HARNESS_REMOTE_WSL=Ubuntu` (or another installed distro)
and includes the rendered TUI conversation flow. Each case uses a unique remote
home and explicitly shuts down its existing owner before cleanup. The controller
verifies and transfers the native bootstrap; the target downloads Node/server
artifacts on demand and needs internet for a cold installation. Node/npm/compiler
installation on the target is unnecessary.
Fixture HOME is substituted at the process edge; production connection entries
expose no home or executable override. Tests exercise complete source deployment,
archive changes, cache reuse, captured Node and reconnect. GUI interaction is qualified by the
native suite; provider sign-in and every interrupted-install path are separate.

## Desktop native tests

`server/src/provider-search.test.ts` covers supported native-search defaults and
explicit opt-outs, safe status without credentials, per-connection RPC writes,
preserved credential sources/endpoints/models, concurrent sibling settings and
rejection of unknown/unsupported connections without changing the file.
A fixture provider with differently named fields proves generic schema-driven
projection and patches, excludes credentials and rejects unexposed keys and
cross-field-invalid values without writing. `provider-settings.test.ts` covers
definition errors for explicitly exposed unsupported shapes or missing defaults.
The production desktop route browser regression covers generic provider controls,
saving both choices, retained settings, dirty-field patches, routing-field name
collisions and surfaced errors. These tests
do not establish live vendor search acceptance or native desktop interaction.
The [delivery evidence](plans/interface/2026-10-11-web-search-settings.md) records
43 focused and two browser cases passing, plus the full-check OAuth failures and
server-process timeout that does not reproduce in isolation.

### Design playground

The [desktop design playground](../packages/desktop/playground/README.md) consumes
production controls/tokens with isolated sample state. Its own `npm run check`
covers formatting, JavaScript syntax and frontend build,
while root lint/formatting also include its source. Browser inspection exercises
its controls, portals, themes, narrow layouts and preview states. It does not
connect to the server and does not qualify production or native desktop behavior.
The [design plan](plans/interface/2026-10-04-desktop-design-system.md) records
browser evidence, production qualification and remaining checks.

### Conversation browser regressions

`npm run test:browser --workspace @harness/desktop` runs headless Playwright against
an in-memory Vite build of the production ConversationCanvas, desktop row identities,
controls and styles. The isolated fixture controls history, streaming and support
growth without opening application windows. It checks physical latest-edge
alignment (including fast output during initial empty-chat alignment), same-item
growth, expansion of the latest production Disclosure, reading pause, jump
re-entry without dock/fade movement,
earlier-history anchors with tool regrouping, bounded rendered items and support
growth without stealing the reader's position. Anchor tolerance is 1.5 CSS pixels:
Virtuoso rounds its header measurement to nearest pixel, then rounds the scroll
target upward. A reproduced 61.5px header and 55.75px anchor land at 54.5px, a 1.25px
difference with one correct scroll call. Tests wait for the actual initial
latest position before simulating reading.

The canvas fixture substitutes conversation/dock state. A second fixture uses
the production router, actions and Composer with a controlled session/data edge:
it defers or rejects delivery to verify duplicate suppression, edited drafts,
independent interruption, primary labels (including Interrupt with pending input),
Escape interruption with draft retention, IME guards and disconnected behavior.
The background-input browser case verifies a single Working group containing
reasoning, a provider web-search hint, plugin input and a tool; it also checks
collapsed pending background content beside visible human queued input.
Engine queue/steer regressions check persisted origin and turn placement; the RPC
case covers pending attachment, live events, history and model-request content.
SQLite reopen and reducer tests cover durable origin and unclassified legacy input.
The [background-input delivery record](plans/interface/2026-10-17-background-input-presentation.md)
records an existing Linux headless scroll-anchor failure reproduced against the
unchanged desktop snapshot, plus the empty `/tmp/.git` environment issue.
Neither fixture establishes RPC or native behavior. A controlled HTTP streaming edge
also exercises follow/pause/jump through the actual native app. Synthetic 200% CSS
zoom checks control reachability and app-owned layout-unit clearance. Installed
Virtuoso mixes bounding-rectangle and scroll coordinates internally under CSS
zoom, so follow and pagination at that synthetic scale are unqualified; these
checks do not establish real OS/browser zoom behavior. See the
[follow-up delivery plan](plans/interface/2026-10-06-floating-composer-scroll.md).

### Actual native application

`npm run test:native` requires Windows WebView2, Rust, and Visual Studio C++ build
tools. It packages the real server and Node runtime, builds the production web
assets and native executable, then runs Playwright against that executable's
WebView2 through CDP. It verifies that the WebView process belongs to the launched
application. Neither a browser mock nor a development HTTP server stands in for
the native app. Model and authentication HTTP edges are controlled for deterministic
command and sign-in tests; actual SQLite, credentials, shell processes, and shutdown run.

Tests isolate `HARNESS_HOME`, `APPDATA`, `LOCALAPPDATA`, and the WebView profile.
They cover concurrent approvals/turns/drafts, queue/steer/interrupt, presets and
settings, bounded history and large output/diffs, server crash/reconnect, shared
owner reuse, secure key validation/storage, real command survival followed by
explicit cleanup, and GUI exit while the owner is suspended. Local retains browser
sign-in and qualifies device-code display, cancel/retry and DPAPI storage. The full
desktop.spec.ts suite has fifteen passing current-owner cases; connections.spec.ts
adds host editing, multi-client exit policy, real WSL provisioning cancellation
and a remote conversation surviving switching/exit/reconnect. Test artifacts live under
`packages/desktop/test-results/`; non-secret visual scenarios save screenshots.
Credential scenarios do not record traces or screenshots. These native tests are
separate from the ordinary Linux/Windows `npm run check` CI matrix.

`design.spec.ts` qualifies legacy theme migration, appearance/composer preferences
across reopening, IME/send/newline handling, focused settings panels, popup/dialog
focus and containment, cancellation/acceptance, accent presets and black/white
extremes, and authoritative context/turn usage restored through actual SQLite/RPC.
Rendered axe text-contrast audits scope visible controls and reject violations or
unmeasurable results. They do not establish nontext boundary contrast or complete
accessibility conformance. System changes, forced colors and reduced motion use
CDP media emulation. Minimum CDP viewport and measured 200% CSS zoom qualify
reachability/overflow, not actual OS resizing/browser zoom. Native screenshots
support visual review. Run native end-to-end checks at the end of layout work:
they launch visible application windows. The delivery plan records final evidence.
In an interactive desktop session, obtain explicit user approval for each GUI
test run before launching visible windows.
Use the full `test:native` script to rebuild before qualification: development
builds reuse the default executable path without `custom-protocol`, so invoking
Playwright alone against that artifact fails at the expected production-origin
attachment. The approved 2026-10-10 rerun reproduced that artifact mismatch; the
production rebuild restored all six unchanged design cases (1.1m).
Native appearance checks also query the actual Tauri theme and Windows DWM theme/
Mica attributes, public decoration state and native resize/system-menu styles. Full-window OS screenshots
include the title bar, verify the foreground window and use physical coordinates;
CDP screenshots alone cannot establish native material. Surface checks cover the
document ancestors as well as the sidebar to detect opaque backing that hides it.
Actual OS accessibility/theme transitions, monitor moves, macOS/Linux packaging
and native startup IPC failure dialogs remain separate platform qualification.

The client-window-chrome follow-up adds a real physical header drag (waiting for
the native move loop), OS resize, rendered-control maximize/restore/minimize/close,
double-click maximize, the actual OS system menu and a native `HTMAXBUTTON` probe
at the displayed maximize control. It checks modal containment and retained
draft/navigation state across those interactions, and captures complete light,
dark and modal windows. The hit target establishes Snap integration, not a visible
Snap flyout on every display scale. Native fullscreen transitions and macOS
traffic-light dimming still require qualification on the corresponding platform.
Final execution evidence is recorded in the
[client-window-chrome plan](plans/interface/2026-10-10-client-window-chrome.md).
Its final rebuilt Windows run passes all six design cases (1.2m). Root checks pass
1,039 tests (36 skipped), and all ten headless Edge cases pass (9.9s). The explicit
theme regression emulates the opposite OS color scheme and checks caption glyphs
and red/white Close hover. Three independent reviews report no material findings.

The 2026-10-10 native-material change passes repository checks (1,037 tests,
36 skipped), ten headless Edge regressions, production/server/native builds and
all five focused native design cases (53.2s). Actual Windows theme, Mica and
standard window styles are verified. Full-window Light/Dark screenshots confirm
sidebar/title-bar continuity and the curved main-panel divider. This focused run
does not repeat unrelated native connection/WSL qualification.

The 2026-10-04 design refactor's final repository check passes typecheck, lint,
formatting and 1016 tests (117 files; 36 skipped). Its rebuilt ordinary native
suite passes 23 cases with the two WSL opt-ins skipped (4.3m). A separate final
`HARNESS_REMOTE_WSL=Ubuntu` run passes both real WSL cases (42s). Frontend and
playground builds pass, and three independent reviews report no remaining material
findings. The plan records failure investigation, correction reruns and native
screenshots; release installers, other native platforms, screen readers and live
credentialed OAuth remain separate qualifications.

The 2026-10-06 floating-composer follow-up passes the full repository check with
1,018 tests (118 passing files; 36 skipped tests), production/playground builds and
ten headless Edge regressions. Its rebuilt native suite passes 24 ordinary
Windows cases, with two WSL opt-ins skipped (4.2m). A separate final
`HARNESS_REMOTE_WSL=Ubuntu` run passes both real WSL cases (37.6s). Three independent
reviews found no remaining material issue. The follow-up plan records the
reproduced initial-scroll race, unchanged assertions passing after correction,
anchor quantization and synthetic zoom limits.

The direct 2026-10-07 push passes Ubuntu CI. Its first Windows attempt hits two
5-second timeouts in unchanged evaluator/background-activity cases and `EPERM`
replacing discovery during stale-owner recovery. All 48 tests in the affected
files pass locally without changes; that passing run alone establishes no cause.
The [delivery plan](plans/interface/2026-10-06-floating-composer-scroll.md)
records the unchanged Windows rerun, which passes those cases but fails different
CLI OAuth navigation and server ownership cases. The
[Windows CI follow-up](plans/cross-cutting/2026-10-07-windows-ci-reliability.md)
tracks causal corrections. Named resource cases assert the actual rejected
boundary; the former array-fill "memory" workload hit computation instead.
Activity/evaluator integration controls only spawn and verifies running/waiting
before output/exit; actual shell capture and tree termination remain qualified
separately. Ownership contention, graceful settings restart and crash restart
retain real cold servers in independent cases. CLI input drains passive effects
before writing, with a regression for an asynchronously mounted provider menu.
The delayed-owner marker follows gate installation before the actual entry's cold
imports, and an early teardown release is observed after subscribing. Cancellation
asserts `AbortError` and attachment to the captured PID without a replacement
launch. Teardown always aborts the original observer. The post-release readiness
wait uses the existing 20-second Local startup allowance, replacing its artificial
10-second sub-budget; the overall 30-second test deadline is unchanged.
Real-process load also
exposed a dropped Stop acknowledgement; public NDJSON RPC coverage holds an
initial write, queues Stop behind it, closes the peer and verifies delivery before
destruction. Abort-controlled writable drainage qualifies its bounded lifetime.
Separate public peer cases reproduce final-response-plus-EOF loss and qualify
both accepted-frame delivery and unanswered-request rejection when read EOF and
physical output closure coincide. The existing RPC dispatch queue owns closure
ordering; there is no extra queue or timing delay. Public initialization cases
also verify that closure remains terminal after asynchronous success or failure.
Production timers and overall test deadlines are unchanged; assertions are retained
or strengthened.

The initial source follow-up passes `npm run check` on CI's Node 22.23.3: typecheck, lint,
formatting and 1,034 tests, with 36 skipped. All 64 cases in five affected files
also pass under one CPU and four workers, including real owner shutdown. Three
independent review lenses are resolved. The
[pushed source revision's CI](https://github.com/usatiuk/harness/actions/runs/37660099019)
passes both platforms: Windows has 1,023 passed/47 skipped and Ubuntu has 1,029
passed/41 skipped. CI also passes typecheck, lint and formatting. Platform and
environment skips account for the different totals; no additional native GUI
qualification was needed for this process/RPC follow-up.

The documentation-only push later exposes the Local waiter cancellation test's
unchanged 30-second deadline on Windows; Ubuntu passes. Reopened investigation
reproduces an artificial preloaded-marker timeout under cold transforms and a
late-file diagnostic write during cleanup. The corrected fixture passes all 62
cases in five files under that same one-CPU/four-worker cold-transform load
(88.53s). Child diagnostics use the existing log stream and preserve primary
failure evidence. The exact phase of the original hosted timeout remains unknown;
failure diagnostics stay in place. The final fixture passes the full Node
22.23.3 check (1,034 passed, 36 skipped; test phase 45.82s) and all three review
lenses. The
[final source run](https://github.com/usatiuk/harness/actions/runs/37668957576)
also passes both platforms and static checks: Windows has 1,023 passed/47 skipped
(300.93s) and Ubuntu has 1,029 passed/41 skipped (110.42s). Both Windows
cancellation cases complete within eight seconds; both Ubuntu cases within two.
This qualifies the corrected fixture without establishing the original hosted
timeout's uncaptured phase.

The final documentation push's Windows run passes cancellation but times out the
compound convergence/authentication/bridge-survival/restart case at 30s. Its
exact phase is not captured. Qualification is reopened in the linked plan;
all other Windows tests and Ubuntu pass.

Phase instrumentation reproduces the compound fixture's cumulative cold-start
cost exceeding its overall deadline. Convergence/authentication and graceful
Local Stop/restart are now independent cases; the full zero-observer pending
approval, bridge-parent exit, same-owner reattachment, completion and persisted
output chain stays together. The existing idle bridge-parent case is folded into
that stronger scenario, retaining real process coverage without extra aggregate
cold launches. Fixture handles are closed during teardown, and failure phases
remain visible. All three retain 30-second deadlines.

A real loopback regression also forces a TCP self-connection to an absent
listener's port. It reproduces echoed authentication bytes being parsed as server
identity before correction. Connection admission now classifies only identical
connected endpoints as unavailable before sending authentication; the regression
verifies zero bytes written and socket cleanup. Socket and credential edges are
controlled, while the TCP connection is real. Ordinary authentication/identity
failures are not recovered by this guard. The reproduction runs on Windows/Linux
and positively verifies matching connected endpoints; other kernels are not
qualified for self-connection. All 63 cases in the five-file cold-start comparison
pass (89.35s); failure-only phase records retain a bounded startup-log tail before
cleanup. The final full Node 22.23.3 check passes static checks and 1,036 tests
with 36 skipped (45.08s), with all three review lenses resolved. Hosted
qualification is tracked in the linked plan.

A subsequent real-process regression gates one candidate before import, starts
another owner and verifies that successful adoption has already retired the
unselected child. This catches late discovery recreation after Stop that a
passing startup/convergence case alone missed. Complementary cancellation cases
still establish independent completion of an abandoned waiter's own launch.
Candidate retirement targets the retained ChildProcess and waits for departure
within the existing startup allowance; ordinary pre-selection abort preserves it.
The final full Node 22.23.3 check passes typecheck, lint, formatting and 1,037
tests with 36 skipped (57.71s). No task-owned CI Node processes remain after that
check. All three final review lenses are resolved. Hosted qualification of this
last lifetime correction is pending at handoff.

The auto-approver scenario saves a reviewer model/preset in the actual GUI,
verifies that model performs review before a real shell tool executes, changes
the global reviewer and observes the next review in the same loaded conversation
use the new model/preset without changing its main model, then switches off auto
approval and observes human approval.
Restart and resetting to the conversation model establish persistence and clearing.

`HARNESS_NATIVE_EXECUTABLE` can select a staged release executable for the same
suite. Development builds need their prepared server resources; released builds
download their server and Node payloads on first use.
`HARNESS_NATIVE_PATH` overrides only the native application's PATH, leaving the
test runner's environment intact. Windows release
qualification must launch outside the source tree with no system Node on PATH;
a debug build or browser-only test is not packaged-app evidence. macOS/Linux
desktop installation and live external OAuth sign-in remain unqualified.

The [draft release plan](plans/cross-cutting/2026-10-10-release-installation-updates.md)
defines future clean-install, two-release update, shared-runtime, protocol-mismatch,
public-baseline data preservation and cache-maintenance qualification; concrete
migration/recovery tests belong to actual later format changes. These scenarios have not run;
current source/native results do not establish release signing, anonymous download,
installer upgrade/uninstall or updater activation. Visible native GUI tests require
explicit user approval for each run and belong at the end of a delivery slice.

Real shared Docker/Compose qualification is opt-in:

```sh
HARNESS_DOCKER_INTEGRATION=1 npx vitest run packages/sandbox/src/docker-sharing.integration.test.ts
```

On PowerShell, set `$env:HARNESS_DOCKER_INTEGRATION='1'` before that command.
It requires a Linux Docker daemon, Compose, and image/package download access.
The fixture creates temporary projects and recipe-owned containers/networks and
cleans them on completion. Ordinary tests control Docker process edges instead.

Real LiteLLM qualification is separately opt-in:

```sh
HARNESS_LITELLM_DOCKER=1 npx vitest run packages/litellm/src/live-gateway.test.ts
```

On PowerShell, set `$env:HARNESS_LITELLM_DOCKER='1'` first. It requires Linux Docker
and access to the pinned official LiteLLM v1.103.2/Postgres images. The fixture
creates isolated temporary containers/network/configuration, exposes only a
loopback gateway port, and cleans owned resources. Real LiteLLM authenticates
virtual keys, restricts catalogs and generation, and translates three native
streaming routes to controlled upstreams. Two-turn Responses replay covers both
origins plus a shared load-balanced alias with encrypted-content affinity;
Messages replay preserves signatures. The ciphertext/signatures are synthetic:
this verifies gateway fidelity/affinity, not vendor cryptographic acceptance.

CI runs `npm run check` on Linux and Windows. Execution, process, filesystem,
credential, and terminal behavior may be platform-specific even when most logic
is shared.

## Finishing a change

Run focused tests while iterating and `npm run check` before handing off code
changes. For documentation-only changes, at minimum run Prettier on the affected
files and `git diff --check`; expand validation when configuration, scripts, links,
or generated content are involved.

Run independent checks concurrently when practical, respecting dependencies and
shared outputs. Report actual results and limitations; compilation, mocked
transports, and backend-only tests do not establish real client/process or platform
behavior. New clients need integration evidence through the public protocol and
their actual runtime when implemented.

## Failure investigation

When a test fails or observed behavior contradicts an expectation, establish the
root cause before fixing it. Preserve failure evidence and distinguish product
defects from incorrect tests, assumptions, and environmental restrictions. Do not
weaken assertions, increase timeouts, add retries or fallbacks, or patch symptoms
without evidence that the change addresses the cause. If the cause remains
unknown, keep the issue open and report it. Verify the eventual fix against the
original failure and intended contract.

Tests must also work when the system gets faster. Observe the actual prerequisite
or completion event, rather than relying on debug-build slowness, incidental
delays, or a nearby condition that does not prove completion.

## Coverage notes

- Code-mode regressions exercise a real QuickJS worker and workspace tools through
  HarnessService: selected data, deferred/effective contracts, freeform inputs,
  scope and restricted children, instructions after the outer batch, computed
  auto/human/policy decisions, partial effects, return/throw with pending work,
  cancellation and next-turn recovery, concurrent foreground commands, sequential
  awaits and direct batches, simultaneous correlated approvals, activities,
  nonzero parent/child/reviewer usage, and per-operation escalation routing with
  a controlled OS execution edge. This qualifies routing, not live Linux
  containment. Public RPC with reopened SQLite qualifies nested associations,
  structured `null`, spill/full refs, and crash reconciliation. Actual projected
  history is rendered through OpenAI Responses/chat and Anthropic builders;
  live provider credentials are not required by these checks.
- Ordinary discovery regressions cover all three modes, unchanged deferred-call
  admission, repeated/overlapping searches beyond the result cap, initially
  declared tools, repeatable full describe, actual service compaction, rewind and
  runtime reload, and interrupted discovery. Complete multibyte definitions and
  oversized omissions are checked with the shipped output plugin and without an
  execution backend. Core discovery is absent from the guest and nested calls to
  discovery entry points are rejected.
  October 13 adds OR-of-AND keyword queries, shared Hybrid declaration/admission
  gating, essential contracts in code-only but not duplicated in Hybrid, scoped
  contracts across actual compaction and model-specific file rosters. MCP request
  fixtures verify child scopes and omit hints for empty scopes. LiteLLM fixtures
  exercise exact/legacy/empty effort sets, defaults/off request parameters and
  configured overrides. Selected-host TUI Settings verifies the shared Hybrid
  default and label. Full checks pass 1,360 tests (38 existing skips); 80 focused
  tests and two desktop browser cases pass. Live gateway/native UI qualification
  remains separate.
- Runtime tests reject runaway code/jobs/getters, empty-message failures, memory,
  output, argument/name/result/cumulative data and submission limits. Ordinary
  search bounds queries independently. Eight
  multiline 32-KiB workspace reads qualify a representative valid workload.
  Compaction/rewind tests bound retained successful and failed child pairs; generic
  request history follows selected branches with explicit pre-compaction access.
  Activity tests cover overlapping waiters and cancelled waiters retaining notices.
  Native callback globals are absent from the guest. Service checks preserve
  caught denial evidence and bounded spilled structured previews. Windows native
  code-only qualification uses bundled Node/server/worker/WASM from a temporary
  cwd outside the checkout, excludes system Node, reviews actual PowerShell
  children, and reopens nested allowed/denied history. Other desktop platforms
  and live Linux code-mode execution remain separate platform qualifications.

- LiteLLM tests exercise real pinned SDKs against local HTTP/SSE edges for all
  three transports, exact aliases and credentials, prefixed paths, two-turn tool
  continuations, Responses ciphertext and Messages signatures, effort/request
  caps and nullable usage. Discovery covers conflicting/unsupported metadata,
  exact enrichment, hidden aliases, empty/replaced/retained snapshots, byte/row
  limits and cancellation. Server RPC tests cover named login/logout/restart,
  isolated keys, preserved selection, pre-probe validation and startup abort
  releasing SQLite. Metadata tests cover separate input/output limits, explicit
  reasoning flags/efforts, sparse/conflicting rows and the public domain-client
  round trip. Bootstrap bounds the expanded wire catalog. The opt-in Docker
  test above adds real gateway fidelity/affinity evidence; actual vendor
  cryptographic acceptance remains tracked in the delivery plan.

- Mistral tests exercise the real pinned OpenAI SDK against local HTTP/SSE
  Conversations fixtures, with synthetic API keys and signatures. They cover native interleaved
  thinking replay, exact tool arguments and native/imported IDs, stable
  headers/prompt prefixes, complete-selection replay, foreign reasoning omission,
  display-only hosted execution, cached-token accounting, unknown/malformed usage,
  terminal tool errors, overflow and socket closure on abort/consumer return.
  Catalog checks cover both surfaces, bounded rows/bytes, aliases, atomic
  replacement, redirects and external failure classification. Server RPC tests
  cover isolated API/Vibe and named credentials, sign-in/logout/restart,
  failed discovery, preserved unavailable selection, catalog and generation.
  Configured-model regressions cover strict metadata/ID validation, additions and
  exact-ID overrides on both surfaces, retained discovered controls, combined
  catalog limits, atomic publication, and configured entries after discovery
  failures. The RPC fixture loads saved model definitions, exposes overridden
  limits and degraded discovery status, and generates a configured-only model
  through the existing native HTTP/SSE path.
  Native signed continuation across a SQLite/server restart is composed coverage
  from adapter and existing core payload tests; it is not a direct Mistral restart
  case. RPC auth tests substitute the secret backend and do not qualify real DPAPI.
  These tests do not establish real vendor signature acceptance, cache-hit rates
  or subscription billing; no Mistral vendor credentials were available.
  Continuation regressions reject top-level input-entry IDs with the reported 422,
  cover assistant-only and signed tool histories, and retain stored output IDs.
  Advertised Vibe effort strings (including native `none` and GLM levels) retain
  their exact request values; only legacy `off` maps to `none`. Unknown advertised
  strings remain selectable, while unadvertised selections fail validation.
  Reasoning booleans do not manufacture presets. Headless production desktop
  routes qualify distinct dimmed IDs, hover metadata and creation preset submission
  and reset, clearing the reviewer model, and refreshing a saved default identity
  on loader revalidation. Updated native selectors still require a rebuilt native run.

- Model-call context regressions cover concurrent roots, nested subagents,
  logical retries, compaction and resume with each conversation's own ID.
  OpenCode Go HTTP fixtures reject missing `x-opencode-session` and exercise
  all three real SDK transports with shared clients and concurrent conversation
  identities, including repeated calls and the Harness user agent.

- Named built-in provider tests cover independent stored API keys, exact
  environment references, uniform encoded slots, label changes, construction identity,
  type contributions and pre-construction validation. Codex tests cover isolated
  OAuth token records, coalesced rotation, single/final waiter cancellation, logout
  during refresh and interactive login excluding stale-account refresh. A public
  RPC regressions cover changing an API-key instance to OAuth before restart and
  device authorization, safe disabled-device diagnostics, cancellation and selected
  instance persistence. Device tests also qualify pending authorization, expiry and
  reusable OAuth sessions. Rendered TUI tests qualify both Local methods, URL/code
  display and leaving sign-in. Existing browser callback tests remain in place.
  Compatible-provider settings/SDK tests use the contributed provider types;
  removed direct factories have no remaining production or test consumers. Packaged native tests cover two keys in
  DPAPI, restart discovery, picker metadata and reopening an existing unavailable
  selection without losing its transcript. Live browser
  login with multiple real accounts remains credential-dependent.

- The `opencode-go` provider uses a bundled 2026-10-16 Models.dev Go snapshot
  and validated startup discovery. Tests cover independent connection snapshots,
  metadata/preset validation, catalog replacement/removal, failed refresh retention,
  bounded downloads/diagnostics, unsupported and deprecated entries, cancellation,
  and Chat/Responses/Messages mappings through real SDK/local HTTP requests.
  Metadata credentials are never sent to Models.dev. Live API parsing is a manual
  qualification; automated tests use deterministic responses. Live inference smoke
  (one preset request per transport and a preconstructed tool-call continuation)
  is opt-in behind `OPENCODE_API_KEY` and is not run in CI. Credential-backed
  encrypted-reasoning replay and the unsupported Google generateContent route
  remain uncovered. Unqualified Messages thinking controls remain informational.
- The chat/completions transport's reasoning round-trip (plaintext
  `reasoning_content` folded into one native assistant message per generation, so
  a tool-calling turn's reasoning rides the message that carries its tool calls),
  same-chunk reasoning+boundary handling, the interleaved-reasoning fail-fast
  guard (reasoning after the finalized item throws rather than being silently
  dropped), malformed tool calls, truncation/filter terminal errors, nullable
  usage, and the missing-terminal-failure path are unit-tested via fixture streams;
  the live OVMS/chat-completions path is a documented smoke boundary.
- Chat reasoning is folded onto its generation's assistant message; a reasoning
  item with no following assistant output is flushed as a standalone assistant
  reasoning message instead — covered by the request-mapping tests.
- Custom providers have a public-boundary regression from a real settings file
  through factory composition, `HarnessService`, a controlled chat SDK stream,
  tool dispatch, durable usage, and SDK-signal cancellation. Protected request
  builder tests remain for exact transport-shape assertions. The test reproduces
  the production settings-to-plugin bridge; the private interactive CLI bootstrap
  itself is not invoked.
- Store contracts and CLI reducer tests cover durable nullable usage, incomplete
  totals, and context-checkpoint clearing. Engine tests cover record-before-fail
  terminal errors and validation before capability-dependent work.
- Config, engine/service, and CLI regressions cover atomic model selection across
  file/profile/plugin layers, global and conversation persistence, `--model`, and
  explicit preset selection/reset. Same-named presets never cross identities.
- Client/server regressions cover bidirectional request correlation,
  cancellation, invalid messages, first/repeat attachment ordering, failed and
  in-flight attach cleanup, multi-page history plus transient/durable overlap,
  large item reconstruction, attach-first operation admission, cancellation
  before disposal, root isolation, plugin snapshots and controls, queued
  approvals, connection-wide shell identity and collision rejection, sandbox
  mutation/reload, and fatal NDJSON limits. Local stdio is smoke-tested from the
  CLI; SSH smoke remains environment-dependent.
- Parallel-conversation regressions cover model/preset pinning across reload and
  service recreation, child/plugin inheritance, concurrent settings patches,
  independent interruption during held settings IO, stale runtime callbacks,
  and authoritative failed-reload/cleanup detachment. A separate stdio server with
  real SQLite/plugin composition and the demo provider exercises simultaneous
  approvals, closing A while B's approval and real shell survive, and retrying A.
  This fixture qualifies the protocol/process boundary; it does not invoke the
  credentialed CLI bootstrap or provide TUI parallel presentation. Desktop native
  tests independently exercise the shipped composition and parallel client UI.
- Docker controlled regressions cover shared provisioning, aggregate idle,
  scoped IO/process cancellation, close-before-child-exit, cleanup/retry, and
  warning controls. The opt-in live Compose test additionally qualifies shared
  handles, subdirectory mapping, distinct recipes, own-command shutdown, rebuild,
  and final workspace/sidecar/network cleanup. Native Linux execution and live
  model-provider concurrency remain separate platform/credential qualifications.

## Conversation naming

Manual rename coverage uses real in-process RPC to verify trimming, empty/oversize
rejection, persisted metadata, the title event and close/reattach. The isolated
production-route browser case covers hover visibility, inline focus, Escape/cancel,
Enter save, whitespace rejection and header/sidebar agreement. Test fixtures do
not use developer profiles or credentials.

October 13 rename validation passes 29 focused tests and the full check (1,347
passing tests, 38 existing skips). Chromium passes 47/48 cases, including rename
and compact header geometry. The idle/history-regrouping reading-anchor case
fails its 1.5px position assertion in both the patch and an isolated clean
`3633e35` baseline. Its cause remains unestablished; it is not fixed by this
rename change. Native platform UI was not separately qualified.

`conversation-titles/src/index.test.ts` uses a gated provider and real in-process
RPC to verify saved excerpt/generated titles, independent agent completion,
configured/default models, isolated prompt, accounting, failure/empty output,
no regeneration after reload/rewind, explicit metadata overwrite, shutdown
drainage and subagent exclusion. Gated persistence regressions verify cancellation
during excerpt saving, forced close during first-message saving, and failed excerpt
writes reaching a failed terminal event and idle runtime cleanup. Shared store tests cover conditional title
updates/read/pages; SQLite tests upgrade versions 3/5/6 and reopen saved titles.
Desktop session tests verify real RPC updates to both the loaded view and cached
sidebar list. Two production-route Chromium cases verify naming model/preset
save/reset and saved titles in header/sidebar; TUI tests verify named resume choices.
The Mistral fixture verifies agent+naming billing and separate agent context usage.
Internal accounting-failure regression checks safe diagnostics and surfaced cleanup
failure after runtime removal. Native desktop and live vendor title generation
require separate qualification.

Conversation-title delivery passes `npm run check -- --maxWorkers=2`: 1,289 tests
passed, 38 skipped; four affected Chromium cases and three independent reviews
pass. See the [delivery plan](plans/interface/2026-10-11-conversation-titles.md)
for corrected test assumptions and qualification limits.

## Adjustable sidebar regressions

The shared store contract verifies accepted-input recency, creation-order callers,
folder filtering and subagent exclusion before pagination. SQLite tests cover the
version-7 upgrade, restart persistence and stable Unicode folder ties; in-memory
tests use the same binary tie ordering. Core regressions distinguish accepted and
queued user input from plugin deliveries and empty Stop, and verify a failed
recency write rejects before inbox admission or turn creation.

A real in-process RPC/desktop-session regression uses 66 folders and 120 subagents
to verify bounded pages beyond the initial page, exclusion before limits, accepted
send refresh, preservation of loaded counts and creation refresh. Its home and
workspace folders are temporary; it uses a fake model and no developer credentials.
Three production-route browser cases cover five-chat increments, Recents paging,
hide/open/create reappearance, collapse retention, duplicate names, host-scoped
preferences, reload persistence, pointer/keyboard resizing and hidden navigation.
Browser fixtures do not launch the developer desktop profile.

Delivery validation on October 12: `npm run check` passes with 1,325 tests and
38 existing skips; all 36 browser regressions pass. A focused sidebar screenshot
run also passes, and the rendered layout was inspected. This establishes browser
and RPC behavior, not rebuilt AppImage GUI qualification.

## Credential isolation for real sign-in fixtures

`HARNESS_HOME` isolates settings and conversations, but does not isolate the OS
keyring: it uses the shared Harness service namespace. The fallback credential
file also uses the OS home (`~/.harness/credentials.json`), independently of
`HARNESS_HOME`. Therefore an isolated Harness profile alone is insufficient for
real OAuth success tests. The TUI device fixture explicitly selects file storage
and replaces `HOME` on Unix; Windows selects DPAPI with temporary `LOCALAPPDATA`.
Its success assertion verifies the credential artifact inside that temporary
profile. Never auto-probe the developer's keyring in a sign-in fixture. The prior
TUI fixture could overwrite real Codex credentials with the device fixture identity;
this is corrected at the test boundary without changing production storage.

## Quiet labels and conversation presentation

Production-route browser cases cover long titles at the minimum sidebar width,
flat Recents/project alignment, compact ghost actions, title/path removal, muted
Markdown dividers, default 13px text and GUI size changes/reload persistence.
Fractional virtualizer sizing is exercised at every supported size (12–18px),
including same-item growth while following. Real RPC session tests qualify unread
assistant output outside the selected chat and clearing on selection; a browser
case qualifies spinner/unread rendering and opening behavior.

The experimental native near-60-FPS override and its Settings C-API test were
removed after the [isolated frame-pacing investigation](research/2026-10-12-linux-frame-pacing.md).
Linux uses WebKit defaults. Callback timing and local Sysprof marks do not qualify
actual display presentation or a scrolling fix. Existing preparation
integration-test failures remain separate from the native lib/bin tests.

Final Quiet labels validation: the full check passes with 1,327 tests and 38 existing
skips; all 47 browser regressions and nine native lib/bin tests pass. Shared Radix
dropdowns are exercised through production forms, including empty/default values.
The idle-history anchor scenario captures its baseline and starts prepend in one
browser evaluation so intermediate virtualizer measurements cannot stale the
observation; the original 1.5px tolerance is unchanged. Screenshot capture waits
for rendered Markdown to enter the viewport. Windows native browser scenarios were
updated for custom menus but were not run on this Linux host.

The published v0.1.11 Linux AppImage also passes isolated cold headless runtime
preparation through extracted AppRun (exit 0, all prepared paths in the temporary
home). This does not exercise GUI rendering or in-place updater install/restart.

Fork regressions cover shared/nested history and global item reads through the
shared store contract, SQLite schema-8 upgrade/reopen, real RPC draft hydration
and source runtime independence, GUI draft preservation, and the TUI `/fork`
picker. Tool-result pairing and provider request mapping cover repeated provider
call IDs across owners. Browser fixtures and TUI doubles keep credentials and
normal desktop profiles untouched.

Provider/MCP settings regressions exercise creation, duplicate/schema rejection,
credential separation and restart status through real RPC with isolated temporary
homes and in-memory credential backends. MCP fixtures verify stage/HTTP diagnostics
without remote-body leakage. Browser checks cover basic bearer/OAuth setup, expert
configuration preservation, OAuth cleanup, LiteLLM setup and distinct selection
colors in both themes. Native Windows selection and the user's enterprise GitLab
instance still need real-platform/instance qualification.

### Managed worktrees and workspace-owned Docker

`service/src/workspace-switch.test.ts` covers complete-batch switching (including
real QuickJS parallel calls), refreshed instructions/execution, overlapping config
resolution, forced-close cancellation and deletion admission. `worktrees/src/git.test.ts`
uses real isolated repositories for dirty/primary protection, failed creation and
post-Git persistence failure recovery. It also covers explicit Git branch names,
invalid/name-namespace conflicts before ownership,
readable generated collisions, concurrent creation with distinct branches and one
ownership record per checkout, and external rename readback. The RPC scenario also
selects an explicitly named branch and verifies a Git rename without path changes.
The picker browser case substitutes the server answer to verify refresh on opening;
the real Git rename is separately covered by the package/RPC tests.
`server/src/worktrees.test.ts` uses actual
RPC/SQLite restart with temporary home and memory credentials; `cli/src/hosts.test.tsx`
saves/clears the directory through Ink Settings. Browser regressions exercise
creation eligibility, branch switching, confirmation and directory settings. A
desktop browser fixture pins the new-conversation worktree option to the compact
check-label rendering (16px native checkbox, no full-width input-field styling)
with its form submission and non-repository disable behavior.

The [project/picker follow-up](plans/interface/2026-10-17-worktree-project-picker.md)
adds both-store and application RPC coverage for original-project grouping before
pagination, preserving exact workspace filtering and excluding child-only input.
SQLite migration coverage checks the expression index and unchanged records.
Real Git tests cover recency from existing conversation/ownership data. Production
browser fixtures cover grouped sidebar navigation, the readable current checkout,
five linked worktrees, Show all and selection of older worktrees.

Local qualification: `npm run check` passed 1,391 tests (41 gated skips); all 58
browser cases passed using `PLAYWRIGHT_BROWSERS_PATH=/tmp/harness-playwright-browsers`.
The tool sandbox exposes an empty read-only `/tmp/.git` marker that confuses the
real non-Git RPC fixture. Fresh unrestricted qualification on October 18 confirms
that marker is absent outside the sandbox and the default `npm run check` passes
(1,686 tests, 41 gated skips). Rerun unrestricted before attributing this failure
to product Git discovery.

Run real Docker qualification with:

```sh
HARNESS_DOCKER_INTEGRATION=1 npx vitest run packages/sandbox/src/docker-guardian.integration.test.ts packages/sandbox/src/worktrees.integration.test.ts packages/sandbox/src/docker-sharing.integration.test.ts
HARNESS_DOCKER_INTEGRATION=1 npx vitest run packages/server/src/worktrees.test.ts
HARNESS_NATIVE_INTEGRATION=1 npx vitest run packages/sandbox/src/worktrees.integration.test.ts
```

Docker/Compose cases passed six scenarios plus one separately passing real-RPC
scenario. Native Git commit passed separately outside the outer namespace sandbox.
The fixtures isolate homes, Git configuration, Docker client configuration and
ownership; they never reuse the development profile or credential store. Tests
wait for actual lifecycle state. Images/build cache may remain, while fixture
containers/networks are removed. Named volumes follow product retention policy.

Windows translated Git-link behavior is exercised with real Linux containers;
actual Windows Docker Desktop mounts/transport remain unqualified. Compose uses an
explicitly built fixture image to avoid upstream Bake's generated-Dockerfile
filesystem entitlement issue. The product still uses the devcontainer CLI.

## MAI feedback capture

`server/src/feedback.test.ts` exercises real RPC/SQLite capture against a temporary
HTTP receiver: disabled configuration, queued offline delivery, explicit retry,
stable case identity and exclusion of opaque artifacts. Core engine regressions
check per-output attribution through buffered middleware and concurrent attempts
using the same request object, plus existing context-build and stable logical-call
identity guarantees. OpenAI adapter capture occurs after native request rendering.
All fixtures use temporary homes and deterministic providers. Native clicking of
the new desktop controls and live teacher/training/serving requests are not
established by these tests. MAI's separate browser fixture covers review through
a frozen dataset and unsubmitted training preview.

The feedback RPC regression also covers a final-message vote exposing earlier
actual decisions, parallel sibling outputs retained when voting on the first
call, unavailable historical invocation linkage, cross-branch rejection, opaque
artifact exclusion, and byte-limited native-input omission. A 35 MB stored earlier
input cannot break an otherwise small vote; the backfill RPC stays below 3 MiB.
No provider, tool replay, running shared server, or desktop is started by this test.

Earlier-decision capture validation: typecheck, lint, formatting and diff checks
passed; the full Vitest suite passes with `TMPDIR=/var/tmp` (1,394 passed,
41 gated skips). The default tool environment injects an empty `/tmp/.git` marker,
causing the unrelated `server/src/worktrees.test.ts` Git-discovery failure. The
same regression passes unchanged with the alternate temporary directory; no
product assertion, timeout or worktree implementation was changed to mask it.

Custom-provider model display labels: optional model-scoped labels flow through
existing ModelInfo catalogs while preserving opaque model IDs for configuration,
validation and API calls. Three transport-boundary regressions cover readable
labels and rejecting labels used as IDs. Full check passes 1,397 tests with 41
gated skips, plus typecheck/lint/format. The first sandboxed run could not create
Vitest's /var/tmp workspace; rerunning outside the sandbox with TMPDIR=/var/tmp
passes. Dev Qwen base and MAI investigation-test entries use readable labels and
normal stored credentials; user controls restarting Harness, so live desktop
label visibility is not claimed.

## Conversation routing and chat terminal tails

`packages/custom-providers/src/session-routing.test.ts` checks configured session
headers over real local SDK HTTP requests on all three compatible transports,
including concurrent conversations and a repeated call. Go's session-routing
suite checks its existing headers and shared OpenAI cache keys. LiteLLM provider
and Mistral provider tests check their native routing headers. OpenAI request tests
check cache keys; custom-provider integration verifies durable single tool
execution and usage when a terminal choice repeats. Chat stream regressions keep
original truncation/malformed errors and reject output/conflicting finishes after
completion. These fixtures establish wire behavior, not upstream cache hits or
capture of the user's failed OpenRouter SSE. No paid generation was made.

The 2026-10-16 session-routing follow-up was checked outside the sandbox using
Node 24.21.0, `TMPDIR=/private/tmp`, and `npm run check -- --maxWorkers=2`.
Typechecking, lint and formatting pass; 1,408 tests pass and 63 skip. The same two
previously documented failures remain: the QuickJS runaway-loop timeout and the
TUI OAuth overlay fixture. No timeout or assertion was changed. Three independent
read-only reviews are complete. Installed non-development activation remains
pending; its older strict schema cannot yet accept `sessionIdHeader`.

## Source desktop native build

`connections/src/native-build.test.ts` runs the real build script in a temporary
checkout fixture, substituting the Cargo/target edges. It checks recovery of a
missing addon, fresh-file publication using a retained hard link, preservation of
the prior addon when copying fails, and temporary-file cleanup. On macOS, the real
`npm run desktop:dev --workspace @harness/desktop -- --help` path restored the
missing addon without starting the desktop or a server. Loading `@harness/native` under
Node 26.9.0 and checking its code signature both succeeded. This is startup
preparation evidence, not a visible app walkthrough or Windows loaded-file test.

Full validation for this correction used the user's Node 26.9.0 outside the
sandbox with `TMPDIR=/private/tmp npm run check -- --maxWorkers=2`. Typechecking,
lint and formatting pass; 1,408 tests pass and 63 skip. Three failures remain:
the documented QuickJS/TUI OAuth fixtures and the existing captured-runtime test.
That test copies only the Homebrew Node executable, which cannot run at the new
path without `libnode.147.dylib`; it does not test the source desktop launcher,
which retains the original executable path. No assertions or timeouts were changed.

The subsequent v0.1.21 release workflow
([38918810170](https://github.com/usatiuk/harness/actions/runs/38918810170)) passes
the full Ubuntu/Node 24 source gate: 1,430 tests pass and 44 skip. Windows, Linux
and macOS artifact builds and signed metadata/updater verification pass. All 19
assets are published. Production native verification of the downloaded manifest
passes; anonymous manifest and latest-updater-feed reads return HTTP 200 and
version 0.1.21. This does not establish installed desktop update execution or
upstream cache-hit behavior.

## Desktop route persistence

`desktop/src/route-persistence.test.ts` exercises the real memory router with
120 idle-fetcher disposals (the virtualized fork-button cleanup path), 40
background action submissions and repeated revalidation. These same-URL updates
must cause no additional storage or browser-history writes. Navigation coverage
includes conversation changes, Settings queries, same-URL replacement, back,
redirects, unsubscribe and per-host remounts. Browser history is substituted to
count writes; actual native WebKit scrolling and its history rate limit remain
unqualified by this regression.

Validation on October 16: both focused regressions pass. `TMPDIR=/var/tmp npm run
check` passes typecheck, lint and formatting; Vitest reports 1,434 passed, 41
skipped and one failure in the previously documented TUI OAuth fixture
(`cli/src/hosts.test.tsx:314`, waiting for the initial active conversation).
Running that test file separately reproduces the same failure (four tests pass).
Its root cause remains unestablished; no TUI assertions or timeouts were changed.
Three independent read-only reviews report no blocking findings.

## CI and local fixture recovery

The [October 16 recovery plan](plans/process/2026-10-16-ci-and-local-test-recovery.md)
records the first failing Windows run and each established cause. Fixture roots
are physical paths where APIs intentionally canonicalize identities; shell roster
assertions use PowerShell on Windows. The startup-diagnostic fixture uses the
production home creator instead of precreating a potentially foreign-owned
Windows directory. Output coverage checks native separators and full spilled bytes.

The TUI OAuth fixture uses a marked temporary workspace alongside its substituted
credential home and waits for the actual conversation UI before sending keys.
This prevents the developer account's global settings from becoming a project
layer after `HOME` substitution. The captured-runtime consumer test executes the
captured Node in place, preserving Homebrew dynamic-library linkage; separate
prepared-server tests already verify retention of a distinct captured path.

QuickJS retains its original one-second cumulative interpreter budget and test
timeouts. It processes at most 256 pending jobs before yielding, with a new
regression proving host replies can settle during continuous guest microtasks.
The recovery plan distinguishes a controlled scheduler-delay experiment from
native macOS evidence.

Local `npm run check` with ordinary temporary-directory defaults passes:
1,436 tests, 41 gated skips, typecheck, lint and formatting. The native CI command
passes 11 Rust tests. Three independent reviews found no remaining blocking
issues after removing an ineffective Git-ceiling fixture setting. Hosted Windows
verification and a native macOS rerun remain pending; these local results are Linux
with Node 24.21.0.

The first hosted recovery run passes Ubuntu and all 14 original Windows failures.
Windows then reaches an aggregate five-second timeout in the diagnostic fixture,
which combined home/runtime setup with three real startup attempts and their
PowerShell security checks. Fixture setup/cleanup now uses hooks; repeated-start
and 8 KiB bound scenarios are separate tests with every original assertion and
unchanged timeouts. Full local validation after that split passes 1,437 tests
with 41 skips; repeat Windows qualification is pending in the recovery plan.

Hosted recovery verification passes on both Ubuntu and Windows in
[run 38971442846](https://github.com/usatiuk/harness/actions/runs/38971442846)
for `3475025`, including the full `npm run check` and native Rust steps. The
original 14 Windows failures and the subsequent aggregate diagnostic timeout are
resolved. This establishes actual Windows fixture/security-path execution in CI;
it does not establish native macOS or desktop UI qualification.

The 2026-10-17 Windows runs
[39028819095](https://github.com/usatiuk/harness/actions/runs/39028819095) and
[39029850007](https://github.com/usatiuk/harness/actions/runs/39029850007) time out
only the selected-host Settings test after it expanded from four to six edits.
The next unchanged-test
[run 39030716392](https://github.com/usatiuk/harness/actions/runs/39030716392)
passes, but that test takes 24.77 seconds against its 30-second deadline.
The logs show continuing per-key React flushes for roughly 23 seconds after
startup. Cursor movement and deletion now emit individual stdin events in one
React batch per run of keys, preserving real Ink input, all save/clear RPC
assertions, and the 30-second deadline. Menu navigation, replacement text and
submission retain separate flushes. A one-CPU Linux probe of the original test
passes in 4.94 seconds; it does not reproduce the hosted timeout or establish its
exact final edit. All five host scenarios pass locally after the correction. Full
`TMPDIR=/var/tmp npm run check` passes typechecking, lint, formatting and 1,477
tests with 41 gated skips. Three independent reviews report no actionable
findings. Actual Windows qualification is required to confirm the platform result.

Sidebar browser coverage checks folder-name/nested-chat text alignment, minimum
width overflow, row clearance from the native scrollbar before/after hover
and its 2px outer inset,
selection screenshots in both themes, and the 14px conversation
default with saved size overrides. Markdown measurements wait for live geometry and query the current cell from
the stable document body in one synchronous snapshot: virtualizer replacements
were observed detaching a previously resolved cell and briefly removing it. Native
Windows/macOS material rendering still requires a native application check.

A fixed-width custom scrollbar was rejected during visual review. The final
sidebar keeps native scrollbar sizing/interaction, a transparent track, and
20px of inner clearance so expanded overlay scrollbars have room on hover.

Composer browser checks verify that statistics render below the input only when
enabled and that disabling them restores the composer’s lower position. The
keyboard hint and redundant status label are absent. The simple fade retains
dock clearance, stream follow, reading pause/jump behavior and tool-expansion
clearance.

Transcript selection coverage selects document text, checks that composer control
and sidebar labels are excluded, and verifies native select-all in the draft. The transcript
container is bounded to the chat column so block selection cannot fill the wide
canvas gutters. The fade remains behind the composer, with a softer transition
that reaches solid inside its rounded top corners.

The Ctrl/Cmd+A regression also reproduces the remaining sidebar selection
(`Settings` and the host name) before applying nonselection to the sidebar
container; the corrected case excludes both while retaining transcript and draft
selection.

Final local validation passes `TMPDIR=/var/tmp npm run check` (1,477 tests,
41 gated skips), seven focused browser cases, and three independent review
lenses. Default-preserving appearance persistence is deferred to
[issue #46](https://github.com/usatiuk/harness/issues/46).

Disclosure browser regressions check shared height/opacity animation, keyboard
activation, reduced motion, lazy unmounting, native exclusivity at both levels and
40vh outer-only Work scrolling. Scroll-shadow checks exercise top/middle/bottom
states and removal after content collapses in both sidebar and Work containers.
A pixel comparison over opaque Work output verifies that its shadow is painted
above code blocks, rather than hidden behind their background.
Keyboard tests wait for a visible summary: Virtuoso measurement copies can have
nonzero geometry while still hidden and unable to receive focus. Native test
selectors have been updated for inline groups and wrapped rows, but native
Windows and macOS/WebKit rendering remain unqualified by these Chromium checks.

The disclosure/shadow follow-up passes the full local check (1,477 tests, 41 gated
skips) and 72 of 73 Chromium cases. The remaining idle-history-anchor failure was
also reproduced twice against committed HEAD in an independent in-memory build;
its drift remains an existing canvas qualification gap, without relaxed assertions
or a workaround in this change. Native Playwright discovery finds 28 tests; native
execution remains unverified.

Intermediate action coverage checks right-side placement at normal/narrow widths,
hover/focus, Copy and phase-based placement; final assistant and user actions stay
below. Selection uses a nonselectable desktop default with explicit content opt-in.
The regression selects whole paragraphs in user/assistant messages and tool output,
checks selected content, and compares pixels in empty action rows, user-bubble
bottom padding and beside the bubble. Restoring the former selectable transcript/action styles reproduces
the stray blue row in GTK WebKit; an unclipped user bubble independently reproduces
horizontal spill. The corrected policy, selectable inline user text and bubble clipping pass those
comparisons in six Chromium and five GTK WebKit cases.
Worked/history labels stay unselected. GTK engine checks use a virtual display and
temporary libraries, not the native Harness runtime.

## Subagent inspection regressions

The shared store contract checks scoped plugin-state paging and latest terminal
turns in both stores. SQLite checks schema-11 parent-scope backfill and index use.
Subagent tests cover parent-supplied names/slugs, concurrent duplicate rejection,
persistence across registry replacement and independent parent namespaces.
Real in-process RPC checks nested running counts, paged children, retained
completed/failed/stopped outcomes, legacy names, reconnect, history and rejected
client delivery/reconfiguration. A desktop-session case opens a currently running
child and verifies its own live state, identity and finalized transcript while
retaining the parent. Unobserved descendants must not accumulate event backlogs.

Production-route browser cases cover the header count/icon, paged popover tree,
expanded nesting without collapse controls, retained statuses, child navigation/breadcrumb and omitted
mutation controls. Empty popovers have no horizontal overflow at 420px and 1440px;
the popover owns one thin transparent-track scrollbar. Native desktop interaction
and live-provider acceptance are not established by these controlled tests.

October 17 subagent inspection validation: `npm run check` passes 1,487 tests
(41 skipped). Chromium passes 78 of 79 browser cases; the earlier-history reading
anchor case shifts 12px and reproduces against the pre-change `3561ae8` sources.
The cause remains unestablished and no test assertions/timeouts were weakened.
All three subagent cases also pass in GTK WebKit under an isolated virtual display.
The delivery plan records review fixes and native/live-provider qualification limits.

Subagent communication follow-up: the full check passes 1,492 tests (41 skipped).
The model roster is family-scoped and bounded; real service regressions cover
busy delivery, waking finished recipients, recursive dismissal with direct-parent
messages always permitted, slot reuse, four concurrent admissions under a
three-child limit and depth two. A real background tool completion wakes its
finished, dismissed owner through the captured plugin delivery context. SQLite
reopen verifies durable dismissal, filtered model roster and preserved inspection.
Directly opening an old child resolves its canonical root before attachment;
closing that root removes the loaded child. A core test rejects adoption during
an old standalone root's teardown, then verifies later adoption and cleanup.

Desktop session tests verify turn events refresh subagent presentation without
activity events. Browser checks verify completed parents with running descendants
stay under Running, full clickable ancestry, activity owner chains, a 22px Stop
and GUI limit submission. The existing TUI host editor persists both limits
through real server RPC. All five affected browser cases pass in GTK WebKit.
Full Chromium passes 80 of 81 cases; the only failure remains the same baseline
12px history-anchor shift described above. Native desktop and live-provider
execution are not established by these controlled fixtures.

Explore profile follow-up: the built-in catalog regression verifies that both
general and explore omit a tool allowlist; explore's read-only role is
prompt-directed. Explicit custom allowlists still pass through child creation.
The 14 focused subagent tests pass.

## Async questions

`packages/service/src/questions.test.ts` exercises question lifecycle and durable
answer ingestion with real SQLite. `packages/server/src/questions.test.ts` covers
public RPC snapshots/events, reconnect, multiple clients, answer validation,
comment-only answers, and first-response-wins retries. CLI overlay tests cover
freeform, clearable selections, multiple questions, and dismissal; App coverage
checks questions survive turn completion while the composer remains available.
Six Chromium browser regressions exercise mixed batches, comment-only answers,
clearable single selection, multiple selections, visible errors, retry, dismissal,
issued questions in read-only child views, draft-preserving hide/show, and
Back/Next navigation, and individual skips within a mixed batch. SQLite service
tests verify explicit skips survive restart and all-skipped batches are accepted;
TUI coverage verifies skipping one question while answering the next. Layout checks verify the current five-option question fits
without nested scrolling at 1174×887 and 900×650. Final full validation passes
1,520 tests (41 skipped). Ink input tests flush React effects before sending keys
so a visible frame does not race passive input-listener installation.
Native desktop and remote-terminal interaction remain unqualified unless separately
recorded in the async questions delivery plan.

## Image input v1

Protocol image tests cover media signatures, invalid base64, per-image and combined
2 MiB decoded limits. Service tests send image-only input through public RPC,
verify a large item's chunked history bytes, reconnect, reopen SQLite, and ensure
canonical tool images reach the next model request. The fixture has a 128k context
window to exercise preliminary context estimation. Text-only adapter rejection
happens before user-input acceptance. Local execution tests cover bounded ranges;
workspace tests cover both file dialects and explicit image line-range errors.
MCP tests use a real stdio fixture and computed forwarding. Code-mode tests cover
images exceeding the former text/bridge limits, structured metadata, cumulative
image bounds, and unchanged text limits. Output spilling preserves images.

Provider request fixtures cover native Responses/Anthropic/Gemini 3 payloads and
Chat/Mistral/older Gemini projections after parallel result batches. They establish
serialization and canonical-history preservation, not live vendor acceptance.
Desktop browser cases exercise paste/drop, image-only delivery, previews/viewer,
image-click retention, empty-space dismissal, initial viewer focus, single-Escape
dismissal and trigger-focus restoration, drafts, delivery races and history;
helper tests reject oversized batches before
FileReader allocation. Native OS clipboard/drag-drop and remote execution image
reads require separate platform qualification and are not established by fixtures.

Model metadata follow-up regressions cover true/false/unknown public round trips,
Mistral API/Vibe aliases, LiteLLM agreement/conflict handling, Models.dev live and
snapshot modalities, and documented image support in the Anthropic roster. The public RPC
switch test accepts the model change, rejects a known text-only request with
active images, preserves history, permits unknown metadata, and resumes text-only
requests after an ordinary compaction summary boundary. This fixture does not
claim live model summarization or vendor acceptance.

Completeness audit adds an authenticated Codex transport regression using the
actual OpenAI SDK and substituted OAuth/fetch edges. It checks user/tool inline
images, Codex URL/account/auth headers, stream completion and unchanged canonical
input. Maintained provider catalog claims and custom supportsImages true/false/
unknown/configuration precedence have focused regressions. Gemini discovery
excludes documented audio-only transcription models even when generateContent is
advertised. These fixtures still do not establish live account/vendor acceptance.

## Linux image input regression

The initial browser tests injected ClipboardEvent/DragEvent File payloads and did
not qualify OS integration. Controlled real-paste probes in WebKitGTK 2.52.6 show
empty DOM Files, but standard `navigator.clipboard.read()` inside the trusted paste
gesture exposes screenshot PNG bytes and copied-file URI-list blobs. File-URI
fetch fails in that WebView, so the existing bounded desktop file reader handles
those URIs. Native clipboard readers and dependencies have been removed.

The browser helper regressions cover bitmap bytes, copied file URIs, permission
failures, unsupported content and the aggregate image budget. Native file-reader
tests cover exact bytes, size limits, directories, URI decoding and remote URI
rejection. Detailed audit history and validation counts live in the
[delivery plan](plans/cross-cutting/2026-10-17-image-input.md).

Run the focused actual-app regression with a default development native build and
project Vite listening on 1420 (the ordinary desktop development setup):

```sh
cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml
npm run dev --workspace @harness/desktop
# In another terminal:
python3 packages/desktop/tests/native/linux-images.py
```

It requires Python GTK3/GdkPixbuf bindings, Xvfb, XTest, dbus-run-session, and the
repository Node dependencies. It creates an isolated display, session bus,
clipboard, profile and fixture model; it stops only captured test owners. Actual
Controlled GTK clipboard owners advertise PNG/JPEG file URIs and PNG bitmap
content. A JPEG-only native bitmap case verifies an explicit error with existing
attachments preserved, because WebKit exposes no readable representation. Actual
OS keyboard/mouse gestures paste supported content, preserve text/URL paste,
drag a file over the transcript, use the native
paperclip chooser, and send five images. Inspector reads assert visible previews;
The HTTP fixture compares known PNG/JPEG file bytes, decodes screenshot PNG
pixels and checks dimensions/color. SQLite image data must exactly match model
payloads, including order/MIME/base64; client paths remain absent. Browser chooser
regressions render PNGs with normal, empty and generic file MIME metadata. The
public file-tool regression changes format between reads and checks rejection.
Artifacts are retained under the printed /tmp directory. It does not reuse the
Windows native driver or add product test controls.

Run the remaining native file-reader tests with:

```sh
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml image_input
```

The browser pending-FileReader regression leaves and reopens a chat before read
completion, verifying read-state and resulting images stay visible. Provider
regressions cover mixed historical custom/function calls in both orders and
hoisted context interleaved with image results. Native qualification here is
Linux X11/WebKitGTK; Wayland and native Windows/macOS remain separately unqualified.

## Portable tool inputs and manual model metadata

`packages/core/src/tools.test.ts` checks JSON fallback schemas, strict wrapper
validation, shared custom parsers, and omission of unsupported grammar constraints.
`packages/service/src/code-mode.integration.test.ts` exercises plaintext/JSON eval
and JSON patch execution with immutable wire arguments through the real service,
workspace tools and evaluator. Existing nested-tool tests continue to cover
approvals, denial, scope, cancellation and output preservation.
Provider tests cover manual catalog additions/overrides, native generation controls,
explicit empty preset lists and conservative defaults. Gemini's SDK fixture also
checks configured reasoning overrides after discovery;
Codex tests mock subscription-authenticated catalog HTTP, parsing, cancellation,
limits and failure classification. OpenAI request tests preserve structured calls
when the current tool encoding changes. Full checks do not establish coding-quality
parity between patch and replacement, or actual remote Codex catalog availability.
No new paid provider calls are part of this validation.
