# Models subsystem

## Status

Harness supports OpenAI Responses and chat/completions through API keys,
ChatGPT/Codex OAuth, Anthropic Messages through API keys, OpenCode Go through an
API key across all three gateway transports, config-defined
OpenAI/Anthropic-compatible endpoints, and a deterministic demo provider. Adapters
implement one streaming `ModelProvider` contract and own all provider-specific
request, event, payload, catalog, and error behavior.

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

`@harness/openai-core` owns stateless Responses and chat/completions mapping,
encrypted reasoning round-trip, function/custom tool translation, stream
normalization, catalogs, and context-overflow normalization. `@harness/openai-api`
supplies API-key credentials. `@harness/openai-codex` supplies OAuth
refresh/session persistence, the Codex endpoint and headers, backend error
surfacing, per-model limit differences, and unsupported-request-field handling.

Responses are sent with `store: false`; Harness's item log and provider payloads
remain conversation truth. The OpenAI custom-tool path is used for the
Harness-owned freeform `apply_patch` dialect, not provider-executed tools.

Config-defined OpenAI-compatible providers carry an opt-in
`sendInstructionsAsSystem` flag. Some backends (e.g. OVMS) accept the Responses
request shape but silently drop the top-level `instructions` field, so system
context — the agent's AGENTS.md/settings instructions and contracts like the
auto-approval reviewer's "output exactly YES" rule — never reaches the model. When
set, the custom provider renders `ModelRequest.instructions` as a leading
`system` input message instead, which those backends honor. It defaults to off
so backends that implement `instructions` natively are unchanged.

The chat/completions transport is the primary path for local and open backends
(vLLM, Ollama, OVMS). It is function-only (freeform custom tools throw) and
round-trips prior reasoning as plaintext `reasoning_content` on the assistant
message that follows it (no encrypted/thinking payload), with instructions and
context hoisted into a single leading system message. Config-defined providers
choose the transport explicitly: `"openai-responses-compatible"` for the
Responses shape (with the `sendInstructionsAsSystem` opt-in above) and
`"openai-completions-compatible"` for chat/completions (function-only; rejects
`fileTools: "apply_patch"`). The pre-rename `"openai-compatible"` literal is no
longer accepted; the validation message lists the supported type names.

The chat backend always sends `stream_options.include_usage` (and `tool_choice`
only when a tool turn requests it), which some strict servers reject. Usage
arrives on a final `include_usage` tail chunk when the server honors it; many
backends omit it, so the stream emits `completed` with zeroed usage — the row is
recorded at `null` cost rather than dropped. A stream that dies without a
`finish_reason` and without usage ends without `completed`, surfacing as an
error with no spend recorded.

## Anthropic family

`@harness/anthropic-core` owns Messages mapping, prompt-cache placement,
reasoning/thinking payload fidelity, generic function-tool rendering, model
catalogs, and stream normalization. `@harness/anthropic-api` supplies API-key
credentials. The Anthropic-shaped editor schema and implementation remain owned
by the Harness workspace plugin.

## OpenCode Go family

`@harness/opencode-go` supplies a first-class OpenCode Go provider: one API key
(`OPENCODE_API_KEY`) and one registry id (`opencode-go`) spanning three gateway
transports under `https://opencode.ai/zen/go/v1`. A static compiled roster maps
each model to its transport family (chat/completions | responses | messages); the
gateway's `GET /v1/models` returns bare ids only, so no runtime catalog fetch is
used and unknown ids dispatch on the default chat family. `OpenCodeGoProvider`
delegates to three inner provider instances — the chat `OpenAIChatProvider`, a
Responses subclass, and an Anthropic Messages subclass (whose `buildConfig`
overrides `max_tokens` from the roster) — reusing each transport's overflow
mapping, cancellation, and usage normalization. Go is a subscription plan, so the
catalog ships no per-token pricing and usage rows record `null` cost.

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
- `packages/opencode-go`: OpenCode Go provider and static roster.
- `packages/custom-providers`: config-defined Responses/chat/Messages providers.
- `packages/auth`, `packages/secrets`: login and credential persistence.

## Verification

Adapter tests cover native request shapes, tool/result round-trip, reasoning
payloads, stream translation, usage, cancellation-facing terminal errors, model
catalogs, and transport-specific differences. Live provider tests are opt-in and
skipped without credentials.
