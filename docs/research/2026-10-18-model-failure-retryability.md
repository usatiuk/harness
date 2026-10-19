# Model failure retryability: provider evidence

Research note supporting the
[model retry middleware delivery plan](../plans/models/2026-10-18-model-retry-middleware.md).
Evidence and sources only; accepted behavior lives in the delivery plan and the
models subsystem docs.

## Provider-documented retryability

- OpenAI ([error codes](https://developers.openai.com/api/docs/guides/error-codes),
  [rate limits](https://developers.openai.com/api/docs/guides/rate-limits)): 500
  and 503 `server_is_overloaded` are documented retryable; 429 `rate_limit_error`
  is retryable honoring `Retry-After` with exponential backoff and jitter.
  Billing/quota 429 codes (`credit_balance_exhausted`,
  `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`,
  `organization_usage_limit_exceeded`) must not be retried. 400/401/403 are
  permanent. Headers: `Retry-After`, `retry-after-ms`, `x-ratelimit-*`.
- Anthropic ([errors](https://docs.anthropic.com/en/api/errors)): 500 `api_error`,
  529 `overloaded_error`, 504 `timeout_error`, 429 with `retry-after` header are
  retryable; 400/401/402/403/404/413 are permanent. A spend-cap 429 has no
  `retry-after` and never succeeds until access resumes.
- Gemini ([troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting)):
  429 `RESOURCE_EXHAUSTED` and 503 `UNAVAILABLE` are documented for exponential
  backoff; SDKs treat 500/504 as transient. 400 `INVALID_ARGUMENT` includes
  input-token-limit failures and is permanent. No first-class `Retry-After`
  header; `google.rpc.RetryInfo` may appear in error details. Safety blocks are
  200-responses (`finishReason: SAFETY | RECITATION`), not errors.
- Mistral ([error glossary](https://docs.mistral.ai/resources/error-glossary)):
  429/500/502/503/504 documented transient with exponential backoff
  (`2**attempt + U(0,1)`, up to 5 attempts); 400/401/402/403/404/422 permanent.
  No documented `Retry-After` contract.

## SDK and library practice

- Installed JavaScript SDKs at this investigation: OpenAI **7.27.0**,
  Anthropic **0.104.2**, Google GenAI **2.28.0** (not claims about the latest
  releases). OpenAI and Anthropic default to two SDK retries; disable them with
  the JavaScript option `maxRetries: 0`, not Python's `max_retries`.
  [OpenAI's version-pinned README](https://github.com/openai/openai-node/blob/v7.27.0/README.md#retries)
  and [Anthropic's current SDK documentation](https://platform.claude.com/docs/en/api/sdks/typescript#retries)
  document retry ownership; pinned implementation remains authoritative for
  installed behavior.
- Vercel AI SDK retries only failures before a model call starts streaming;
  retrying after output begins requires an explicit opt-in
  ([error handling](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)).
- Google GenAI has two transports: legacy model/catalog calls use
  `httpOptions.retryOptions.attempts: 1` (one total attempt), while Interactions
  uses per-call `maxRetries: 0` (zero retries). The latter is translated to the
  generated transport's retry strategy in the
  [2.28.0 compatibility adapter](https://github.com/googleapis/js-genai/blob/v2.28.0/src/gaos/google-genai.ts).
  Harness sets both options; setting one is not evidence that the other
  transport has disabled retries.
- LiteLLM maps every provider onto one OpenAI-shaped exception taxonomy, with
  `ContextWindowExceededError` as a distinct invalid-request subclass
  ([exception mapping](https://docs.litellm.ai/docs/exception_mapping)).
- Stacked retries multiply call volume when SDK-level and application-level
  retries coexist
  ([AWS guidance](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)).

### SDK-local error identity and bundled payloads

The previous shared classifier used `name`/`constructor.name` to infer SDK
identity. Even an unminified bundle can rename colliding SDK classes
(`APIConnectionError2` was reproduced with the installed OpenAI and Anthropic
packages); minification also renames them. A single configurable classifier
does not fix the missing identity contract.

- **OpenAI and Anthropic:** use their own exported `APIUserAbortError`,
  `APIConnectionTimeoutError`, `APIConnectionError`, and `APIError` constructors
  via adapter-local `instanceof`. Check timeout before connection because
  timeout subclasses connection. These SDKs normally leave `Error.name` as
  `"Error"`. See the pinned
  [OpenAI error classes](https://github.com/openai/openai-node/blob/v7.27.0/src/core/error.ts)
  and [Anthropic error classes](https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.104.2/src/core/error.ts).
  Imports must resolve to the same SDK copy/module format as the client; do not
  add speculative cross-realm or duplicate-package identity fallbacks.
- **Google GenAI:** the public legacy `ApiError` has a literal stable name and
  numeric status
  ([2.28.0 source](https://github.com/googleapis/js-genai/blob/v2.28.0/src/errors.ts)).
  Interactions instead throws private compatibility classes; the
  [root exports](https://github.com/googleapis/js-genai/blob/v2.28.0/src/index.ts)
  expose only type-level Interactions resources, not those constructors.
  The [compatibility error source](https://github.com/googleapis/js-genai/blob/v2.28.0/src/gaos/lib/compat-errors.ts)
  assigns `this.name = this.constructor.name`, preserves a connection cause,
  but discards timeout/abort causes. No public constructor, stable brand, or
  retained timeout cause can replace name detection in this pinned version.
  Generated documentation listing an internal class does not make it an
  importable package export.

The minimal pinned-version compromise is Gemini-local exact `error.name`
checks, with an explicit payload `keepNames: true` contract and a regression
through real bundled/minified SDK calls. This is a supported
[esbuild option](https://esbuild.github.io/api/#keep-names). Preserve names in
the existing build rather than introducing a package-transform plugin, deep
imports, constructor reflection, custom fetch wrappers, or a second timeout
implementation solely to recover identity. An in-memory experiment confirmed
that ordinary minification changes the three Interactions transport names;
`keepNames` preserves them. A future SDK exporting its constructors could
remove this exception after the same regression passes.

### Status, body, cause and cancellation boundaries

HTTP status alone misses pre-output SSE errors: both SDKs throw `APIError`
with **undefined status**, structured body and response headers before yielding
the failed event. OpenAI unwraps the body into `.error`, `.code` and `.type`;
Anthropic retains the whole body in `.error` and exposes `.type`. See the
version-pinned
[OpenAI SSE decoder](https://github.com/openai/openai-node/blob/v7.27.0/src/core/streaming.ts)
and [Anthropic SSE decoder](https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.104.2/src/core/streaming.ts).
Use provider-local documented body codes/types when status is absent. Permanent
billing/quota exclusions must also apply without HTTP 429, before a broad
rate-limit type can trigger retry. Unknown application exceptions stay unknown;
a bare `status` property or a message containing “network” is not SDK identity.

Keep only small shared pure helpers for shape access, messages, response-header
delays and bounded cycle-safe Node/undici cause-code inspection. SDK class
identity and provider status/body rules stay at the adapter that owns them.
Prefer a coded timeout in a cause over a generic connection wrapper. Real
stream-body failures can escape SDK request wrapping, so recognized transport
codes remain useful even for SDK-backed adapters.

The SDK connection class is itself evidence under the SDK retry policy, even
when its cause is unrecognized. An injected `TypeError("fetch failed")` remains
unclassified when raw but becomes a retryable connection failure when OpenAI or
Anthropic wraps it. Tests pin both cases rather than claiming the adapter can
infer every deterministic failure beneath the wrapper. The demonstrated
unsupported-scheme configuration is rejected at the custom endpoint's HTTP(S)
validation boundary, without matching “unknown scheme” error prose.

An aborted logical-call signal always wins, including when its reason looks
like a retryable timeout. SDK user-abort errors and transport AbortErrors are
not transient. Some SDK stream iterators terminate on abort instead of
throwing; callers must preserve existing signal-based cancellation handling.
Conversely a standalone SDK timeout with a live caller signal is retryable.
The retry boundary remains the **first Harness event yielded**, not the first
network byte, SSE frame, or ping. Keep SDK creation and iteration inside the
classified catch; never restart after any Harness event.

### Focused validation of the SDK identity correction

- All Gemini suites pass: 56 tests, including real Interactions HTTP, timeout,
  coded timeout cause, connection and cancellation failures through the provider.
  Fetch call counts prove SDK retries remain disabled for these failures.
- The server's `model-errors-bundle.test.ts` imports the actual production
  `payloadBundleOptions` and bundles the real three SDKs and their local
  classifiers. Both ordinary and minified builds pass: 29 transport-driven
  scenarios per build, covering timeout, coded timeout cause, connection,
  cancellation, HTTP errors, retry headers and preserved error causes. Eight
  scenarios per build use actual Codex credentials, including detail-shaped
  permanent HTTP and quota errors.
  The injected fetch edge makes no live requests or timing assumptions.
- Root TypeScript checking and focused lint/format checks pass. This is not
  elapsed-time timeout qualification, live-provider acceptance, or a native
  packaged-server end-to-end run; repository-wide validation is tracked in
  the delivery plan.

## Idempotency and retry storms

Recovered retries cannot make earlier provider accounting known. Keep the final
completion's reported tokens/cost and context checkpoint, but expose aggregate
usage/cost as lower bounds when multiple provider invocations occurred. The
existing attempt counter is sufficient; no billing estimate or per-attempt
ledger is inferred.

- This implementation does not rely on a provider model-call idempotency
  contract. A timeout does not establish that a request had no upstream effect;
  retrying a forwarded-but-unanswered request can duplicate provider work
  ([AWS guidance](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)).
  Bounded attempts before the first yielded output limit, but do not eliminate,
  this risk.
- Uncoordinated retries amplify overload; exponential backoff with jitter,
  capped attempts, and `Retry-After` as a floor are the standard mitigation
  ([AWS Builders' Library](https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter)).

## Unresolved

- Anthropic spend-cap 429s are indistinguishable from rate-limit 429s without
  body inspection; retrying them is wasted but bounded work. Accepted as an
  explicit exception: the classification stays status-based, and the wasted
  retries are bounded by the configured attempt limit.
- A stream whose first yielded event is `completed.error` is never retried,
  because the middleware only re-issues before the first yielded event.
  Endpoint-level failures reported that way (not through the transport catch
  boundary) are therefore permanent by construction; keeping v1 to the
  transport boundary avoids speculative restarts of already-streamed calls.
- `x-ratelimit-reset-*` formats differ per provider (delta strings vs unix
  timestamps) and are not parsed in v1.
