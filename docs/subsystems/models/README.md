# Models subsystem

## Status

Harness supports OpenAI Responses through API-key and ChatGPT/Codex OAuth
transports, Anthropic Messages through API keys, and a deterministic demo
provider. Adapters implement one streaming `ModelProvider` contract and own all
provider-specific request, event, payload, catalog, and error behavior.

Every model-backed operation passes through the same model-middleware boundary:
ordinary agent steps, compaction, subagents, and model-backed auto-approval.

## Provider contract

A provider declares:

- Its registry id and selectable `ModelInfo` catalog.
- Model capabilities used to choose Harness-owned tool dialects.
- Configuration validation.
- A cancellable stream from `ModelRequest` to provider-neutral events.

`ModelInfo.contextWindow` and `ModelInfo.maxOutputTokens` describe the hard
capacity of one provider/model pair. The engine reserves the hard output maximum
when estimating whether the next input fits. `ModelRequest.maxOutputTokens` is a
separate advisory per-invocation cap: adapters send it when their transport
supports one. The Codex transport currently rejects `max_output_tokens`, so its
adapter omits the request field while retaining hard model limits for capacity
math.

Catalogs are explicit and may apply complete per-model capacity overrides where
the same model differs by backend. Pricing lives beside the catalog entry so
usage rows can calculate cost at completion.

## Request and stream normalization

Canonical requests carry instructions, selected items with optional opaque
payloads, tools, an optional non-durable prompt, tool choice, advisory output
limit, and model configuration. Providers translate canonical items into their
native message/call/result representations and translate streamed output back
into:

- Text and reasoning deltas for live display.
- Final reasoning and tool-call items, with provider payloads where required.
- One terminal `completed` event containing normalized usage.

A stream failure before completion records no completed usage row. Cancellation
aborts the provider stream and is normalized by the engine into an aborted turn.
Provider payloads remain opaque to the kernel and are replayed only when their
provider, model, type, and version match.

## OpenAI family

`@harness/openai-core` owns stateless Responses mapping, encrypted reasoning
round-trip, function/custom tool translation, stream normalization, catalogs, and
context-overflow normalization. `@harness/openai-api` supplies API-key
credentials. `@harness/openai-codex` supplies OAuth refresh/session persistence,
the Codex endpoint and headers, backend error surfacing, per-model limit
differences, and unsupported-request-field handling.

Responses are sent with `store: false`; Harness's item log and provider payloads
remain conversation truth. The OpenAI custom-tool path is used for the
Harness-owned freeform `apply_patch` dialect, not provider-executed tools.

## Anthropic family

`@harness/anthropic-core` owns Messages mapping, prompt-cache placement,
reasoning/thinking payload fidelity, generic function-tool rendering, model
catalogs, and stream normalization. `@harness/anthropic-api` supplies API-key
credentials. The Anthropic-shaped editor schema and implementation remain owned
by the Harness workspace plugin.

## Authentication and secrets

The CLI auth registry exposes provider login methods. API keys come from their
environment variables or secure stores. Codex uses PKCE OAuth, refreshes sessions,
and persists credentials through `@harness/secrets`. Windows uses DPAPI; other
supported environments may use the OS keyring or an explicitly selected file
store. Credential backends fail explicitly rather than silently downgrade.

## Errors and observability

Adapters normalize confirmed context overflow into `ContextWindowExceededError`.
Other failures preserve their SDK error and cause chain; the CLI renders nested
causes without dumping stacks or request bodies. Context builds record exactly
what each logical call saw, and usage events/rows record provider, model, tokens,
and optional cost.

There is not yet a normalized transient-provider error or automatic model retry
middleware. Deterministic request/configuration failures must never be retried.

## Accepted invariants

- Provider adapters contain no agent loop, durable conversation state, workspace
  execution, approval, or compaction policy.
- Harness canonical items always render without provider payloads; payloads add
  fidelity but never replace canonical content.
- Model-call middleware applies consistently to agentic and non-agentic calls.
- Usage belongs to a completed provider invocation and its recorded context build.
- Hard catalog capacity and advisory request output caps remain distinct.
- Shipped providers do not contribute provider-owned execution tools.

## Source map

- `packages/protocol/src/model.ts`: model contracts and normalized events.
- `packages/openai-core`, `openai-api`, `openai-codex`: OpenAI adapters/auth.
- `packages/anthropic-core`, `anthropic-api`: Anthropic adapter/auth.
- `packages/auth`, `packages/secrets`: login and credential persistence.

## Verification

Adapter tests cover native request shapes, tool/result round-trip, reasoning
payloads, stream translation, usage, cancellation-facing terminal errors, model
catalogs, and transport-specific differences. Live provider tests are opt-in and
skipped without credentials.
