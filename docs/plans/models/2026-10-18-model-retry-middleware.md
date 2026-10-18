# Bounded model retry middleware and retry visibility

Status: **Active**

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

## Current behavior

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
- `opencode-go` classifies its own fetch/SSE transport failures.

Retryable: connection failures, timeouts, 408, 429 rate-limit, 500/502/503/504,
529/overloaded. Everything unclassified is permanent, including known billing
429 codes. `ContextWindowExceededError` keeps its separate compact-and-retry
path. Mid-stream failures (`completed.error`) are yielded events and are never
retried by construction. Pre-first-byte timeouts after a forwarded request are
ordinary retryable connection/timeout failures: a retried call can rarely
duplicate a provider-side call (documented; no provider offers idempotency
keys). No ambiguity classes or special cases.

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

One `ModelUsage` row per logical invocation, unchanged. `ModelStreamEvent`
`completed` and `ModelUsage` gain an optional `attempts`, stamped by
`#streamModel` on every call (1 = the first try succeeded) and absent only on
records written before this change. Failed attempts record no completed usage;
an exhausted call records one `usage: null` row that still carries `attempts`.

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
      `@harness/protocol` (`model.ts`), `attempts?` to the `completed` event and
      `ModelUsage`, a `report` hook to `ModelMiddlewareContext`, and the kernel +
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
      stamps `attempts` on `completed`, and lets `TransientModelFailure`
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
      clients for `agent` and is dropped for `title`; `compaction` and
      `auto-approval` behavior is proven by the audience-predicate unit test.
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

Failing-provider fixtures at the transport boundary construct the SDKs' own
error classes (their `name` stays `"Error"`; classification reads the
constructor name — a fabricated `name` fixture once masked a dead detection
path), scripted-handler middleware tests, engine/RPC tests over the real
service for shared call-path semantics and visibility, and focused browser/TUI
checks for presentation. Table-driven classification keeps provider quirks at
adapter boundaries. Live-provider qualification is credential-dependent and out
of scope: classification fixtures use real documented error shapes instead.

## Evidence

- `env -u HARNESS_SERVER_SELECTION npm run check` (host, outside the sandbox):
  1878 passed / 41 skipped / 0 failed across 186 test files (176 passed), incl.
  typecheck (3 tsconfigs), lint and format check.
- Focused model-stack sweep (protocol, all adapters + inheritors, model-retry,
  openai-codex, mistral, custom-providers): 723/723 green.
- Chromium (`playwright.browser.config.ts`, host): both retry cases pass —
  "running turns show retry progress while a model call backs off" and
  "Settings exposes the model retry controls from host defaults".
- The dead SDK-error-name defect is pinned three ways: skeleton constructor-kind
  tests (`failure-classification.test.ts`), adapter fixture tables built from
  the SDKs' own error classes, and engine tests that a transient failure
  recovers a call. Title naming's silent degrade has a fail-without/pin-with
  regression test (`conversation-titles`).
- Review loop: three independent reviews (architecture, tests/scope, behavior)
  plus a final read-only spot-check of the classification fixes; all findings
  fixed or recorded under gaps. The behavior review's core finding (SDK error
  `name`-keyed detection was dead code, masked by fabricated fixtures) is
  addressed with constructor-identity detection and real SDK error fixtures;
  the spot-check verified the premise empirically against the installed SDKs
  and its two precision findings (fetch-failed label, raw-body quota nesting)
  are fixed with tests.

## Remaining gaps at handoff

- Deferred redesign (architecture review N2): `attempts` rides on `completed`
  and is re-stamped by `recordModelUsage`, so transport interruption of a
  multi-retry call can persist the last-attempt number instead of the true
  count. Flushing the engine's attempt counter into the usage row would close
  it; deferred because failures already record `usage: null` and the drift
  window is a transport abort.
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
- Cleanup nits: `model.retry`'s wire `reason` enum duplicates the
  `ModelFailureReason` tuple and could derive from it.
- Latent constraints noted at review: constructor-name error identity assumes
  the adapters run from unminified Node output (a bundled deployment would need
  `instanceof` against SDK error classes instead); and classification never
  runs on an already-aborted signal by policy, so a failure surfaced under a
  fired `AbortSignal.timeout()` is permanent even when its standalone shape
  would be transient (no current adapter passes such a signal).
