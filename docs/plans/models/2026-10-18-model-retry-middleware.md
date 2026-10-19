# Bounded model retry middleware and retry visibility

Status: **Complete**

## Autonomous review loop (2026-10-19)

The requested additional loop reviews the entire feature against its release
base, including the original retry commit and current productization changes.
It does not expand the accepted product scope.

- [x] Three fresh independent read-only reviews: correctness,
      architecture/simplicity, and client/persistence/tests/evidence.
- [x] Resolve concrete findings, re-review substantive corrections, and record
      evidence without adding speculative machinery.
- [x] Run affected checks and the full repository check after code changes;
      synchronize final evidence and remaining limitations.

Findings selected for correction:

- Codex's detail-surfacing fetch must retain HTTP status/body/headers instead of
  turning HTTP failures into SDK connection errors. Verify permanent failure,
  provider wait, and quota handling through the real credentials/SDK path.
- A recovered invocation's earlier provider attempts have unobserved spend.
  Keep the successful completion's usage/context checkpoint but mark conversation
  and last-turn usage/cost as lower bounds when `attempts > 1`. Use existing
  counters and flags, not another accounting record or retry ledger.
- Restore test-owned random mocks and correct the Mistral coverage claim.
- Remove the test-only raw-row resume compatibility branch: real desktop and
  CLI consumers already receive authoritative summaries. Narrow the reducer and
  CLI prop to that contract instead of duplicating server accounting rules.

The accounting regression failed before the correction in the real retry
engine and both store contracts (three failures; the six zero/one/historical
count controls passed). No timing limit or assertion was weakened.
Codex's regression also failed against the original wrapper before correction
(six failures). Response normalization preserves both top-level and nested
machine fields as well as HTTP metadata; empty detail and ordinary responses
remain unchanged.

Loop closure:

- The three fresh review lenses found the Codex HTTP metadata defect, partial
  recovered-call accounting, and an overstated Mistral coverage claim. All are
  corrected. Scoped re-review independently verified accounting and summary-only
  resume; a further fresh reviewer checked all substantive fixes and found no
  material blocker (571 focused tests across 16 files passed).
- Final `env -u HARNESS_SERVER_SELECTION npm run check`, outside containment:
  **1,984 passed / 41 skipped / 0 failed**, 178 test files passed and 10 skipped.
  Typechecking, lint and formatting pass. Both focused Chromium cases pass.
- The sandbox-only execution stream-fd failure was reproduced independently
  inside containment and passed outside it; no product/test assertion was
  patched around that environmental difference.
- No new retry framework, per-attempt ledger, transport replacement, retry
  lifecycle protocol, or compatibility fallback was added. The unused raw-row
  client aggregation branch was removed instead of acquiring another copy of
  server accounting policy.

## Productization follow-up (2026-10-19)

The post-delivery review reproduced ordinary bundled SDK timeout classification
failure, pre-output OpenAI SSE errors bypassing retry, OpenCode Messages billing
errors bypassing permanent-error policy, missing attempt counts on exhaustion,
and stale retry presentation after tool-only output. The original validation
did not cover these boundaries. This follow-up is required work, not a deferral.

- [x] Research official SDK practices and pinned implementations; settle the
      smallest adapter-local normalization contract. Record evidence in the
      existing research note. No constructor-name identity or generic
      configurable classification framework.
- [x] Correct classification and gateway policy ownership, preserving causes,
      cancellation, retry-after, permanent failures, and pre-first-event replay.
      Check: real-SDK transport and bundled regressions pass.
- [x] Keep known attempt accounting independent of provider completion; clear
      retry presentation on authoritative output. Check: engine regressions use
      the shipped middleware for exhaustion/cancellation and tool-only recovery.
- [x] Remove duplicated retry schema/policy definitions and misleading tests or
      documentation without adding speculative infrastructure.
- [x] Run focused tests, full repository checks, and three independent reviews
      (behavior, architecture/simplicity, tests/scope). Update actual evidence,
      architecture, and limitations before marking complete.

Chosen design, grounded in the official SDK sources and installed versions:

- OpenAI/Anthropic adapters use their own exported SDK classes, structured
  error types/codes, and HTTP status. Protocol keeps only small neutral
  parsing/transport-code helpers, not a configurable classification skeleton.
  Unrecognized raw errors remain unchanged. SDK connection-error classes are
  themselves retry evidence; unknown wrapped causes are not parsed as prose.
  Custom endpoint configuration rejects non-HTTP(S) schemes before SDK creation.
- OpenCode's existing transport subclasses override one protected raw-error
  classification method; remove the second outer classification pass. Known
  permanent quota codes win before transient type/status mapping.
- Pinned Gemini Interactions does not export its connection-error classes and
  discards the timeout cause. Use its exact adapter-local error names with an
  explicit `keepNames` payload build contract and a real bundled regression.
  Do not deep-import SDK internals, create a loader, wrap fetch, or recreate SDK
  timeout behavior merely to recover identity.
- Engine accounting reads a private invocation-local attempt counter regardless
  of provider completion. Host attempt metadata leaves the provider event
  contract. Existing canonical model/compaction output clears retry UI; no new
  event, state machine, timer, or durable record is needed.
- Share required settings bounds through the plugin's client-safe export;
  plugin configuration alone adds defaults. Tests use production plugin
  construction rather than a second retry-loop implementation.

Non-goals remain unchanged: no provider routing, durable retry state, proactive
throttling, replay after streamed output, or generic error taxonomy.

### Follow-up validation and review evidence

- Final `env -u HARNESS_SERVER_SELECTION npm run check`, outside containment:
  **1,984 passed / 41 skipped / 0 failed** across 188 files (178 passed,
  10 skipped). All three TypeScript configurations, repository lint and
  formatting pass. Protocol-schema regeneration produces no wire-schema drift.
- Both focused Chromium cases pass: retry Working presentation and retry
  settings controls. These are rendering/control checks, not new live-provider
  or native-desktop qualification.
- The bundle regression now exercises 29 actual SDK/fetch scenarios in each of
  ordinary and minified bundles using production options: 58 scenarios total,
  including the Codex credentials path. The suite also covers actual pre-output
  SSE failures and all Go transports.
- The first follow-up full check reproduced a real integration defect:
  preflight correctly made zero provider calls, but SQLite's old positive-only
  count constraint masked the original image-input error. Schema 15 corrects
  the constraint without discarding schema-14 counts or historical nulls.
  Migration, shared store-contract and public image-boundary regressions pass.
- Three independent final reviews covered correctness, simplicity/boundaries,
  and tests/evidence/scope. Findings were addressed: reject unsupported custom
  endpoint schemes before SDK creation, explicitly test raw-vs-SDK-wrapped fetch
  behavior, remove an unused quota-code export, and reconcile historical docs.
  Review of the schema correction found no further blocker. No new framework,
  durable retry state, timer, transport wrapper or lifecycle protocol was added.
- The new settings-schema export preserves required wire fields while plugin
  configuration alone adds defaults. Engine and middleware regressions use the
  shipped plugin, not a second implementation of retry policy.

## Goal and observable completion

One bounded, configurable retry for transient model-call failures, applied to
every model call (agent steps, model-backed compaction, title naming,
auto-approval review, subagent turns) through the existing model-middleware
chain, with retry progress visible to the user for conversation and compaction
calls and silent elsewhere. Subagent turns are agent turns on their child
conversations, so their retry progress surfaces there rather than in the parent
transcript. `attempts` counts total model invocations per call (5 = first try
plus 4 retries).

Observable completion: a rate-limited conversation turn recovers without user
action while the desktop/TUI shows the retry progress; a permanent failure (bad
request, billing) fails immediately; title naming stays silent; auto-approval
exhaustion surfaces as the existing deny result; `npm run check` passes.

## Baseline before the original implementation

Every model call already flows through the single `Kernel.#streamModel` choke
point and `runModelChain` ([engine.ts](../../packages/core/src/engine.ts)); the
`ModelMiddleware` contract ([model.ts](../../packages/protocol/src/model.ts))
explicitly permits re-issuing `next` before the first yielded event and no
plugin uses the surface yet. Gemini SDK retries are already disabled so core
middleware owns logical retry. There is no transient/permanent classification:
adapters normalize only `ContextWindowExceededError` and rethrow everything
else, which `#streamModel` wraps in `ModelInvocationFailure`. Usage records one
`ModelUsage` row per logical invocation; failed calls record `usage: null`.
Provider and SDK evidence for classification is in the
[research note](../research/2026-10-18-model-failure-retryability.md).

## Design

### Classification (adapter-owned, one protocol type)

`TransientModelFailure` in `@harness/protocol` carries `reason:
"rate_limit" | "overloaded" | "server" | "timeout" | "connection"` and optional
`retryAfterMs` (provider-requested minimum wait, normalized by a shared pure
`parseRetryAfterMs` helper that accepts delta-seconds and HTTP-date). Adapters
classify at their catch boundaries, where response headers are available:

- `openai-core` shared transports own OpenAI-API-shaped classification
  (inherited by `openai-api`, `mistral`, `custom-openai*`, `litellm`).
- `anthropic-core` owns Anthropic-shaped classification (inherited by
  `anthropic-api`, `custom-anthropic`, opencode-go's Anthropic route).
- `gemini-api` owns `@google/genai` errors (status/code based; `RetryInfo`
  details parsed when trivially present).
- `opencode-go` overrides classification on its existing shared SDK transport
  subclasses. Its gateway policy sees raw failures once, before normalization.

Retryable: connection failures, timeouts, 408, 429 rate-limit, 500/502/503/504,
529/overloaded. Everything unclassified is permanent, including known billing
429 codes. `ContextWindowExceededError` keeps its separate compact-and-retry
path. Mid-stream failures (`completed.error`) are yielded events and are never
retried by construction. Pre-first-byte timeouts after a forwarded request are
ordinary retryable connection/timeout failures: a retried call can duplicate
provider work. This implementation does not rely on a model-call idempotency
contract. No ambiguity classes or special cases are introduced.

### Retry middleware (`@harness/model-retry` plugin)

A small first-party plugin contributes one `modelMiddleware()` and global config
under `plugins["model-retry"]`:

```ts
{ attempts: 5, backoffMs: 1000 } // total invocations; 0/1 disables retries
```

Fixed, non-configurable: multiplier ×2, full jitter, 60 s cap. A provider
`retryAfterMs` raises the wait to the provider-requested floor; when the
requested wait exceeds the 60 s cap the middleware stops retrying and rethrows,
so a turn converges to a visible failure instead of parking. Cancellation aborts
backoff promptly (`ModelInvocationFailure("model invocation aborted")`, matching
existing abort semantics). Retries re-issue only before the first yielded event.
Provider-SDK built-in retries stay disabled (Gemini already is) to avoid stacked
retry multiplication.

### Visibility (purpose-derived, one audience table)

The middleware reports each scheduled retry through a `ModelMiddlewareContext`
reporting hook; `#streamModel` publishes a kernel `model.retry` event carrying
`{purpose, attempt, maxAttempts, delayMs, reason}`. The service wire projection
applies one audience table: `agent` and `compaction` are user-visible; `title`,
`auto-approval`, `plugin` and unknown purposes are silent (auto-approval
exhaustion already surfaces as its deny result; title failure already degrades
silently). Visible events fold into the current turn's Working presentation as
a transient slot (desktop line "Retrying — attempt 2 of 5 after rate limit,
waiting 12s"; TUI spinner label), cleared when model output resumes or the turn
settles. Nothing is persisted into the transcript.

### Accounting

One `ModelUsage` row per logical invocation, unchanged. `ModelUsage` carries
optional `attempts`, populated from the engine's private
invocation-local counter rather than from provider events. It counts actual
provider calls (zero for middleware-only output) on success, exhaustion, and
cancellation; historical rows remain unknown. An exhausted call records one
`usage: null` row that still carries its known attempt count.
Successful recovery retains its final completion's known usage and cost, but
multiple provider calls make conversation/turn totals incomplete because earlier
calls are unaccounted. Preserve the final context checkpoint and suppress
throughput derived from incomplete agent accounting. This uses existing counts
and summary flags, not a per-attempt ledger or additional persisted state.

### Non-goals

- Proactive pacing/throttling from `x-ratelimit-*` on successful responses;
  capturing rate-limit snapshots for the future diagnostics export.
- Idempotency/dedup for at-least-once retries; mid-stream restarts.
- Per-provider or per-connection retry overrides; a fallback/model-router.
- Special handling of OAuth refresh (existing credential paths own it).
- Durable retry state across process restart.

## Milestones

### M1 — Protocol contracts

- [x] 1.1 Add `TransientModelFailure` and `parseRetryAfterMs` to
      `@harness/protocol` (`model.ts`), `attempts?` to `ModelUsage`, a
      `reportRetry` hook to `ModelMiddlewareContext`, and the kernel +
      wire `model.retry` event; bump `HARNESS_PROTOCOL_VERSION` to 19,
      regenerate `docs/protocol/client.schema.json`, update
      `docs/protocol/client.md`.
      Completion check: protocol typechecks; schema regen is clean; existing
      suites pass except version-expectation updates.
- [x] 1.2 Unit tests for `parseRetryAfterMs` (delta-seconds, HTTP-date, garbage)
      and the new event/schema shapes.
      Depends on 1.1. Completion check: focused protocol tests pass.

### M2 — Adapter classification

- [x] 2.1 `openai-core` transport catch blocks classify transient failures
      (status + known permanent billing codes + `Retry-After`/`retry-after-ms`
      parsing) and throw `TransientModelFailure`; 400-overflow mapping
      unchanged.
      Depends on 1.1. Completion check: table-driven tests over error fixtures
      (status/headers/body variants) pass for retryable and permanent cases.
- [x] 2.2 `anthropic-core`, `gemini-api`, `opencode-go` classification in the
      same shape (including Gemini `RetryInfo` when trivially present).
      Depends on 1.1 (can parallel 2.1). Completion check: per-adapter fixture
      tests pass; litellm/custom-providers inheritor tests cover the shared
      `openai-core` path. Mistral's distinctive `type`-shaped errors are not
      separately verified (recorded under gaps).

### M3 — Retry plugin and engine plumbing

- [x] 3.1 `@harness/model-retry` plugin: config schema (`attempts`, `backoffMs`),
      global scope, and the retry `modelMiddleware()` (bounded attempts,
      exponential full-jitter backoff with 60 s cap, `retryAfterMs` floor,
      fail-fast when the floor exceeds the cap, abortable sleep, re-issue only
      before the first yielded event).
      Depends on 1.1. Completion check: middleware tests over a scripted failing
      handler prove retry/stop rules, bounded attempts, backoff parameters,
      cancellation during backoff, and no retry after first event.
- [x] 3.2 Engine plumbing: `#streamModel` passes `purpose` and a report hook
      into `ModelMiddlewareContext`, publishes `model.retry` kernel events,
      owns a private provider-attempt counter, and lets `TransientModelFailure`
      propagate like `ContextWindowExceededError`; `recordModelUsage` stores
      `attempts`. Register the plugin at the server composition root.
      Depends on 3.1, 2.x for real classification. Completion check: engine
      tests prove `agent` and `compaction` calls traverse the middleware with
      identical semantics and usage rows carry `attempts` (including the failure
      row of an exhausted call); the title/auto-approval paths share the same
      `#streamModel` seam by construction (covered at their own boundaries).

### M4 — Visibility and configuration surface

- [x] 4.1 Wire projection audience table in the service; protocol doc updated.
      Depends on 3.2. Completion check: RPC test proves `model.retry` reaches
      clients for `agent`/`compaction` and is dropped for `title`,
      `auto-approval`, and `plugin` through actual attached RPC notifications.
- [x] 4.2 Client presentation: transient retry slot in
      `client-features/transcript-reducer` (cleared on resumed output or settled
      turn), desktop Working-group line, TUI spinner label.
      Depends on 4.1. Completion check: reducer tests; focused browser case for
      the Working line; TUI render test.
- [x] 4.3 Settings surface: `AppSettings.modelRetries` projection and update
      through the existing `app.settings` route (desktop Settings control with
      Off/3/5/10 + advanced backoff; TUI host-defaults editor already generic).
      Depends on 3.1. Completion check: settings round-trip test; focused
      browser case for the control.

### M5 — Docs, validation, review

- [x] 5.1 Synchronize `PLAN.md`, `docs/subsystems/models/README.md` + `PLAN.md`,
      `docs/subsystems/interface/PLAN.md`, `docs/subsystems/testing/PLAN.md`,
      `docs/TESTING.md` with delivered behavior and evidence.
- [x] 5.2 Full `npm run check`; independent review (behavior, architecture +
      simplicity, tests/scope); resolve findings with evidence.

## Validation

Failing-provider fixtures construct real SDK errors or inject HTTP/SSE/fetch
failures through the installed SDKs. OpenAI/Anthropic classify by SDK class
identity; Gemini's hidden classes are covered under the actual payload build
options in normal and minified bundles. Unknown raw fetch prose does not imply
transience; real-SDK regressions explicitly distinguish SDK connection wrappers
from raw errors. Custom configuration rejects unsupported endpoint schemes.
Engine tests use the production retry plugin, actual RPC notifications prove
audience filtering, and reducer tests cover semantic retry clearing. SQLite
migration, shared store-contract, and public image-preflight tests prove known
zero-call accounting without masking the original error. Live-provider and
native packaged-server qualification remain outside these local fixtures.

## Original validation (before productization)

- `env -u HARNESS_SERVER_SELECTION npm run check` (host, outside the sandbox):
  1878 passed / 41 skipped / 0 failed across 186 test files (176 passed), incl.
  typecheck (3 tsconfigs), lint and format check.
- Focused model-stack sweep (protocol, all adapters + inheritors, model-retry,
  openai-codex, mistral, custom-providers): 723/723 green.
- Chromium (`playwright.browser.config.ts`, host): both retry cases pass —
  "running turns show retry progress while a model call backs off" and
  "Settings exposes the model retry controls from host defaults".
- The original reviews and fixture coverage did not establish bundled identity,
  statusless SSE errors, gateway quota precedence, failed-invocation attempts, or
  tool-only retry clearing. The follow-up above supersedes the reflective
  classifier, its stand-in tests, and the understated accounting deferral.

## Remaining gaps at handoff

- Resolved in productization: provider attempts no longer ride on `completed`.
  The original limitation also affected ordinary exhaustion, not merely abort.
  Both invocation paths now persist their independent counter, with regression
  coverage for exhaustion, cancellation and buffered/concurrent middleware.
- Test hermeticity: local test runs still need `env -u HARNESS_SERVER_SELECTION`
  (documented in `docs/TESTING.md`) because the hosting shell leaks it.
- Retry semantics: a stream whose first yielded event is `completed.error`
  cannot be retried (retries re-issue only before the first yielded event).
  Providers report terminal errors as that first event, so some endpoint-level
  failures outside the transport layer are permanent by construction. Recorded
  in the research note.
- Mistral's distinctive `type`-shaped error bodies have no dedicated
  classification fixture; the adapter inherits the shared `openai-core` path.
- Permanent billing failures: explicit code lists plus the `billing_` family and
  `access_terminated` are permanent by construction (`isPermanentQuotaCode` in
  `openai-core`, shared with the OpenCode Go gateway).
- Resolved in productization: wire reason validation derives from the protocol's
  canonical schema, and required settings bounds are shared without wire defaults.
- SDK identity is adapter-owned; the original unminified-output assumption was
  incorrect because bundling also renames colliding classes. OpenAI/Anthropic
  use SDK class references; pinned Gemini's hidden error names require the
  explicit payload `keepNames` contract and bundled regression.
- Classification never
  runs on an already-aborted signal by policy, so a failure surfaced under a
  fired `AbortSignal.timeout()` is permanent even when its standalone shape
  would be transient (no current adapter passes such a signal).

## Local primary-branch integration (2026-10-19)

- Feature productization committed as `c7942a7` after the independent review/fix
  loop. Merged locally into the original worktree's `main` at `32a7b0a`, retaining
  version 0.8.1, the restored Codex catalog, infinite turns, and desktop/activity
  corrections. The only textual conflict was `PLAN.md`; both delivery histories
  are preserved. No code conflict or integration defect was found.
- The original worktree initially lacked the new `@harness/model-retry` workspace
  symlink, causing typecheck and browser build resolution failures.
  `npm install --ignore-scripts --offline` restored workspace links without
  changing the lockfile; the same validation then passed.
- Merged-tree `env -u HARNESS_SERVER_SELECTION npm run check`, outside containment:
  **2,002 passed / 41 skipped / 0 failed**, with 178 test files passed and 10
  skipped; all three TypeScript checks, lint and formatting pass.
- Both focused Chromium retry-progress/settings cases pass.
  `npm run protocol:schema` produces no schema drift. No unresolved index entries
  remain, and whitespace checks pass.
- A read-only independent integration review found no material blockers across
  Codex transport/catalog, engine retry/step ownership, desktop/activity changes,
  version metadata, and retained plan histories. The earlier live-provider and
  native qualification limits remain unchanged. No push is requested or performed.
