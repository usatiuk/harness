# Models subsystem

## Status

Harness supports OpenAI Responses and chat/completions through API keys,
ChatGPT/Codex OAuth, Anthropic Messages through API keys, OpenCode Go through an
API key across all three gateway transports, Gemini Interactions and Mistral
API/Vibe through API keys, config-defined
OpenAI/Anthropic-compatible endpoints, and a deterministic demo provider. Adapters
expose one streaming `ModelProvider` contract. Shared transports own native
serialization, streaming, payload fidelity and error normalization; concrete
connections own catalogs, capabilities and generation policy.

All built-in API/OAuth and compatible providers support named connections with
isolated credentials. LiteLLM connections discover catalogs at server boot and
reuse the existing adapters.

Every model-backed operation passes through the same model-middleware boundary:
ordinary agent steps, compaction, subagents, model-backed auto-approval, and
first-message conversation naming.

## Provider contract

A provider declares:

- Its registry id and selectable `ModelInfo` catalog.
- Model capabilities used to choose Harness-owned tool dialects.
- Configuration validation and optional immutable, safe provider-owned request options.
- A cancellable stream from `ModelRequest` to provider-neutral events.

`ModelProvider.stream(request, signal, context)` receives a required
`ModelCallContext` containing the calling `conversationId`. Core creates it at
the one middleware/provider boundary for agent steps and auxiliary invocations.
Retries retain that context, resume retains the durable ID, and each subagent
uses its own conversation ID. Request identity is outside prompt content and
credential state. Connections map it to their native headers. Shared SDK
transports accept a connection-owned `requestHeaders(context)` callback and pass
its result as per-call request options, without mutating shared client defaults.

`ModelCallContext.captureRequest` optionally records the serialized native body
after adapter formatting and before transport. OpenAI chat and Responses adapters
implement it. Core keeps the logical call context stable while async-local scope
links each provider attempt and emitted event to its own captured request, including
buffered middleware and concurrent retries. Evidence is stored separately in
plugin state, without adding context builds or prompt content. A displayed
transcript is not the native input; unsupported adapters and synthetic events
have explicitly unavailable native linkage. See the
[feedback integration](../feedback/README.md).

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

`maxInputTokens` preserves an independently advertised hard input limit without
claiming a combined context window. `reasoning` carries explicit support,
adaptive/legacy/always-on thinking flags and advertised effort levels/defaults;
absence means unknown and an explicit false remains false. These informational
fields do not invent request controls or presets. Proactive compaction uses a known
input bound plus an output reservation, without requiring a combined context window.
An explicit compaction threshold remains usable when capacity metadata is incomplete.

Catalogs are explicit and may apply complete per-model capacity overrides where
the same model differs by backend. Pricing lives beside the catalog entry so
usage rows can calculate cost at completion.

## Request and stream normalization

Canonical requests carry instructions, selected items with optional opaque
payloads, tools, an optional non-durable prompt, tool choice, advisory output
limit, model configuration and safe provider options. Providers translate canonical items into their
native message/call/result representations and translate streamed output back
into:

- Text and reasoning deltas for live display.
- Explicit finalized assistant messages, reasoning and local tool-call items,
  with provider payloads where required.
- Display-only `provider_output` text hints for native search.
- One terminal `completed` event containing normalized usage or explicit `null`
  when a compatible backend completed without reporting accounting.

The engine rejects further events after completion and retains the first terminal
accounting. A provider can mark `inputTokensAreContext: false` when reported billing
input is not a single-prompt measurement. Hosted-search adapters do this after
search occurs. Spend totals remain intact; context checkpoints become unknown and
capacity uses the existing local estimate.

A failed or interrupted attempt records unknown accounting unless the provider
reported usage before its terminal error. Cancellation aborts the provider stream
and is normalized by the engine into an aborted turn.
Provider payloads remain opaque to the kernel and are replayed only when their
provider, model, type, and version match.

Deltas are ephemeral previews, never database writes. A finalized block replaces
its preview once; graceful interruption may persist partial readable content
without native metadata. A hard crash can lose an unfinalized preview. Assistant
`phase` preserves any reported string, null, or absence and never drives the loop.
Readable reasoning or summaries are separate items; opaque-only reasoning can
have empty canonical content. Model selection changes apply at the next turn.
Foreign reasoning is omitted, ordinary assistant text remains, and historical
raw-string local calls use plain text where the target API requires object inputs.

## Native web search

The direct `openai-api`, `openai-codex`, `anthropic-api`, `gemini-api` and
`mistral-api` and `mistral-vibe` connection schemas own `webSearch: boolean` (default true).
Explicit false values remain opt-outs. Application provider status exposes the
configured choice independently of credential availability. Desktop Settings → Providers
edits it per connection; an explicit server restart rebuilds running providers.
Compatible providers and gateways retain their existing search behavior.
The adapter's safe immutable options travel on `ModelRequest.providerOptions`
and the existing context-build trace. Tool declarations follow provider settings
independently of `toolChoice`, which adapters forward to the native API.
Automatic compaction retains its existing local-tool continuation.

Search runs inside one provider invocation. Hints carry no provider payload and
are excluded before all model/context builds and compaction. Only local tool
calls drive Harness execution. There are no hosted-search continuation flags,
tokens, remote history IDs or search-resumption loops. Gemini incomplete statuses
and Anthropic `pause_turn` use the ordinary terminal-error/accounting path.

Gemini and Anthropic require finalized native search history on later requests.
Their adapters retain it as opaque metadata on corresponding ordinary finalized
items, independently of the hint. Gemini native steps and Anthropic content blocks
preserve signatures/encrypted results and original text/annotations without
changing displayed Markdown. No payload includes later canonical messages or
local calls outside its selected item. Anthropic finalizes the search portion at
`message_stop` so paused state cannot leak into later history. Search call/result
pairs are correlated across the finalized response and selected assistant history,
preserving intervening readable output. Unanswered searches and unmatched entries
in a rewound prefix are excluded from requests. Local calls ending in `tool_use`
follow the existing local-tool loop without restoring pending server work.

Gemini and Mistral use direct-model stateless calls with `store: false`,
bounded boot catalog discovery and no automatic retries. Catalogs preserve
advertised limits; separate input/output limits do not invent a context window.
Gemini returns finalized outputs; Mistral also streams live previews. Unsupported
non-text outputs fail explicitly while retaining reported accounting. Models are
instructed to cite Markdown links; no native
citation converter or Search Suggestions UI is added. Provider-reported billing
data stays opaque; additional unpriced search fees mark cost as incomplete.

## OpenAI family

`@harness/openai-core` owns stateless Responses and chat/completions mapping,
encrypted reasoning round-trip, function/custom tool translation, stream
normalization and context-overflow normalization. Neutral
`OpenAIResponsesTransport` and `OpenAIChatTransport` carry no vendor catalog or
reasoning defaults. The concrete `OpenAIResponsesProvider` owns direct
OpenAI/Codex catalog and generation policy. `@harness/openai-api`
supplies API-key credentials. `@harness/openai-codex` supplies OAuth
refresh/session persistence, the Codex endpoint and headers, backend error
surfacing, per-model limit differences, and unsupported-request-field handling.

The 2026-10-03 catalog refresh covers GPT-6.1 Sol, GPT-6 Astra/Sol/Luna and
GPT-5.6 Sol/Terra/Luna in both OpenAI API and Codex. The API additionally exposes
GPT-5.5, GPT-5.4/Mini, GPT-5.2, GPT-5.3-Codex and GPT-5.1. Retired
GPT-5.1-Codex is no longer offered. API capacities, reasoning efforts, and rate
cards follow the [official model catalog](https://developers.openai.com/api/docs/models/all)
and individual model pages. API effort defaults remain `medium`; Astra and
6.1 Sol reject `none`, and GPT-5.6/6 expose `max`.

Codex follows the [ChatGPT roster](https://learn.chatgpt.com/docs/models), including
GPT-5.5 until its announced 2026-10-14 retirement. Backend metadata in the local
Codex model cache reports working windows of 272,000 tokens for most models and
500,000 for GPT-6.1 Sol, with a 95% effective-window hint. Harness treats these as
already-output-reserved operational budgets, **an explicit assumption rather than
verified backend capacity**. The configured input ceilings are 400,000 for other
Codex models and 628,000 for Sol 6.1, with a 128,000 output reserve and no claimed
combined context window. The shared compaction policy therefore triggers around
264,000 and 487,440 input tokens; it does not reproduce Codex's separate 5% margin.
Public API model windows remain unchanged. The cache advertises `low` through `max`
efforts on GPT-5.6/6 (`low` through `xhigh` on 5.5); Sol 6.1 and Sol 5.6 default
to `low`, the others to `medium`. These differ from public API controls/capacity.
`ultra` is Codex orchestration and is not a Harness provider preset. Account and
workspace access still determine whether a listed model can be invoked; the
refresh is not live credentialed qualification. New sign-ins default to 6.1 Sol;
existing saved selections remain unchanged.

GPT-5.6/6 cache writes are reported separately at the existing usage boundary,
keyed by the 1,800-second TTL. Rate cards include the write premium and whole-request
long-context rates above 272,000 input tokens, per
[official caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching)
and [pricing](https://developers.openai.com/api/docs/pricing).

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
round-trips its own prior reasoning as plaintext `reasoning_content`, with a
provider/model ownership tag, folded into one native assistant message per model
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
endpoint owns — `endpoint`, `apiKey`, and the responses-only
`sendInstructionsAsSystem` opt-in — while each served model carries its own
`fileTools`, `contextWindow`, `maxOutputTokens`, optional display `label`, and `presets` under
`models.<id>`. One entry can therefore serve several models on a shared server
across different trained dialects and sampling knobs (e.g. an OVMS endpoint
running both a completion-tuned and a responses-tuned model).
Configured hard output limits cannot exceed the context window, and preset caps
cannot exceed the model's declared output capacity.
Model/preset validation runs before capability-dependent tool/context work, and
`capabilities(model)` resolves the chosen model's `fileTools` or throws for an
unknown id. Compatible transports are selected by the outer connection type;
there is no legacy provider configuration union or construction factory.

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
catalogs, and stream normalization. `AnthropicMessagesTransport` carries no
Claude defaults: each connection resolves a native `AnthropicRequestConfig`,
including its final output cap, before the mapper serializes it.
`@harness/anthropic-api` supplies API-key
credentials. The Anthropic-shaped editor schema and implementation remain owned
by the Harness workspace plugin.

## OpenCode Go family

`@harness/opencode-go` supplies one API-key connection (`OPENCODE_API_KEY`)
spanning Chat Completions, Responses and Messages transports. At server startup,
its `refreshModels` hook fetches the public [Models.dev API](https://models.dev/api.json)
within the shared ten-second discovery budget. A bounded 16 MiB download is
validated once, then the supported `opencode-go` slice replaces the connection's
in-memory catalog atomically. Synchronous reads and inference never fetch metadata.
Each new process begins with a bundled October 16, 2026 snapshot; failed refreshes
retain the current snapshot and surface degraded status through existing provider
diagnostics. There is no disk cache or periodic refresh; restart to update.

The catalog preserves display names, combined context, independent input/output
limits, advertised reasoning support and efforts. Deprecated and non-tool entries
are excluded. Unknown transports and invalid rows are skipped with bounded safe
diagnostics; an entirely unusable response cannot erase a working catalog.
The bundled slice contains 28 supported models: two deprecated rows and one
Google route are excluded from 31 upstream entries. Google generateContent needs
an adapter distinct from the existing Gemini Interactions provider.

Transport policy explicitly recognizes supported SDK/endpoint combinations;
the OpenAI SDK marker selects Responses, while the OpenAI-compatible marker
selects Chat Completions, as documented by Go. Credentials always go to fixed
Go inference endpoints under `https://opencode.ai/inference/go/openai/v1` and
`https://opencode.ai/inference/go/anthropic`; fetched URLs never become credential
destinations. The adapters retain native streaming, payload fidelity, overflow
mapping, cancellation and usage normalization. Go subscription usage still records
`null` cost; discovered prices do not establish Harness billing semantics.

Every Go request sends `x-opencode-session: <conversationId>` and the Harness
product User-Agent, including compaction and model-backed approval. Missing
routing identity has no generated fallback. This follows the
[Go client requirements](https://opencode.ai/v2/docs/console/go/#where-can-i-use-it).

Advertised Chat/Responses efforts become model-scoped `reasoning_effort`/reasoning
controls. Qualified Luna models retain `medium` as the default when advertised.
MiniMax M3 retains explicit thinking off/on when its toggle is advertised;
Messages budget controls retain high/max presets capped by advertised budget,
output capacity and the established 32K ceiling. Other Messages effort/toggle
advertisements remain informational until their wire mapping is qualified.
Omitting a preset leaves other models on gateway defaults. Presets never transfer
between models; unadvertised controls fail validation.

## Mistral API and Vibe

`@harness/mistral` contributes `mistral-api` and `mistral-vibe` types. Both use
API-key auth with existing instance-scoped secrets and generate through
streaming `https://api.mistral.ai/v1/conversations` with `store: false`. Native
`webSearch` is available on both types and never changes the transport. The default instances select
`MISTRAL_API_KEY` and `MISTRAL_VIBE_API_KEY` separately; additional named instances
select secure storage or an explicit environment reference. API discovery reads
`GET /v1/models`; Vibe reads `GET /v1/model-catalog?surface=vibe-code`. The Vibe
endpoint is experimental upstream, and selecting its catalog surface does not
prove subscription eligibility or change generation billing.

The existing OpenAI SDK owns HTTP/SSE delivery and cancellation. Dedicated pure
Mistral request/stream functions handle structured `thinking` blocks, signatures,
closed flags and opaque block metadata, raw tool arguments, and native usage.
Output/content indices assemble native fragments; text and reasoning previews
finalize in content order. Conversations has no individual entry-completion event:
only `conversation.response.done` authorizes native replay and local calls.
Completed message/function entries bind to the final canonical item, and replay
only when their entire readable group remains selected. Interrupted readable
content has no incomplete native sidecar. Existing signed Mistral thinking and
exact tool-argument sidecars remain valid inputs. Matching provider/model/type
payloads replay with validated versions; foreign reasoning is omitted.
Request rendering omits output-entry `id` fields, which Conversations rejects
on input, without mutating the stored native payload or nested content.
Native and imported call/result IDs remain exact; Conversations accepts string IDs.
Malformed or unsupported outcomes retain reported accounting but finish
with an error before any tools dispatch. Missing token counts remain unknown.

Every generation sends `x-affinity: <conversationId>` and the Harness user agent.
Children retain independent routing. Instructions, tool schemas and history stay
in stable order; changing context stays at its canonical position rather than
being moved to the front of the prompt. Cache routing is a provider header,
separate from telemetry and prompt data. Reported cached prompt tokens are a
subset of input tokens. SDK retries are disabled; core/middleware owns logical
retry semantics.

Discovery uses the existing bounded boot lifecycle: 2 MiB responses, 5,000 rows
and expanded aliases, atomic snapshots, cancellation, safe status diagnostics,
and no polling or disk cache. Explicit catalog rows own their IDs; conflicting
aliases and duplicate IDs fail discovery. Only function-capable chat models are
discovered. Optional `config.models.<exact-id>` entries declare additional models
or override `label`, `contextWindow`, and `maxOutputTokens` for a discovered ID.
Explicit fields win without propagating to aliases; discovered temperatures and
reasoning controls remain intact. Manual-only entries assert support for the
existing text/function-tool transport and have no reasoning presets. Limits are
positive integers, and output cannot exceed context when both are known, including
after discovery merging. The combined catalog retains the 5,000-model bound and
publishes atomically. Configured entries are available before discovery and survive
its failure; the existing bootstrap reports degraded status and the original
diagnostic. Credentials are still required. Connection changes need a restart.
Unadvertised prices and unadvertised/unconfigured capacity remain unknown.
Vibe's advertised reasoning strings become model-scoped presets and pass unchanged
to `completion_args.reasoning_effort`; legacy `off` maps to native `none`.
No client enum drops new advertised controls or collapses distinct efforts.
Advertised reasoning capability remains visible even without an effort list;
a boolean alone does not invent presets. The public API's `/models` schema does
not list efforts, so reasoning-enabled rows matching the documented Mistral Small,
Medium 3.5 and Large 4 IDs/aliases expose `none`/`high`; GLM 5.3 exposes
`low`/`high`/`max`. These options come from
[Mistral's reasoning documentation](https://docs.mistral.ai/studio/conversations/reasoning),
not a generic inference from the capability flag. Unknown API models retain the
flag without invented choices. Aliases retain the row's controls.
The public canonical content boundary currently supports text, so advertised
vision capabilities do not enable image input.

Local SDK/HTTP/SSE fixtures verify transport and fidelity. No real Mistral key
was available for this delivery; vendor signature acceptance, cache-hit rates,
subscription billing, Vibe-key Conversations acceptance and GLM native-search
acceptance remain unqualified. Models and keys use native provider behavior;
there is no model allowlist or fallback transport.

## LiteLLM connections and boot discovery

`@harness/litellm` contributes a configurable provider type. Each named instance
uses its own virtual key and catalog, including when URLs are identical. It
discovers exact public aliases from `/v1/models`, optionally enriches them from
`/model/info`, and atomically replaces its in-memory snapshot. Missing metadata
keeps the index usable with a neutral Chat Completions profile. Failed mandatory
discovery retains configured models (or the prior snapshot), with explicit status.

Transport selection is explicit model configuration, consistent validated
`model_info.harness` metadata, then `defaultTransport` (Chat Completions). Vendor
names and aliases never infer transport. Configured entries override exact public
IDs and may add hidden aliases. Unsupported/mixed deployment mode or tool claims
exclude discovered aliases unless the model is explicitly qualified with
`codingCompatible: true`; adding a label alone is insufficient.
Unknown capacities and gateway prices remain unknown; upstream price estimates
are not copied into gateway billing. `max_output_tokens` metadata supplies only
a hard output bound and `max_input_tokens` supplies a separate hard input bound.
LiteLLM's legacy `max_tokens` ambiguously means input or output and is not used as
context. Explicit reasoning/thinking metadata and effort levels/defaults are
normalized only when deployment rows agree. Separate input/output limits never
invent a context window.

The version-one Harness annotation accepts the same fields as a local model
profile, plus `version: 1`: transport, label, file-tool profile, capacities,
advisory request cap, sampling/thinking/effort controls, presets, default preset,
and an explicit USD-per-million-token rate card. All deployment rows for an alias
must agree on each annotation field. Invalid/conflicting metadata is diagnostic;
configured fields take precedence. `apply_patch` requires Responses. Unknown
models use `string_replace`; reasoning support alone never invents effort presets.

When explicit presets are absent, agreed effort levels generate ordinary presets
with the same names and request effort values. An agreed supported default effort
sets the default preset. Exact `reasoning_effort_levels`, including an empty list,
take precedence over legacy flags. Otherwise each deployment's per-level flags
derive a set, which must agree across the alias. Legacy medium/high are implicit;
minimal/low are omitted when explicitly false; xhigh/max and off require explicit
true flags. Off is conservative rather than inferred from provider/model names.
Missing metadata does not produce a generic effort ladder. Configured or annotated
presets, including an empty map, override generated presets. Messages does not
generate none/minimal effort presets because its existing effort contract does
not accept them; explicit thinking configuration remains unchanged.

Adapters reuse OpenAI/Anthropic implementation packages with gateway credentials.
They keep the outer instance ID and public alias in opaque payloads. Matching
saved reasoning requires its original Responses or Messages transport and a
supported payload version before any request is sent. All calls pass through the
existing model middleware once. Responses remain stateless with `store: false`;
load-balanced upstream ciphertext origins require gateway affinity.

Startup discovery has four workers, a ten-second overall network budget, and a
three-second enrichment budget inside it. Startup cancellation drains discovery
and releases the SQLite lease. Each endpoint is bounded to 2 MiB and 5,000 rows;
resolved catalogs are bounded to 5,000 models per instance and a 3 MiB aggregate
RPC budget, measured after wire projection. Model IDs are at most 512 characters. No polling, disk cache or live
refresh is enabled. `app.providers.list` and settings expose safe boot status,
registration, credential source/presence, labels, counts and diagnostics.

## Authentication and secrets

Provider plugins contribute configurable types through `providerTypes()`.
Global `providers.<id>` entries choose a type, optional display label, and the
type-owned config. The stable instance ID remains `ModelConfig.provider`; the
engine needs no extra identity field or execution path. OpenAI API, Anthropic API,
OpenCode Go, Mistral API/Vibe, and Codex OAuth support any number of named connections. Their
existing IDs are implicit default instances with the same scoped storage as
additional named connections.

Each connection owns its authentication method and provider construction. The
host scopes every secret slot to `provider-instance:<encoded ID>:<encoded slot>`
(`api-key` or `oauth`). Auth implementations receive only `ProviderSecrets` and
own local slot names, never physical store keys. Labels do not affect secret keys. API-key
sources may select `{stored: true}`, an exact `{env: "VARIABLE"}` reference, or
explicit environment precedence over storage via both fields. An environment-only
connection cannot accept or delete stored credentials. Named sign-in does not
change the global model selection; credential changes require restart. Codex
accounts have independent token records, caches and coalesced refreshes; logout
drains any rotation before deleting its session. Interactive login also excludes
new refresh admissions until the new account has been stored, so an old account's
rotation cannot overwrite it. Credential acquisition receives the invocation
signal. Cancelling one refresh waiter leaves other waiters running; cancelling
the final waiter drains the bounded rotation and persists any returned token
before returning cancellation. An already dispatched refresh may have consumed
the old token, so generation cancellation never aborts rotation. Login/logout
replace the auth owner and may abort its rotation. Logout excludes reads and
other mutations through durable deletion.

The CLI auth registry exposes built-in provider login methods. Their API keys
come from environment variables or secure stores. Codex uses PKCE OAuth,
refreshes sessions, and persists credentials through `@harness/secrets`. Windows
uses DPAPI; other supported environments may use the OS keyring or an explicitly
selected file store. Credential backends fail explicitly rather than silently
downgrade.

Compatible provider schemas live in `@harness/custom-providers/config`, with
strict endpoint/model/preset validation before I/O. Their API keys support the
same stored/environment sources as other instances. The inline literal option
supports a keyless local endpoint. Only the global `providers` envelope is
accepted. Old development configs and physical credential keys are not migrated;
rewrite the config and sign in again.

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
- Every provider attempt records accounting and its context build; unobserved
  usage stays unknown, including failed/interrupted attempts.
- Missing provider accounting is durable `null`; it is never presented or priced
  as zero usage.
- Hard catalog capacity and advisory request output caps remain distinct.
- Native web search is the only shipped provider-owned tool; local tool execution
  remains Harness-owned.

## Source map

- `packages/protocol/src/model.ts`: model contracts and normalized events.
- `packages/openai-core`, `openai-api`, `openai-codex`: OpenAI adapters/auth.
- `packages/anthropic-core`, `anthropic-api`: Anthropic adapter/auth.
- `packages/gemini-api`: native stateless adapter, discovery and auth.
- `packages/opencode-go`: OpenCode Go provider, Models.dev discovery and bundled fallback.
- `packages/mistral`: API/Vibe auth types, bounded catalogs and native mapping.
- `packages/custom-providers`: config-defined Responses/chat/Messages providers.
- `packages/litellm`: instance configuration, discovery normalization and gateway adapters.
- `packages/auth`, `packages/secrets`: login and credential persistence.

## Verification

Adapter tests cover native request shapes, tool/result round-trip, reasoning
payloads, stream translation, usage, cancellation-facing terminal errors, model
catalogs, and transport-specific differences. Live provider tests are opt-in and
skipped without credentials.

The opt-in Docker qualification exercises official LiteLLM v1.103.2 with real
virtual-key authorization, restricted catalogs, all three native gateway routes,
two-turn tools/usage, and synthetic encrypted reasoning/signature replay. Forced
Responses origins A and B plus a shared alias prove gateway item-ID restoration
and configured affinity using `encrypted_content_affinity`. Actual vendor
cryptographic acceptance remains credential-dependent. Packaged Windows tests
exercise secure named key storage, restart discovery, visible model metadata,
generation and reopening saved unavailable selections. See [testing guidance](../../TESTING.md).

LiteLLM gateways with the Gemini schema-result `$ref`/`$defs` failure need an
upstream version containing [PR #38284](https://github.com/BerriAI/litellm/pull/38284).
Harness keeps tool output unchanged and adds no local compatibility transformation.
The GUI can add a named LiteLLM instance through the existing global provider
configuration and credential boundaries; a server restart activates discovery.

Custom model labels flow through the existing ModelInfo catalog to GUI/TUI selectors. They do not replace the model key in API requests, settings identity or pinned conversation configuration; opaque checkpoint paths can therefore have readable names.
