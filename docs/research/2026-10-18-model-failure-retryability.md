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

- OpenAI and Anthropic SDKs retry connection errors, 408/409, 429 and >=500 by
  default, `max_retries=2`, honoring `Retry-After`.
- Vercel AI SDK retries only failures before a model call starts streaming;
  retrying after output begins requires an explicit opt-in
  ([error handling](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)).
- Gemini SDKs auto-retry transient errors ~4 times, ~1s initial, 60s cap.
- LiteLLM maps every provider onto one OpenAI-shaped exception taxonomy, with
  `ContextWindowExceededError` as a distinct invalid-request subclass
  ([exception mapping](https://docs.litellm.ai/docs/exception_mapping)).
- Stacked retries multiply call volume when SDK-level and application-level
  retries coexist
  ([write-up](https://dev.to/ji_ai/anthropic-sdk-maxretries-stacked-on-my-retries-36-calls-per-job-283l)).

## Idempotency and retry storms

- No LLM provider documents an idempotency-key contract for model calls; a retry
  after a forwarded-but-unanswered request can duplicate a provider-side charge
  ([Yotta Labs](https://www.yottalabs.ai/post/prevent-duplicate-llm-retry-charges)).
  Bounded attempts pre-first-output keep this cost bounded.
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
