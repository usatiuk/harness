# Testing

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

## MCP and shared human approvals

`packages/mcp/src/{mcp,oauth}.test.ts` uses the real official SDK across stdio
processes and loopback HTTP. It covers public direct/code calls, schema/result
adaptation, startup isolation, pagination, invalid catalogs, no replay after
ambiguous disconnect, cancellation, permission inheritance, scoped children,
credential target binding, redaction, resource-header isolation, and OAuth
DCR/metadata clients/PKCE/refresh/restart/cancellation/expiry/logout.
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

## Managed runtime and release foundation

Source CLI, Tauri development, Vitest and `npm run check` use ordinary Node/npm.
Use `.nvmrc` and run `npm ci` so native dependencies share the selected Node ABI.
Stop source processes before reinstalling/rebuilding loaded native modules on Windows.
Source CLI and Tauri use `.harness-dev/source` unless `HARNESS_HOME` is set;
packaged development uses a separate home and immutable payloads.
Installed apps and deployed remote servers use the shared downloaded runtime. Native
bootstrap/launcher tests use `cargo test --manifest-path native/Cargo.toml`.
Desktop helper tests use `cargo test --manifest-path
packages/desktop/src-tauri/Cargo.toml`; those command modes run before window setup.
These are headless checks. Visible native E2E requires approval for each run.
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

The manual `Test published release` workflow executes downloads, installers and
CLI updates only on GitHub-hosted Windows, Ubuntu and both macOS architectures.
It runs outside the checkout, checks two published CLI versions, preserved SQLite
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
independent interruption, primary labels, IME guards and disconnected behavior.
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

- The `opencode-go` provider's roster is static and unit-tested against the
  2026-08-09 gateway-list and Models.dev metadata snapshots: documented family
  assignments (including Grok chat and GPT Luna Responses), exact model-scoped
  preset catalogs, validation, and Chat/Responses/Messages request mappings. Live
  smoke (one preset request per transport family and a preconstructed tool-call
  continuation shape with prior reasoning) is opt-in behind `OPENCODE_API_KEY`
  and is not run in CI. A credential-gated two-request encrypted-reasoning replay
  remains uncovered.
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
