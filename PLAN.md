# Harness plan

The [model metadata and portable tool-input refactor](docs/plans/cross-cutting/2026-10-18-model-tool-inputs.md)
is complete: independent editing preference/custom-input support, shared JSON
fallback, manual model configuration on every provider, and scoped Codex catalog
discovery. Three independent review lenses are resolved; 1,671 tests pass with 41
skipped. Typecheck, lint, and tracked/task-file formatting pass; the delivery plan
records the unrelated untracked formatting blocker to `npm run check` and remote
qualification limits.

The [sandbox context and presentation follow-up](docs/plans/cross-cutting/2026-10-18-sandbox-context-and-message-presentation.md)
delivers persistent native command temporary storage, active sandbox instructions,
phase-free message presentation and the `none` backend rename/native default.
Full checks pass 1,623 tests; real Bubblewrap and focused headless Chromium/WebKit
checks pass. [v0.6.0](https://github.com/usatiuk/harness/releases/tag/v0.6.0) is
published as latest; Windows/Ubuntu CI, three platform builds and signed public
metadata verification pass. Phase data and OpenAI replay are preserved.

The [image-input v1 plan](docs/plans/cross-cutting/2026-10-17-image-input.md)
delivers inline images, previews/viewer, file/MCP ingestion and existing-provider
request mappings, plus model image metadata and next-request validation. A
browser-first simplification is complete: real WebKitGTK probes established
that standard asynchronous clipboard reads recover image bytes and copied-file
URIs. Native clipboard readers and dependencies are removed; the bounded local
file reader remains for explicit URIs and proven Tauri drop integration. Final
regression checks pass 1,605 tests / 41 skipped, six focused Chromium cases, and
the actual Linux five-image pipeline. Three independent cleanup audits are complete.
Three subsequent review fixes are validated by 1,606 tests / 41 skipped, eight
browser cases and native byte/pixel/persistence comparisons. These changes are
released in [v0.4.0](https://github.com/usatiuk/harness/releases/tag/v0.4.0). Hosted
Windows/Linux CI, all three platform builds, release signatures and anonymous
manifest/update-feed downloads pass; the delivery plan records exact evidence.

The [desktop streaming performance refactor](docs/plans/interface/2026-10-17-desktop-streaming-performance.md)
is complete: scoped UI subscriptions, a 100 ms text/reasoning publication cap,
stable transcript rows and lazy expensive rendering. Full checks pass 1,518 tests;
Chromium passes 87/89 with two baseline-reproduced history-anchor failures.
Measured work reductions and native-performance limits are in the delivery plan.

The [subagent inspection follow-up](docs/plans/interface/2026-10-17-subagent-inspection.md)
adds parent-named task identities and a header popover tree of durable child
conversations with read-only live inspection. Full checks pass 1,487 tests;
Chromium/WebKit coverage, independent reviews and the pre-existing history-scroll
limitation are recorded in the delivery plan.
The same plan tracks family-scoped list/send/dismiss tools over ordinary plugin
input, configurable depth/roster limits in GUI/TUI, full ancestor headers,
Running/Finished tree sections and compact activity controls with owner labels.
Full checks pass 1,492 tests; Chromium passes 80/81 with the same baseline
history-anchor failure, and all five affected GTK WebKit cases pass.
The built-in explore profile now has no tool allowlist; its prompt directs
read-only research through available tools, including web search. Custom agent
tool scopes remain supported.

The [disclosure presentation follow-up](docs/plans/interface/2026-10-17-disclosure-animation.md)
shares grid/fade animations, keeps compact Work peeks, caps outer scrolling at 40vh
and adds transparent edge shadows to Work and sidebar navigation. Validation is
tracked in the delivery plan.

The [Work-group presentation cleanup](docs/plans/interface/2026-10-18-desktop-working-group-collapse.md)
folds earlier groups at every size, preserves the latest tail across expansion,
and uses uniform reasoning rows with inline previews. Review fixes preserve open
details during streaming, bound tool widths, and prevent scrollbar width shifts.
Full checks pass 1,606 tests; focused browser/native-WebKit regressions pass. The
follow-up prevents virtualizer-remount entrance animations and uses inline latest
streaming previews with label-only expanded summaries. Its nine Chromium and
four GTK WebKit regression cases pass. The delivery plan records the pre-existing
history-anchor failure and visual limits.
These desktop fixes and the explore-profile update are released in
[v0.5.0](https://github.com/usatiuk/harness/releases/tag/v0.5.0). All three platform
builds, signed metadata verification and fresh Windows/Ubuntu CI pass; public
metadata downloads verify after publication.
The reasoning-preview follow-up replaces character-sliding suffixes with two
lines that fill and advance by whole wrapped lines. All three focused headless
Chromium/WebKit cases and full checks (1,606 tests) pass; the same delivery plan
records qualification and baseline GTK alignment failures.

The [worktree project/picker follow-up](docs/plans/interface/2026-10-17-worktree-project-picker.md)
groups conversations by original project before pagination and gives the picker
a readable current checkout, five recent worktrees and separated Original/New
actions. It derives recency from existing conversation/ownership records.

The [worktree branch naming follow-up](docs/plans/interface/2026-10-17-worktree-branch-names.md)
adds optional tool-supplied branches, readable generated names with collision
handling, and a picker refresh on opening. Git remains the naming authority and
checkout paths remain stable; no naming or rename GUI is added.

The [eager tools and name inventory follow-up](docs/plans/cross-cutting/2026-10-17-eager-tools-and-name-inventory.md)
offers all Harness tools upfront and adds a default-on global deferred-name list
with GUI/TUI configuration. Full validation and focused browser checks pass;
the delivery plan records evidence.

The [background-input presentation change](docs/plans/interface/2026-10-17-background-input-presentation.md)
preserves existing delivery origin through history and pending input. Desktop groups
provider activity and plugin input into Working and collapses queued background
messages without changing scheduling or model-facing roles/content.

The [MCP/tool-mode simplification](docs/plans/cross-cutting/2026-10-17-simplify-mcp-and-remove-direct-mode.md)
uses raw prefixed MCP names and code-only MCP exposure. Hybrid and code-only
remain; legacy direct settings load as Hybrid. The delivery plan records
validation and remaining coverage limits.

The [session routing and chat finish follow-up](docs/plans/models/2026-10-16-session-routing-and-chat-finish.md)
adds conversation cache keys, shared provider session headers, and a regression
fix for repeated terminal choices in Chat usage tails. Published in
[v0.1.21](https://github.com/usatiuk/harness/releases/tag/v0.1.21), alongside the
source-desktop native-addon rebuild fix. Hosted source validation passes 1,430
tests with 44 skipped; Windows, Linux and macOS builds and signed-artifact
verification pass. Non-development header-setting activation remains unverified
until a compatible runtime is installed.

The [worktrees and Docker lifecycle plan](docs/plans/cross-cutting/2026-10-15-worktrees-docker-lifecycle.md)
records conversation workspace switching, configurable managed worktrees, and
workspace-owned Docker environments with stop/preserve and crash cleanup.
Implemented with GUI/TUI/agent controls, linked Git support, safe switching and
managed cleanup. Full local checks, browser and real Docker/Compose/native cases
pass; the delivery plan records evidence and native Windows qualification limits.

The [OpenCode Go metadata delivery](docs/plans/models/2026-10-16-opencode-go-metadata.md)
uses Models.dev startup discovery with a bundled offline snapshot, model limits,
labels and qualified reasoning controls. All 32 focused tests and independent
reviews pass. Full validation passes typechecking/lint/formatting and 1,382 tests;
three documented unrelated macOS/test failures remain. Unsupported Go Google
routes remain outside this metadata change.

The [async questions change](docs/plans/cross-cutting/2026-10-17-async-questions.md)
adds one nonblocking question tool, batch choice/freeform forms with comments,
and durable reconnect/restart semantics. Delivered in desktop and TUI; full checks
pass 1,520 tests (41 skipped), and six Chromium question form regressions pass.

## Goals

The [auto-approval revamp](docs/plans/execution/2026-10-11-auto-approval-revamp.md)
keeps the existing YES/NO decisions and adds clearer context plus normal file-tool
inspection in a temporary in-memory review. Final approval annotations and usage
keep their existing form. One configurable deadline covers the review, without
step/read count limits; broader policy/history frameworks are outside scope.
Uses the existing read tool without custom execution backends or model-byte limits.
Live capture found Mistral denying harmless discovery despite the current policy;
the user reports GPT 5.6 Luna works correctly as the reviewer. Judgment remains
model-dependent; evidence and limitations are tracked in the delivery plan.

- **Local-first agency.** Conversations, context, usage, execution, and project
  state remain inspectable and controlled by the local Harness process.
- **Provider independence.** The kernel speaks one model protocol; adapters own
  provider request formats, streaming events, opaque payloads, model catalogs,
  and error normalization.
- **Harness-owned execution.** File, command, approval, sandbox, activity, and
  subagent behavior runs through Harness tools and middleware rather than hidden
  provider-side agents.
- **Durable conversation truth.** An append-only item graph plus a movable head
  supports resume, rewind, compaction, and future branch navigation without
  rewriting history.
- **Additive extensibility.** Providers, tools, middleware, context sources,
  services, policies, and observers enter through the plugin surface; new
  features should not fork the turn loop.
- **Cancellable, observable work.** User input, model calls, tools, approvals,
  background work, and subagents expose bounded lifetimes and typed events.
- **Simple product surface.** Keep the TUI and desktop focused on conversations,
  controls, and inspection rather than an IDE or generalized UI framework.

## Non-goals for the current version

- Provider-owned execution beyond native web search, or opaque provider agent loops.
- Durable resumption of in-flight model streams, processes, approvals, or
  subagents after process exit.
- A general workflow engine, distributed scheduler, or multi-user daemon.
- Full branch management merely because the store can represent branches.
- Provider server state such as `previous_response_id` as conversation truth.
- Web, ACP, parallel TUI presentation, and desktop side-by-side
  views or IDE features.
- Generic compaction pipelines, server-side compaction, or a model-capability
  framework without a concrete implementation that needs them.
- Compatibility preservation for disposable pre-release database schemas.

## System overview

```text
CLI / TUI / Tauri desktop
    ↓ JSON-RPC (in-process or bounded NDJSON stdio)
Harness client ↔ HarnessService server
    ↓
Engine ── PluginHost ── providers / tools / middleware / policies / services
    ↓
Store interface
    ↓
SQLite (production) or in-memory (tests)
```

The primary package direction remains `protocol → store → core → service →
server`, with CLI and desktop over the public client boundary. Feature packages
are plugin contributions wired at the shared server composition
root. They may depend on protocol and narrower feature contracts, but the kernel
does not import provider, workspace, sandbox, approval, activity, or subagent
packages.

## Sidebar delivery

The Quiet labels follow-up is implemented and validated: compact shared controls and
custom dropdowns, Projects-first navigation, 13px configurable text, session-only
unread indicators and credential-fixture isolation. The experimental Linux WebKit
refresh override was subsequently removed; the
[frame-pacing investigation](docs/research/2026-10-12-linux-frame-pacing.md) records
why it is not a demonstrated scrolling fix. The cleanup and shorter composer fade
are published in `v0.1.12`, with all native builds and signature checks passing.
The full check passes (1,327 tests, 38 skips), 47 browser regressions pass and nine
native lib/bin tests pass. The owning sidebar delivery plan records publication
evidence. The follow-up is published in `v0.1.11`; all three platform builds and
signature verification pass. Actual display cadence remains unmeasured.

The [compact sidebar plan](docs/plans/interface/2026-10-12-adjustable-sidebar.md)
adds resizable/hidden navigation, Recents and folder-derived Projects with bounded
server-side recent-input ordering and pagination. Preferences stay desktop-local;
no project entities or synchronization machinery. The sidebar passes the full
check (1,325 tests, 38 skips) and 36 browser regressions. The sidebar and separate
AppImage child-environment fix are published in `v0.1.10`; all three platform
builds and signature verification pass. The released Linux AppImage passes cold
headless preparation through AppRun in an isolated home. Validation evidence is
tracked in the delivery plans.

## Release delivery complete

The startup-error display correction includes the current failed attempt's bounded
log output and preserves that diagnostic on desktop reconnect. Settings formats
remain strict; no configuration migration is added. Source regressions cover the
launcher and reconnect rejection; installed desktop qualification remains open.

`v0.1.7` is published with the Linux AppImage startup correction: home ownership
validation reads the OS effective UID directly instead of spawning host `id -u`,
which failed under bundled libraries in `v0.1.6`. Full checks, native regressions
and all platform builds pass. The exact released AppImage completes cold headless
runtime preparation in an isolated home; the developer profile is untouched.

`v0.1.5` is published for Windows x64, Linux x64 glibc and Apple Silicon macOS.
The requested Intel macOS removal is committed; the four-target `v0.1.4` build
was canceled before publication. The replacement release passes its full source
gate (1,256 tests, 38 skipped), all three builds and signature verification.
Its public manifest/update feed resolve, and standard Rust caches are populated
for all three release targets. Windows/Ubuntu main CI passes at `841d116`.
Implementation is complete. The previously recorded untested platforms remain
coverage gaps; the user explicitly removed them as completion gates on October 11.
Hosted v0.1.3 → v0.1.5 CLI updates and Windows desktop update/restart pass in
`38128269021`, including released SSH upgrade and preserved data. The one-off
published-release workflow and custom RPC harness are removed; keep ordinary
tests and the three-platform build/sign/draft workflow without release-pair tables.

The [release plan](docs/plans/cross-cutting/2026-10-10-release-installation-updates.md)
records the completed one-time halving audit (13,864 to 6,374 added code/test/workflow
lines, relative to MCP main `97eea03`). This is historical evidence, not a permanent
line budget. The source/license inventory, custom publisher/sealer and per-artifact
retention graph are removed. GNU GPLv3 remains the product license.

Installed CLI, desktop and remote hosts share verified downloaded Node and a small
native bootstrap. Ordinary source development uses local Node/npm; source remote
deployment always uses managed Node on the target. Local traffic uses sockets/named
pipes. The replacement uses a simple
GitHub version-bump/build/sign/draft workflow and one cache-use lock for running
consumers. Immutable deployed payloads preserve safe rebuilds. Explicit cache
pruning previews/removes inactive downloads and preserves data. Desktop update
controls use Tauri's official updater; Windows installation/restart passes on a hosted runner.
Connect-time server replacement now reuses the existing lifecycle lock and engine
busy check: idle owners upgrade, active work requires explicit reconnect, and
versions never downgrade. The native CLI update command verifies a signed release,
prepares its CLI/Node and replaces its launcher. The hosted `v0.1.2` workflow passes
all four platform builds and production signature verification, creating one
25-asset release in the public source repository. `v0.1.2` is published; its public
manifest and latest update feed resolve. Installation/update execution on the
user's PC remains prohibited; published-artifact checks run on hosted machines.

The Windows installer report exposes a desktop startup defect across packaged
platforms: the app checked its own obsolete feature instead of Tauri's actual
development/packaged mode. The correction is committed and reviewed. Patched
release `v0.1.3` passes its full source gate (1,216 tests, 38 skipped), all four
native builds and production signature verification. It is now published.
Hosted CLI updates and installed desktop runtime preparation pass on all four
targets in run `38122675683`. Released SSH cold deployment, idle upgrade,
preserved conversations and older-client reuse also pass. The SSH failure was
an inherited GitHub runner ACL, corrected only in the temporary account's setup.
Hosted run `38124352678` also passes signed Windows desktop update installation
and restart. Published WSL2 and macOS/Linux desktop updater execution remain
unqualified; the extra WSL1 fixture is removed.

The current implementation passes the ordinary full check with 1,242 tests
(36 skipped), eleven Windows and ten Ubuntu headless native cases, and fresh
WSL/SSH source deployment checks. Windows and Ubuntu source/headless native CI
pass at `c72f848`. Hosted checks now verify real CLI installation/updates and
installed desktop runtime preparation across all four release targets.
Three independent reviews of the CLI update increment are resolved.
The user authorized publication of `v0.1.5`; local installed-app execution remains
prohibited and visible native tests require separate approval.

The published `v0.1.2` desktop has a startup defect: app-level feature gating
chooses source-checkout paths although Tauri correctly built a packaged app.
The correction uses Tauri's own `dev` cfg and ships in `v0.1.3`; its packaged
runtime preparation is verified on all four targets. The standalone CLI is unaffected.

## Provider and MCP settings delivery

[Provider/MCP settings](docs/plans/cross-cutting/2026-10-15-provider-mcp-settings.md)
is implemented and validated: LiteLLM GUI setup, visible text selection, compact
MCP auth/configuration and safe failure details. Full check passes (1,376 tests,
38 skipped) with six affected browser regressions and three independent reviews.
Gemini's schema-output issue is resolved upstream; no local workaround was added.
Native Windows/GitLab qualification remains explicit in the delivery plan. Changes
are validated; commit, push and release are authorized.

## Recent delivery

The [fork-before-message implementation](docs/plans/cross-cutting/2026-10-13-fork-before-message.md)
is implemented and validated: independent conversations share immutable ancestry,
GUI/TUI actions preload editable drafts, and tool pairing preserves creating-owner
identity. Protocol 11 and SQLite schema 9 carry the fork operation/provenance.
Full checks pass (1,373 tests, 38 skipped), plus six affected browser regressions.
The message-action follow-up adds small hover/focus bars below content (Fork for
user messages, Copy for assistant messages). Three affected browser checks and the
full check pass. Published in [v0.1.16](https://github.com/usatiuk/harness/releases/tag/v0.1.16).
Hosted checks, all three platform builds and signed update metadata verification
passed after correcting the reconnect test's interrupt-completion prerequisite.

The [reasoning/discovery follow-up](docs/plans/models/2026-10-13-reasoning-and-discovery.md)
is validated: LiteLLM advertised effort presets, generic OR-of-AND tool search,
scoped MCP availability hints and essential tools in Hybrid/code-only. Hybrid
remains the shared server's unset-setting default and is labeled consistently in
GUI/TUI. Protocol 10 represents the new metadata/search semantics. Full checks pass
1,360 tests (38 existing skips), 80 focused tests and two scoped browser cases;
three independent reviews report no blocking findings. Commit only is requested.

Inline conversation rename is implemented and validated: a header pencil
appears on hover/focus, reusing server title persistence and events through one
narrow RPC. Enter saves; Escape cancels. Full check passes 1,347 tests (38 existing
skips); browser regressions pass 47 cases with one reading-anchor failure also
reproduced on the clean baseline. Three reviews report no remaining rename
findings. Protocol 9 requires the new RPC. No release is requested.

The Codex working-budget follow-up is validated: assumed input ceilings of
400k normally and 628k for Sol 6.1, 128k output reserve, and no combined-context
claim. API metadata remains unchanged. The global compaction plan records the
assumption and limits of qualification. Focused checks pass 152 tests; the full
check passes 1,346 tests (38 existing skips). Published in `v0.1.15`; all three
native builds and artifact signature verification passed.

The compaction empty-summary follow-up modifies the existing error to include
empty text and returned tool-call count, and makes the automatic prompt summary-first.
The full check passes 1,341 tests (38 skips). Published in `v0.1.14` after all
platform builds and signature verification passed.

The [global compaction threshold](docs/plans/context/2026-10-12-global-compaction-threshold.md)
adds a positive input-token setting to GUI/TUI host defaults. The partial-metadata
follow-up is complete locally: explicit thresholds work without capacity metadata;
automatic thresholds reserve the output maximum plus 2% of usable input. Separate
input/output limits work without a combined context window. Validation passes the
full check (1,339 tests, 38 skips), focused engine/RPC/TUI tests and the isolated GUI
setting regression. The follow-up is published in `v0.1.13`; all three platform builds and signature
verification pass. Existing usage checkpoints, compaction strategy,
and loaded-runtime caching remain unchanged. The original delivery passed 1,316 tests
(38 skipped), plus all 32 browser cases, and was published in
[v0.1.8](https://github.com/usatiuk/harness/releases/tag/v0.1.8) after all three
platform builds passed; detailed evidence is tracked in the plan.

Desktop creation now saves model/preset, sandbox and tool interface to the selected
host's global defaults. It reuses the settings API with partial updates and reads
the saved tool mode on reopening. Full checks pass 1,298 tests (38 skipped) and
all 31 browser cases; unrelated settings and tool permissions are preserved.

The [compact tools and live activities follow-up](docs/plans/interface/2026-10-11-compact-tools-activities.md)
groups desktop reasoning and tool calls behind compact collapsed work summaries,
with flat child calls, Eval boundaries, right-side tool chevrons and failure-only labels.
Active collapsed groups show a quiet, bounded five-line preview. The current
turn keeps its latest work group active between calls, with tool/reasoning entries
interleaved and elapsed completion tied to terminal turn state. The correction
ships in [v0.1.9](https://github.com/usatiuk/harness/releases/tag/v0.1.9), with
1,317 tests passing (38 skipped) and all 33 browser cases passing. Desktop
loads earlier history automatically near the top, and shows only running activities
with automatic one-second output refresh. Subagent previews include streamed
assistant text. Validation and qualification limits are recorded in the
linked plan.

The Linux squeezed-view correction explicitly keeps window content in the expanding
grid row when native decorations or fullscreen hide the custom header. Production
shell/router geometry now fills the viewport and keeps Settings at the sidebar
bottom. The full source check passes 1,256 tests (38 skipped); in-app browser
geometry verifies native, fullscreen and custom chrome. The Playwright CLI browser
is absent, and native WebKit acceptance remains unverified; details are in
[testing guidance](docs/TESTING.md#window-shell-layout).

The [Node 24 and dependency refresh](docs/plans/cross-cutting/2026-10-11-node24-dependencies.md)
aligns source, CI and managed release runtimes on 24.21.0. Compatible dependency
updates clear all 18 audit findings. Prettier 3.9.10 includes mechanical formatting;
Zod remains at 4.4.3 after its newer preprocessing semantics regress MCP client
validation. The final Ubuntu check passes 1,256 tests (38 skipped), ten headless
Rust cases, the source CLI smoke check, Linux remote payload build and desktop
frontend build. Native desktop/install/update execution on other platforms remains
outside this local evidence.

The [Mistral continuation and controls correction](docs/plans/models/2026-10-11-mistral-continuation-and-controls.md)
removes rejected output-entry IDs from stateless input replay, preserves advertised
reasoning efforts, and shortens model choices with dimmed exact IDs and hover
details. Creation now offers model presets. The full check passes 1,247 tests
on pinned Node 22; all 16 headless browser tests pass and three independent
reviews are resolved. Live-vendor and rebuilt native acceptance remain unqualified.
The reported main-integration creation regression is corrected: Default omits the
settings preset rather than sending null, with a `ModelConfig` type check and a
real RPC regression. API reasoning presets use documented known-model metadata;
Vibe remains catalog-driven. Focused tests and the affected headless browser case
pass. Final pinned-Node CI passes on Windows (1,247 tests, 47 skipped) and Ubuntu
(1,256 tests, 38 skipped), including headless Rust checks. Local Node 24 retains
the two known MCP OAuth failures.

The [desktop web search follow-up](docs/plans/interface/2026-10-11-web-search-settings.md)
exposes schema-declared provider settings in the GUI, with native web search enabled
by default and explicit opt-outs preserved. Three independent reviews, 43 focused
tests and two browser cases pass. Main integration preserves both agents' changes
and uses protocol 5 for the changed strict provider-status contract. The combined
Node 22 full check passes 1,251 tests (36 skipped) with two workers; all 17 headless
browser cases and the production desktop build pass. The delivery plan records
the earlier failures and the limits of this source/browser validation.

The [client window chrome follow-up](docs/plans/interface/2026-10-10-client-window-chrome.md)
is complete: one shared title bar, restored Terminal branding and consistent modal
dimming, with platform controls and window mechanics delegated to Tauri/library.
Root checks pass 1,039 tests (36 skipped), ten headless browser cases pass, and all
six rebuilt Windows design cases pass. macOS/Linux packaging remains unqualified.

The [native window material follow-up](docs/plans/interface/2026-10-10-native-window-material.md)
adds Windows Mica and macOS Sidebar material while retaining native title bars
and the accepted layout. The existing System/Light/Dark preference also controls
native chrome and applies before revealing the window. Unsupported platforms
remain solid. Repository checks, ten headless browser cases and all five rebuilt
native appearance cases pass. The client-window-chrome follow-up above replaces
the separate title-bar surface to allow consistent modal dimming.

The [Mistral and session-routing change](docs/plans/models/2026-10-10-mistral-support.md)
adds Mistral API/Vibe API-key connections and OpenCode Go's required session
header. Each conversation keeps its own routing identity across turns and
resume. Its historical validation passed 1,061 tests. The native-search delivery
below consolidates Mistral generation onto streaming Conversations while retaining
these connections and routing behavior. Live Mistral acceptance,
cache-hit performance and subscription billing remain unqualified without credentials.

The [Mistral configured-model follow-up](docs/plans/models/2026-10-11-mistral-configured-models.md)
adds missing IDs and per-ID label/capacity overrides through `config.models` on
both connection types. Its 58 focused tests and three independent reviews pass;
typechecking, formatting, and repository lint pass. The full suite passes 1,240 tests
with two unchanged MCP OAuth failures. The delivery plan records validation limits
and the upstream correction of an initially encountered script lint error. Native
transport,
credentials, and discovered reasoning controls retain their existing ownership.

The [Windows CI reliability follow-up](docs/plans/cross-cutting/2026-10-07-windows-ci-reliability.md)
corrects stale discovery publication, RPC completion at shutdown/EOF and test
prerequisites. The corrected cancellation gate, observer cleanup and attachment
pass cold-start load, full local checks and final source CI on Windows and Ubuntu.
A final documentation push exposes another Windows compound owner-case deadline;
its aggregate cold-start cost is reproduced and its independent scenarios are
separated. A real TCP self-connection regression corrects admission to an absent
listener before authentication. Their Windows and Ubuntu CI pass. A late-candidate
startup lifetime correction also passes full local qualification and process
cleanup; its final hosted run is pending at handoff. The original hosted
cancellation timeout phase remains unknown; failure diagnostics are retained.

The [floating composer and scroll follow-up](docs/plans/interface/2026-10-06-floating-composer-scroll.md)
is complete. It keeps the accepted design while
giving conversations a full-height scrollbar, aligned status/statistics and one
dynamic Send/Stop/Steer action. Steer is the default while working; Ctrl/Cmd+Enter
queues. Stop is labeled Interrupt when input is pending; Escape in the message
box interrupts while retaining the draft, and pending messages run next.
Ten headless regressions, 24 ordinary native Windows cases and two real
Ubuntu WSL cases pass, alongside repository checks and independent review.

Completed the desktop presentation refactor tracked in the
[conversation-first design-system plan](docs/plans/interface/2026-10-04-desktop-design-system.md).
The design prioritizes chat, reveals configuration from composer
chips, and uses reusable controls with neutral surfaces and customizable pastel
accents, including shared tinted button recipes. Settings presents one retained
section at a time; creation, Connections and startup use aligned, focused layouts.
Protocol/SQLite v4 supply authoritative context and last-turn accounting. Root
validation passes 1016 tests; rebuilt native qualification passes 23 ordinary
cases plus both opt-in real Ubuntu WSL cases in a separate run. Three independent
reviews report no remaining material findings. Separate UI-package extraction and
release-installer/other-platform qualification remain deferred.

Completed the [connection boundary corrections](docs/plans/cross-cutting/2026-10-04-connection-boundary-corrections.md):
shared-registry route authority, physical/native drainage, Local cancellation,
failed ownership, safe diagnostics and TUI client/server separation. Typed
contracts and shared configuration sources replace loose results and implementation
barrel imports. Three independent reviews and their follow-ups report no remaining
actionable findings. Full validation passes 998 tests; rebuilt native and real
SSH/WSL/TUI qualification pass five cases each. The existing Local/WSL/SSH product
scope remains unchanged; the plan records an earlier unreproduced Windows EBUSY
teardown observation without claiming a cause or fix.
Post-delivery desktop startup exposed a dependency-cache layout defect hidden by
checkout-local native fixtures. The focused correction and standalone cache
regressions are recorded in the same plan. Windows configuration discovery now
resolves physical account/home aliases; both GitHub CI platforms pass the cache
and configuration corrections. The full local check passes 1006 tests and the
rebuilt Windows native suite passes all 20 cases. A reproduced transient Windows
dependency-promotion denial permits one bounded retry of that unchanged operation.
Desktop stops Local on exit when no other client uses it; keeping Local running is opt-in.

Completed shared background servers and Local/WSL/SSH connections for desktop
and TUI in [the delivery plan](docs/plans/cross-cutting/2026-10-03-remote-hosts-background-servers.md).
Connection editors use the normal account directory and simple WSL/SSH routes;
SSH uses non-interactive authentication and OS-configured aliases. Native desktop
and rendered TUI WSL conversations survive host switching and client exit, then
reattach to the same owner and finish pending work. Managed/development deployment
passes on Ubuntu WSL and isolated OpenSSH. Local retains both browser and device
sign-in; remote hosts use device codes without callback forwarding. Full local
validation passed 976 tests at that delivery. The plan records independent review, scope cleanup,
platform evidence and earlier unreproduced test failures.

The [first-message conversation titles](docs/plans/interface/2026-10-11-conversation-titles.md)
follow-up adds saved display titles and a one-call naming plugin with a configurable
model/preset. The plugin owns naming lifecycle through generic service hooks.
The rebased full check passes 1,289 tests (38 skipped); four affected Chromium
cases and three independent reviews pass. Existing history migrates
additively; live vendor and native desktop generation remain unqualified.

## Current implementation status

As of 2026-10-10, Harness provides:

- An append-only conversation/item graph with one durable head, linear rewind,
  branch-preserving continuation, turn reconciliation, and resumable transcripts.
- A cancellable multi-step agent loop with `send`, `queue`, `steer`, and
  `interrupt`, interleaved reasoning/text/tool output, ordered multi-call tool
  dispatch, correlated host requests, and typed events.
- Tool, model, and request middleware plus plugin-owned context sources,
  per-conversation services, policies, observers, and configuration schemas.
- OpenAI API-key (Responses + chat/completions), OpenAI Codex OAuth, Anthropic,
  Gemini and Mistral API/Vibe API-key, native web search on these direct connections,
  OpenCode Go API-key, config-defined OpenAI/Anthropic-compatible
  providers, named built-in/compatible
  API/OAuth connections, boot-discovered LiteLLM
  gateways, uniform scoped credentials and neutral shared transports, and a
  deterministic demo provider with model catalogs, reasoning
  payload fidelity, usage, and cost.
- Harness-owned read/write/edit/patch/glob/command tools selected by the active
  model's trained file-tool dialect.
- Hybrid and code-only tool modes over one scoped catalog, ordinary
  discovery, governed recorded nested calls, and a bounded QuickJS worker.
- Local, Linux Bubblewrap, and dev-container execution; bounded output files;
  human approval and optional model-backed auto-approval.
- Hierarchical `AGENTS.md` instructions, model-backed/manual compaction,
  background activities, and configurable recursive subagents.
- An Ink TUI with streaming Markdown, verbose transcript, resume/rewind,
  model/preset selection, sandbox controls, activities, usage, cost, and context
  fill.
- A Tauri/React desktop client with React Router loaders/actions/fetchers, a
  live conversation sidebar, independent turns/drafts/approvals, virtualized
  bounded history, Markdown/tool/diff/output inspection, provider/settings
  controls including a global auto-review model/preset, and a bundled shared
  background server with exclusive database ownership. Approval defaults refresh open
  conversations while their main model selections stay pinned.
  Native Windows tests cover actual WebView2, processes, restart, and shutdown;
  other desktop platforms remain unqualified.
- A language-neutral JSON-RPC client/server boundary used identically in-process,
  by a local stdio child, or through SSH. Multiple attached root conversations
  may run concurrently; the TUI renders one while server-owned approvals and
  server-owned background work remain live.
- Durable model/preset pinning, plugin-owned child inheritance, runtime-bound
  callbacks, authoritative failed-reload detachment, and shared devcontainer
  ownership with conversation-scoped processes/cancellation and warning controls.

## Subsystems

| Subsystem                   | Current architecture                                    | Active plan or next priority                                                                                       |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Kernel                      | [Architecture](docs/subsystems/kernel/README.md)        | No selected kernel change; add seams only for concrete plugin needs.                                               |
| Persistence                 | [Architecture](docs/subsystems/persistence/README.md)   | No selected persistence change; branch navigation remains deferred; only the current database format is supported. |
| Models                      | [Architecture](docs/subsystems/models/README.md)        | [Transient reliability and named gateway catalogs](docs/subsystems/models/PLAN.md)                                 |
| Execution and safety        | [Architecture](docs/subsystems/execution/README.md)     | [Native mutation containment](docs/subsystems/execution/PLAN.md)                                                   |
| Context and compaction      | [Architecture](docs/subsystems/context/README.md)       | Observe v1; add another strategy only for a demonstrated need.                                                     |
| Orchestration               | [Architecture](docs/subsystems/orchestration/README.md) | [MCP tools and settings plan](docs/plans/cross-cutting/2026-10-10-mcp-tools-and-settings.md)                       |
| Configuration and interface | [Architecture](docs/subsystems/interface/README.md)     | [Diagnostics and supportability](docs/subsystems/interface/PLAN.md)                                                |
| Testing                     | [Architecture](docs/subsystems/testing/README.md)       | [CI recovery and evidence for active reliability/security work](docs/subsystems/testing/PLAN.md)                   |

## Near-term order

The [native web search and assistant-phase delivery](docs/plans/models/2026-10-10-native-search-and-assistant-phases.md)
implements provider-owned search settings, reported assistant phases and one
immutable item log with provider/model-bound metadata. Search hints are
display-only; required finalized Gemini and Anthropic native history round-trips
through the existing metadata sidecar. Both Mistral connections use one streaming
Conversations adapter, preserving auth, catalogs, settings and affinity. Combined
validation passes 1,154 tests (36 skipped), the server bundle/syntax checks and
three independent reviews. Detailed evidence is in the delivery plan. Live vendor
acceptance and billing remain credential-dependent.

The [code-mode delivery](docs/plans/cross-cutting/2026-10-03-code-mode.md) adds
programmatic selection without a second tool registry or permissions path. It
includes shared effective contracts, deferred exposure, canonical nested history,
reviewer failure evidence across compaction, and client inspection. Delivery is
complete with independent plan/design and implementation reviews, full local
validation (891 tests passed, 30 skipped), and all 12 native scenarios against the
staged Windows release outside the checkout without system Node. Evidence and
qualification limits are recorded in that delivery plan. Discovery uses ordinary
immediately available search/describe tools, existing deferred code exposure, and
deduplication that resets with compaction.
The completed architecture cleanup lets JavaScript control child concurrency,
preserves wrapper contracts, hides guest internals, and moves reviewer selection
into auto-approval. Concurrent activity waits retain completion notices until
delivery or consumption, and collection respects those owners. The final cleanup
passed refreshed full checks, three independent reviews, and all 12 native Windows
scenarios against the fresh release.

Completed the
[independent parallel conversation foundation](docs/plans/cross-cutting/2026-10-03-parallel-conversations.md)
with full local validation, independent review, real stdio concurrency, and live
Docker/Compose qualification. The service/protocol is ready to underpin a desktop
client. The approved [desktop v1 delivery](docs/plans/interface/2026-10-03-desktop-v1.md)
is complete with full local validation, three independent reviews, and eleven
native E2E scenarios against the staged Windows release outside the checkout
without system Node. The NSIS installer builds; installation and other desktop
platforms remain unqualified. TUI parallel presentation remains outside
scope. Existing provider reliability and native containment
priorities below remain active follow-up.

The desktop settings/model follow-up passes `npm run check` (843 tests,
30 platform/opt-in skips) and all eleven staged Windows release E2E scenarios.
OpenAI/Codex catalogs now include the current GPT-6/5.6 coding families and their
backend-specific controls, limits, and cache-write accounting. Live provider
invocations remain opt-in qualification.

1. [x] Replace obsolete monolithic design documents with this product plan and
       current subsystem documentation.
2. [ ] Add minimal provider error normalization and bounded transient model
       retry middleware.
3. [x] Deliver [MCP tools and settings](docs/plans/cross-cutting/2026-10-10-mcp-tools-and-settings.md):
       stdio/hosted HTTP tools, env/header/OAuth configuration, scoped credentials,
       plugin-owned permissions, and desktop/TUI settings. Keep the configurable
       human timeout in approval settings. Fixture/RPC/client qualification and
       macOS release compilation pass; full-check and platform limits are recorded
       in the delivery plan.
4. [ ] Close the native filesystem mutation race before strengthening sandbox
       isolation claims.
5. [ ] Reassess product ergonomics and diagnostic export in the shipped clients.
6. [x] Establish the transport-agnostic client/server boundary before adding a
       second UI client.
7. [x] Deliver the approved desktop v1 with independent conversations, inspection,
       owned background server, database exclusion, and actual native E2E.
8. [ ] Deliver the [named provider instances and LiteLLM boot catalogs](docs/plans/models/2026-10-03-dynamic-provider-catalogs.md)
       plan. Implementation, normalized model metadata, real LiteLLM with controlled
       upstreams, and packaged Windows behavior are verified. Actual vendor
       cryptographic acceptance remains credential-dependent and open.

## Documentation roles

- This file tracks product direction and subsystem-level progress.
- Subsystem `README.md` files describe accepted current behavior.
- A subsystem `PLAN.md` exists only while that subsystem has a selected,
  actionable roadmap.
- `docs/plans/` records delivery plans for concrete substantial changes.
- `docs/decisions/` records why significant accepted choices were made.
- `docs/research/` records evidence and unresolved investigation.
- `docs/DEFERRED.md` records known limitations intentionally outside active work.
- Public types, implementation, and executable tests remain the final authority
  when documentation drifts.

## Optional feedback capture (2026-10-15)

Implemented conditional desktop votes and settings through `@harness/feedback`,
with durable authenticated case delivery to sibling MAI. Votes include bounded
earlier-decision inputs and outputs, and a read-only `.decisions` RPC supports
backfilling existing cases through the server boundary. Capture preserves
original behavior separately from effective/native decision input and explicitly
labels missing linkage and reasoning limits. Native request capture retains
existing context-build and middleware identity behavior. See the
[architecture](docs/subsystems/feedback/README.md). MAI owns human review and
separately submitted cloud training; this integration never trains or promotes
on a vote. Live provider checks and native feedback UI qualification remain open.
