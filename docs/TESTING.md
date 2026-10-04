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
npx vitest run path/to/test.ts   # focused test file
npm run typecheck                # root, CLI, and desktop TypeScript projects
npm run lint                     # ESLint
npm run format:check             # Prettier verification
npm run check                    # complete local and CI validation
npm run test:native              # build and exercise actual Windows Tauri app
npm run test:remote              # bundle and exercise isolated real SSH; WSL is opt-in
npm run desktop:build            # release executable and NSIS installer
```

## Shared-server delivery

Public RPC regressions in server/src/shared-server.test.ts qualify multi-client
approval decisions, disconnected accepted/queued work, fresh reconnect without
partial stream suffixes, failed second-client attach, shared detachment and request
drainage. Real-process tests in server/src/background.test.ts qualify simultaneous
startup, unauthorized rejection, zero-client pending approval and completion,
bridge-parent exit, crash/stale discovery, canonical-home reuse, copied-home
isolation, unsafe existing homes, initialized-client stop and classified startup
failure. A real bridge against an authenticated paused receiver verifies EOF
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
Local cache regressions cover Windows-only dependency invalidation and execute
real SQLite with its sibling dependencies from a temporary cache outside the
checkout. The latter also deletes the input payload and executes the cache again.
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
The subsequent complete native run passes 18 of 20 cases, with another
dependency-promotion EPERM and an uncaptured background-case startup timeout. A
standalone copy/promotion probe reproduces a temporary Windows rename denial:
source exists, destination is absent, ACLs allow modification, and the unchanged
rename succeeds after read-only diagnostics. The process responsible remains
unknown. Fresh dependency publication now retries that unchanged rename once
after 100 ms for Windows EPERM, under the install lock, only while its source is
a directory and destination absent. Public preparation tests execute the copied
Node with its cached dependency after temporary failure; persistent EPERM and
first-attempt EACCES reject without partial publication, then recover on fresh
preparation. Source/destination guard edge cases remain untested separately.
The final rebuilt suite passes all 20 cases (3.9m); this does not establish the
causes of earlier uncaptured startup timeouts or typed-TUI input loss.

`npm run test:remote` requires Docker and OpenSSH on the controlling client. It
creates a loopback-only SSH container, ephemeral key, verified known-host entry
and private client configuration, then removes the fixture. Set
`HARNESS_REMOTE_WSL=Ubuntu` to also qualify that installed distribution. Each case
uses a unique remote home/runtime directory and explicitly shuts down its existing
owner before cleanup. The target needs network access for the initial Node/dependency
installation. Fixture HOME/PATH are substituted at the process edge; production
connection entries expose no home or executable override. These tests exercise real managed deployment, development bundle
changes, cache reuse, target Node resolution and reconnect. With WSL enabled they
also run the rendered TUI conversation flow. GUI interaction is qualified by the
native suite; provider sign-in and every interrupted-install path are separate.

## Desktop native tests

### Design playground

The [desktop design playground](../packages/desktop/playground/README.md) consumes
production controls/tokens with isolated sample state. Its own `npm run check`
covers formatting, JavaScript syntax and frontend build,
while root lint/formatting also include its source. Browser inspection exercises
its controls, portals, themes, narrow layouts and preview states. It does not
connect to the server and does not qualify production or native desktop behavior.
The [design plan](plans/interface/2026-10-04-desktop-design-system.md) records
browser evidence, production qualification and remaining checks.

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
desktop.spec.ts suite has fourteen passing current-owner cases; connections.spec.ts
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

The 2026-10-04 design refactor's final repository check passes typecheck, lint,
formatting and 1016 tests (117 files; 36 skipped). Its rebuilt ordinary native
suite passes 23 cases with the two WSL opt-ins skipped (4.3m). A separate final
`HARNESS_REMOTE_WSL=Ubuntu` run passes both real WSL cases (42s). Frontend and
playground builds pass, and three independent reviews report no remaining material
findings. The plan records failure investigation, correction reruns and native
screenshots; release installers, other native platforms, screen readers and live
credentialed OAuth remain separate qualifications.

The auto-approver scenario saves a reviewer model/preset in the actual GUI,
verifies that model performs review before a real shell tool executes, changes
the global reviewer and observes the next review in the same loaded conversation
use the new model/preset without changing its main model, then switches off auto
approval and observes human approval.
Restart and resetting to the conversation model establish persistence and clearing.

`HARNESS_NATIVE_EXECUTABLE` can select a staged release executable for the same
suite. It must have its packaged `server/` resources beside it.
`HARNESS_NATIVE_PATH` overrides only the native application's PATH, leaving the
test runner's environment intact. Windows release
qualification must launch outside the source tree with no system Node on PATH;
a debug build or browser-only test is not packaged-app evidence. macOS/Linux
desktop installation and live external OAuth sign-in remain unqualified.

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
