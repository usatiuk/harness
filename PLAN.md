# Harness plan

## Goals

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

## Release planning

The [release, installation, and update plan](docs/plans/cross-cutting/2026-10-10-release-installation-updates.md)
records the installed-product work: GitHub Release artifacts, separate
shared Node runtimes, native bootstrap, selected shared servers, cross-version
management, platform qualification, and explicit update activation. Compatibility
guarantees start at the first public release; private/pre-release transition
support is outside scope. Implementation is in progress. GPLv3, a project-owned
verification key, Node 22.23.3 and the initial product version are recorded.
The native bootstrap and complete Windows CLI/server payload foundation pass
focused checks, including a real turn and database restart from copies outside
the checkout. Installed launch, shared-server IPC/management, packages, updates
and prune remain open; no publication is claimed.

Release work is rebased onto native-search commit `0dfb0ff`, preserving Gemini,
finalized provider output and SQLite v6 migrations. The combined full check passes
1,173 tests (36 skipped), with typecheck/lint/formatting, and rebuilt isolated
CLI/server payload smoke passes. All release milestone completion gates remain
open; the current evidence does not establish installed updates or other platforms.

The CLI now prepares its own payload/runtime separately from the persisted
selected server/runtime at actual connect/start. Signed cached fixtures and real
headless helpers cover this separation. Detached startup transfers cache-use
ownership before SQLite admission; stdio holds a guard through child exit.
The CLI preparation full check passes 1,188 tests (36 skipped), with typecheck/lint/formatting;
fresh standalone Windows payloads pass the CLI stdio RPC/turn/database-restart smoke.
Installed cross-version/ABI qualification, desktop and remote integration,
updates and prune remain open.

Desktop preparation now uses the shared Rust cache and exact Node/server paths;
the old secondary runtime/dependency-junction cache is removed. Complete source
payloads become immutable snapshots, shared source starts preserve a live owner,
and isolated stdio starts reject that owner before changing selection. The
desktop keeps its own control helper through app lifetime and selected Local
helpers through bridge exit. Command helpers share bounded reads, cooperative
cancellation and physical retirement. The release entry explicitly validates
clean source identity and selects release mode. Installed download, remote,
update, cleanup and platform qualifications are still open.
The full managed check after desktop preparation again passes 1,188 tests
(36 skipped), with typecheck/lint/formatting. Twenty native-bootstrap Rust tests
and six desktop Rust tests pass (the latter includes two child fixtures), and
the prepared bridge/RPC/SQLite/rebuilt-restart smoke passes through OS exit.

Cold desktop preparation now runs in an internal hidden helper, with cancellable
install/download waits and overlapping cache-use protection on handoff. Host
Cancel/disconnect reaches that operation before preparation returns. Shutdown
rejects new admission and awaits preparing operations as well as spawned bridges.
Eleven desktop Rust tests pass (including two child fixtures, three actual
desktop-executable preparation cases and one controlled EOF-frame case).
Actual Tauri shutdown/native UI and other-platform qualification remain open;
this slice does not complete the overall release milestones.
The final full managed check passes typecheck, lint, formatting and 1,193 tests
(36 skipped). The native workspace's 20 tests also pass. Independent correctness,
architecture/simplicity and evidence reviews have no remaining material finding
in this cancellation slice; remote provisioning replacement is next.

The shared bootstrap now installs transferred complete server/Node archives
offline, using the same trust, extraction, cache locks and publication policy as
local downloads. Server layout and build identity are validated before publication
and on reuse; source and release warm installation need no transfer archives.
Complete Windows server payloads include the target native helper. The corrected
native suite passes 29 tests, plus two actual helper cases in release mode;
fresh payload and preparation/desktop-bridge smokes pass headlessly. The full
managed check still passes 1,193 tests (36 skipped).

SSH/WSL now uses the shared offline installer and cached native launch. The saved
host-Node/runtime selector and target npm installer are removed. Complete Linux
source deployments build with the pinned Node and private Rust tools; native
checks pass 32 cases on Windows and 34 on Linux. Real isolated SSH qualification
passes cold/warm installation, shared Node, bridge loss, live-owner preservation
and rebuilt restart, plus two authentication failure cases. Review connected
remote detached startup to the existing child cache-use handoff and corrected
text-upload error observation. WSL provisioning and its rendered TUI conversation
now pass; the input fixture flushes React's passive input subscription before
sending keys. A real SSH install-lock cancellation failure is corrected through
EOF-aware native preparation and awaited target exit. Cached-only opens now read
immutable payloads under shared use without installation waits. Final SSH/WSL
cached-bridge-under-lock checks pass, as does the full managed check (1,193 tests,
36 skipped). Signed installed remote releases,
minimum glibc, updates, prune and all overall release milestones remain open.

Release-cut tools now provide clean-checkout patch/minor/major version edits,
fresh desktop build provenance, complete CLI/server packaging and exact-byte
manifest/Tauri metadata assembly. Review corrected mirror-cache identity,
desktop build binding and runtime-layout checks. The full managed check passes
1,202 tests (36 skipped); native tests pass 34 Windows and 36 Linux cases, and
twelve desktop Rust checks pass headlessly. Actual signed platform builds,
source export, protected release jobs, updates and explicit prune remain open.

## Recent delivery

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
queues. Ten headless regressions, 24 ordinary native Windows cases and two real
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
- Direct, hybrid, and code-only tool modes over one scoped catalog, ordinary
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
| Testing                     | [Architecture](docs/subsystems/testing/README.md)       | [Evidence for active reliability and security work](docs/subsystems/testing/PLAN.md)                               |

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
platforms remain unqualified. TUI parallel presentation and worktrees remain outside
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
