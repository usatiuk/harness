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

`ModelConfig` is one atomic `{provider, model, preset?}` selection. A model
identity change never carries a preset, even when the destination exposes the
same preset token; preset selection is a separate, current-model operation.
Configuration merging applies this replacement rule recursively to top-level,
profile, and plugin-owned model selections.

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
- One terminal `completed` event containing normalized usage or explicit `null`
  when a compatible backend completed without reporting accounting.

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
round-trips prior reasoning as plaintext `reasoning_content` (no
encrypted/thinking payload) folded into one native assistant message per model
generation — content, reasoning, and tool calls together — which DeepSeek's
thinking mode requires ("must be passed back to the API"). A generation that only
reasoned renders as a standalone assistant reasoning message. Instructions and
context are hoisted into a single leading system message. If a backend streams
`reasoning_content` after the finalized reasoning item, the transport fails fast
rather than silently dropping it. Config-defined providers choose the transport
explicitly: `"openai-responses-compatible"` for the
Responses shape (with the `sendInstructionsAsSystem` opt-in above) and
`"openai-completions-compatible"` for chat/completions (function-only; rejects
`fileTools: "apply_patch"` on every model). Each entry strictly scopes only what an
endpoint owns — `endpoint`, `apiKey`, `type`, and the responses-only
`sendInstructionsAsSystem` opt-in — while each served model carries its own
`fileTools`, `contextWindow`, `maxOutputTokens`, and `presets` under
`models.<id>`. One entry can therefore serve several models on a shared server
across different trained dialects and sampling knobs (e.g. an OVMS endpoint
running both a completion-tuned and a responses-tuned model).
Configured hard output limits cannot exceed the context window, and preset caps
cannot exceed the model's declared output capacity.
Model/preset validation runs before capability-dependent tool/context work, and
`capabilities(model)` resolves the chosen model's `fileTools` or throws for an
unknown id. The pre-rename
`"openai-compatible"` literal is no longer accepted; the validation message
lists the supported type names.

The chat backend always sends `stream_options.include_usage` (and `tool_choice`
only when a tool turn requests it), which some strict servers reject. Usage
arrives on a final `include_usage` tail chunk when the server honors it; omission
is recorded explicitly as `usage: null`, never fabricated zero tokens. `length`,
`content_filter`, malformed/unfinished calls, and unsupported finish reasons
preserve partial text and accounting but fail the logical turn before tools run.
A stream that ends without any `finish_reason` has no terminal event and records
no usage row.

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
used and unknown ids fail validation. `OpenCodeGoProvider`
delegates to three inner provider instances — the chat `OpenAIChatProvider`, a
stateless Responses subclass that retains encrypted reasoning replay, and an
Anthropic Messages subclass (whose `buildConfig`
overrides `max_tokens` from the roster) — reusing each transport's overflow
mapping, cancellation, and usage normalization. Go is a subscription plan, so the
catalog ships no per-token pricing and usage rows record `null` cost.

## Authentication and secrets

The CLI auth registry exposes built-in provider login methods. Their API keys
come from environment variables or secure stores. Codex uses PKCE OAuth,
refreshes sessions, and persists credentials through `@harness/secrets`. Windows
uses DPAPI; other supported environments may use the OS keyring or an explicitly
selected file store. Credential backends fail explicitly rather than silently
downgrade.

Config-defined providers intentionally use an inline `apiKey` literal in global
settings in this pre-release implementation; keyless servers require a dummy
value. This accepted simplification is not a secure-store path, so settings and
backups must be protected accordingly.

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
- Missing provider accounting is durable `null`; it is never presented or priced
  as zero usage.
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
