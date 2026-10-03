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
npm run desktop:build            # release executable and NSIS installer
```

## Desktop native tests

`npm run test:native` requires Windows WebView2, Rust, and Visual Studio C++ build
tools. It packages the real server and Node runtime, builds the production web
assets and native executable, then runs Playwright against that executable's
WebView2 through CDP. It verifies that the WebView process belongs to the launched
application. Neither a browser mock nor a development HTTP server stands in for
the native app. Only the model network edge is controlled for deterministic
command tests; actual SQLite, credentials, shell processes, and shutdown run.

Tests isolate `HARNESS_HOME`, `APPDATA`, `LOCALAPPDATA`, and the WebView profile.
They cover concurrent approvals/turns/drafts, queue/steer/interrupt, presets and
settings, bounded history and large output/diffs, server crash/restart, exclusive
database ownership, secure key validation/storage, real command cleanup, and
observable shutdown failure. Test artifacts live under
`packages/desktop/test-results/`; non-secret visual scenarios save screenshots.
Credential scenarios do not record traces or screenshots. These native tests are
separate from the ordinary Linux/Windows `npm run check` CI matrix.

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
  releasing SQLite. These fixtures do not establish real upstream encryption
  affinity; gateway/native qualification remains tracked in the delivery plan.

- Named built-in provider tests cover independent stored API keys, exact
  environment references, legacy slots, label changes, construction identity,
  type contributions and pre-construction validation. Codex tests cover isolated
  OAuth token records, coalesced rotation and logout during refresh. Live browser
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
