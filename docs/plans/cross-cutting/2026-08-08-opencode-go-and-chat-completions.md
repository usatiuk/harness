# OpenCode Go provider and the chat/completions transport

> **Superseded in part by**
> `docs/plans/cross-cutting/2026-08-09-chat-reasoning-round-trip.md`: the
> "Thinking round-trip (chat)" merge rule ("merged into an immediately-following
> assistant message"), the `buildChatParams` mapping description, and the
> review-loop notes that call interleaved reasoning a tolerated display boundary
> are superseded. Reasoning now reconstructs as one native assistant message per
> generation, and interleaved reasoning after the finalized item fails fast. This
> plan's status stays `Complete`; the rest of its body (transport, opencode-go
> package, schema) remains current.

**Status:** Complete — implemented and validated on 2026-08-08; `npm run check`
(typecheck, lint, format, 675 tests) passes. Live smoke is opt-in behind
`OPENCODE_API_KEY`. Review loop (2026-08-08) closed three transport findings with
regression tests; see the "Review loop" section.
**Created:** 2026-08-08
**Updated:** 2026-08-09
**Area:** cross-cutting (protocol, openai-core, openai-api, anthropic-core, config, custom-providers, cli, new `opencode-go` package)

See also the sibling plan
`docs/plans/cross-cutting/2026-08-08-custom-model-providers.md` (config-defined
provider machinery, presets, factory). This plan builds on its schema and auth
wiring; transport/built-in-provider work lives here.

## Goal

Add OpenCode Go as a first-class provider in Harness: one API key from
`opencode.ai/auth`, one provider id (`opencode-go`), serving the Go model roster
across the three wire protocols the Go gateway exposes, with a static compiled
roster. Reuse of the transport includes a general
chat/completions transport in `@harness/openai-core` (also the path for local
OVMS/vLLM/Ollama backends through a new config-defined provider type).

**Completion condition:** A user who runs `harness auth login --provider
opencode-go` and sets the key (or `OPENCODE_API_KEY`) can select any Go model,
have it stream through the agent loop with reasoning, tool calls, cancellation,
usage, and compaction, exactly like the built-in providers — and a config-defined
`openai-completions-compatible` provider streams a local chat/completions backend
with prior-thinking round-trip.

## Current behavior and evidence

- Providers implement the streaming `ModelProvider` contract
  (`packages/protocol/src/model.ts`): `capabilities`, `validateConfig`, `stream`,
  `listModels` (synchronous `ModelInfo[]`).
- `ProviderRegistry.listModels()` (sync) feeds `availableModels()`; the engine
  calls `findModel(this.host.providers.listModels(), model)` on every turn for
  compaction capacity (`packages/core/src/engine.ts:1120`) and pricing lookup at
  completion (`engine.ts:1238`). Missing `contextWindow`/`maxOutputTokens`
  disables compaction advice (`engine.ts:1121-1123`) but streaming still works.
- The engine flushes pending text into a message item **before** appending a
  `reasoning` item (`engine.ts:607-611`), so a transport that emits a `reasoning`
  output item must do so **before** the following text deltas to keep the log
  order `[reasoning, message]`. (The Responses adapter already does this:
  `openai-core/stream.ts:53-61`, `output_item.done` precedes `output_text.delta`.)
- `@harness/openai-core` owns the **Responses** transport: `buildResponseParams`
  (request.ts), `toModelEvents` (stream.ts), `OpenAIResponsesProvider`
  (provider.ts), encrypted reasoning payload (payload.ts), `OpenAICredentials`
  (`{ client(): Promise<OpenAI> }`, credentials.ts).
- `@harness/anthropic-core` owns the **Messages** transport: `buildMessages`,
  `toModelEvents`, `AnthropicProvider`, thinking payload.
- **No chat/completions transport exists anywhere in the repo.**
- Overflow normalization (`ContextWindowExceededError`) lives in the **provider
  stream wrappers**, not the stateless mapping fns (`openai-core/provider.ts:156-168`,
  `anthropic-core/provider.ts:148-155`).
- `@harness/openai-api` exposes `apiKeyCredentials({ apiKey, baseURL })` returning
  `OpenAICredentials`; the OpenAI SDK appends the resource path to `baseURL`
  (`client.responses.create` → `{base}/responses`,
  `client.chat.completions.create` → `{base}/chat/completions`,
  `client.models.list` → `{base}/models`).
- The Anthropic SDK posts the path `/v1/messages` on top of `baseURL`
  (`node_modules/@anthropic-ai/sdk/resources/messages/messages.js:35`), so the
  Messages baseURL must be the server **root** (`https://opencode.ai/zen/go`),
  not the `/v1`-suffixed root the OpenAI client needs.
- Config-defined providers: `settingsDocSchema.customProviders` is a
  discriminated union over `"openai-compatible"` and `"anthropic-compatible"`
  (`packages/config/src/settings.ts:64-81`); the factory
  (`packages/custom-providers/src/factory.ts:33-55`) **defaults any
  non-`"openai-compatible"` type to the anthropic branch** (else-default trap
  that must become an exhaustive switch). `formatIssue` (`settings.ts:124-130`)
  returns only the first generic issue — a rename hint needs an explicit
  mechanism, it does not fall out of `z.discriminatedUnion`.
- The composition root catches any throwing `buildPlugin()` and warns+skips that
  provider (`cli/src/index.tsx:98-108`); `AuthEntry.buildPlugin` is async and runs
  only at harness startup (never at `auth login`).
- The Go gateway exposes three endpoints under one key (`https://opencode.ai/zen/go/v1`):
  `/chat/completions`, `/responses`, `/v1/messages`. Go is a subscription plan;
  Zen is the pay-per-request sibling (different base URL, not in scope).
- Live OVMS evidence (user trace): chat-completions round-trips prior thinking via
  plaintext `reasoning_content` on assistant messages and exposes
  `finish_reason: "length"`; the Responses path on that backend silently drops
  prior reasoning. This motivates both the chat transport and its reasoning
  round-trip. (`content: null` on a standalone assistant reasoning message is
  assumed accepted by OVMS-style backends — to be confirmed in the OVMS smoke.)
- `models.dev` (`https://models.dev/api.json`, provider id `opencode-go`, snapshot
  dated 2026-08-08) publishes the Go roster with exact limits; the gateway's live
  `GET https://opencode.ai/zen/go/v1/models` (verified 2026-08-08 with an API key)
  returns **bare ids only** — `{ id, object, created, owned_by }`, 25 models, no
  family/limits/pricing. A runtime fetch therefore cannot add a correctly-
  dispatched model; the compiled table is the family/limits source of truth.

## Chosen approach

1. **Extend `@harness/openai-core`** with a chat/completions transport
   (`buildChatParams`, `toChatEvents`, `OpenAIChatProvider`), mirroring the
   Responses transport and sharing `OpenAICredentials` and the OpenAI SDK client.
   No new package, no credential duplication.
2. **New `@harness/opencode-go` package**: `OpenCodeGoProvider` holds three inner
   provider instances — the thin `OpenAIChatProvider`, a Responses subclass, and
   an Anthropic Messages subclass — and switches `stream`/`capabilities`/
   `validateConfig`/`listModels` over the model's compiled family
   (chat/completions | responses | messages), reusing each transport's proven
   overflow mapping, signal handling, and usage normalization. Plus
   `createOpenCodeGoPlugin`.
3. **Catalog: static compiled roster** (mirroring the built-in providers' `MODELS`
   arrays), no runtime fetch. Unknown ids dispatch on a default **chat** family.
   (A live fetch was evaluated and cut: the gateway's `GET {base}/models` returns
   bare ids with no family/limits — verified 2026-08-08 — so it could only add
   ids that would stream on the wrong transport. Roster drift is handled by a
   future plan, not speculative picker machinery.)
4. **Config schema:** rename `"openai-compatible"` → `"openai-responses-compatible"`
   and add `"openai-completions-compatible"` (chat/completions) so local/OVMS
   users opt in explicitly; the Responses-backed custom type keeps its meaning.

## Locked design decisions

| Decision                   | Choice                                                                                                                                                                                                                                                   | Rationale                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport location         | In `@harness/openai-core`                                                                                                                                                                                                                                | Shares SDK client + `OpenAICredentials`; mirrors Responses; no package sprawl                                                                                                                                                                                                  |
| opencode-go provider id    | single `opencode-go`                                                                                                                                                                                                                                     | One key, one registry id; dispatch per model, like opencode's own config                                                                                                                                                                                                       |
| opencode-go structure      | **delegation**: three inner provider instances + family switch                                                                                                                                                                                           | Reuses each transport's overflow mapping/signal/usage; removes duplicated stream glue and the unified-catch per-family regex                                                                                                                                                   |
| Catalog                    | **static compiled roster**, no runtime fetch                                                                                                                                                                                                             | Gateway `/v1/models` returns bare ids only (verified) → a fetch adds nothing dispatchable; built-ins already ship static `MODELS` arrays                                                                                                                                       |
| Uncataloged / new ids      | default **chat** family, no limits (compaction off)                                                                                                                                                                                                      | Every advertised model must be dispatchable; chat is the broadest transport                                                                                                                                                                                                    |
| Custom-provider types      | rename `openai-compatible` → `openai-responses-compatible`; add `openai-completions-compatible`                                                                                                                                                          | Explicit transport naming; existing Responses configs unchanged in meaning                                                                                                                                                                                                     |
| Thinking round-trip (chat) | persist `reasoning` items as plaintext `reasoning_content`, merged into an immediately-following assistant message (text **or** tool_calls); emit the `reasoning` output item **before** any following output from the same choice, no `ProviderPayload` | Chat has no encrypted/thinking payload; plaintext is the OVMS-verified path; emission order keeps `[reasoning, …]` so the outbound merge fires; the merge reconstructs the byte-stable native DeepSeek/OAI assistant-message shape (KV-cache reuse), not merely tool adjacency |
| Chat output cap            | `max_tokens` (not `max_completion_tokens`)                                                                                                                                                                                                               | Broadest OpenAI-compatible support (matches `@ai-sdk/openai-compatible`)                                                                                                                                                                                                       |
| Presets (opencode-go)      | none in v1; non-empty preset **rejected** in `validateConfig`                                                                                                                                                                                            | Fail-fast, not silent ignore; subscription provider stays simple                                                                                                                                                                                                               |
| Pricing                    | **not shipped** in the opencode-go roster                                                                                                                                                                                                                | Subscription-billed; hand-maintained rows go stale; cost degrades to "not computable" (`engine.ts:1237-1239`)                                                                                                                                                                  |
| `OpenAIChatProvider` shape | thin: credentials + provider name + `buildParams` seam + `stream`                                                                                                                                                                                        | No built-in catalog to override → `modelLimits`/`supportsMaxOutputTokens` would be dead state                                                                                                                                                                                  |

## The chat/completions transport (`@harness/openai-core`)

New stateless exports, symmetric with the Responses transport:

### `buildChatParams(request): ChatCompletionCreateParamsStreaming`

Maps a `ModelRequest` onto native streaming chat params:

- `model`, `stream: true`, `stream_options: { include_usage: true }`.
- `max_tokens` from the advisory `request.maxOutputTokens` (absent → omitted).
- `tool_choice` from `request.toolChoice` (`auto`/`none`).
- `tools`: only `kind: "function"` schemas → `{ type: "function", function: { name, description, parameters } }`. **A `kind: "custom"` tool throws** — the chat path is function-only (the SDK offers `type: "custom"` chat tools, but local/OVMS backends reject them). For `opencode-go` this is an impossible-state guard: its chat family pins `string_replace`, which never routes a custom tool. For config-defined `openai-completions-compatible` providers the schema rejects `fileTools: "apply_patch"` (see Config schema) so the same invariant holds there.
- **At most one leading system message.** `instructions` and every `context` item
  map to system role; emit a single leading `{ role: "system", content }` message
  whose text is the instructions followed by each context item's text joined by
  `"\n\n"` (OpenAI chat APIs reject more than one system message). This **hoists**
  mid-conversation `context` items (tool-staged, appended after their tool result)
  into the system prefix — a deliberate semantic choice; the Responses/Messages
  transports render context at its position instead. A plugin-appended
  `message` item with `role: "system"` is rejected with a loud throw (it would
  create a second system message).
- `messages` mapping of items (order preserved):
  - `message` → `{ role, content }`.
  - **`reasoning` → plaintext round-trip.** A `reasoning` item merges into the immediately-following assistant output:
    - followed by a `message` item → one assistant message `{ role: "assistant", content, reasoning_content }`;
    - followed by a `tool_call` item → the tool_call assistant message carries `{ role: "assistant", content: null, reasoning_content, tool_calls: [...] }` (the byte-stable native DeepSeek/OAI shape the backend emitted, for cache-stable round-trip);
    - followed by nothing (end of turn) → standalone `{ role: "assistant", content: null, reasoning_content }`.
      No `ProviderPayload` is read or written — chat reasoning is plaintext only.
  - `tool_call` → assistant message `{ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }` (or with `reasoning_content` when immediately preceded by a `reasoning` item, per the merge above).
  - `tool_result` → `{ role: "tool", tool_call_id, content }`. (`tool_result.status` is not transmitted — same as the Responses transport; acceptable, documented.)
  - `compaction` → `{ role: "user", content }`.
- `request.prompt` → trailing `{ role: "user", content }`.

### `toChatEvents(stream, provider, model, signal): AsyncIterable<ModelStreamEvent>`

Translates `ChatCompletionChunk`s:

- `choices[0].delta.content` → `text_delta`.
- `choices[0].delta.reasoning_content` (untyped in the SDK types; DeepSeek/GLM/
  Kimi/MiMo/Hy3 emit it) → `reasoning_delta`; accumulate.
  **Emit the accumulated `reasoning` output item immediately before ANY following
  output from the same choice — the first `content` delta OR a `tool_call`
  completion — then continue with that output.** This preserves the `[reasoning, …]`
  log order the engine and the outbound merge rule expect, and keeps the
  tool_call assistant message adjacent to its `tool` results. If a choice produces
  only reasoning, emit the `reasoning` item at the terminal finish/stream end.
  The `reasoning` event carries no `payload`.
- `choices[0].delta.tool_calls` → accumulate by `index` (fragmented `name` /
  `arguments`), emit `tool_call` events when the choice finishes with
  `finish_reason: "tool_calls"`. Arguments parsed with the same tolerant
  `parseArgs` as the Responses transport.
- **`finish_reason: "length"`** → completed, not an error. Drop **all** accumulated
  tool calls (a length-truncated turn produced no usable call), then emit the
  partial text. (`tool_call` events are otherwise gated on
  `finish_reason: "tool_calls"`, so the length case never emits calls.)
- **`completed` fallback**: if a terminal finish_reason was observed but no
  `include_usage` tail chunk arrives, still emit `completed` with zeroed usage —
  otherwise the engine throws "provider stream ended without a 'completed' event"
  and records no spend.
- Terminal chunk with `usage` (`include_usage`) → `completed` event:
  `inputTokens = usage.prompt_tokens`, `outputTokens = usage.completion_tokens`,
  `cachedReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0`
  (`prompt_tokens_details` is typed in the SDK; only `reasoning_content` needs a
  loose cast).
- `signal.aborted` → return.
- **Errors:** `toChatEvents` itself does NOT normalize overflow — a body-level 400
  from `client.chat.completions.create()` throws before the generator runs. The
  provider's `stream` wrapper owns the `ContextWindowExceededError` mapping
  (below), mirroring the existing providers.

### `OpenAIChatProvider` (class)

Thin shell: constructor takes `credentials`, optional `provider` name; protected
`buildParams` override seam for config-defined providers; `listModels`/`validateConfig`
same shape as `OpenAIResponsesProvider`. `capabilities()` returns
**`fileTools: "string_replace"`** (function-only — NOT `apply_patch`, which the
Responses provider uses; a chat family must never route the freeform custom tool).
`stream()` → `client.chat.completions.create(params, { signal })` → `toChatEvents`,
with the 400/context → `ContextWindowExceededError` catch around the whole stream.
No `modelLimits` map, no `supportsMaxOutputTokens` flag — chat always honors
`max_tokens`.

Exports added to `packages/openai-core/src/index.ts`: `buildChatParams`,
`toChatEvents`, `OpenAIChatProvider`.

## The `opencode-go` provider (new `@harness/opencode-go` package)

Deps: `@harness/protocol`, `@harness/openai-core`, `@harness/anthropic-core`,
`@harness/openai-api`, `@harness/anthropic-api`. Workspace (`packages/*`) and
`tsconfig` (`packages/*/src/**/*.ts`) pick it up with no root edits.

### Transport dispatch (delegation)

One `OpenCodeGoProvider` (registry id `opencode-go`) is a thin switch over three
inner provider instances built from the shared key:

- **chat family** → `OpenAIChatProvider` (`client` baseURL
  `https://opencode.ai/zen/go/v1`, `/chat/completions`).
- **responses family** → a Responses subclass (`client` baseURL
  `https://opencode.ai/zen/go/v1`, `/responses`).
- **messages family** → an Anthropic Messages subclass (`client` baseURL
  `https://opencode.ai/zen/go` — root, since the SDK appends `/v1/messages`).

The inner providers are subclasses in `packages/opencode-go` that override only
what opencode-go's roster changes, mirroring the existing `Custom*Provider`
seams (`packages/custom-providers/src/custom-openai.ts`,
`custom-anthropic.ts`):

- **messages subclass**: overrides `buildConfig` to return
  `{ maxTokens: <roster maxOut> }` with no `thinking`/`effort` — otherwise stock
  `AnthropicProvider.buildConfig` falls back to `MAX_TOKENS_FALLBACK = 8192` and
  silently truncates MiniMax/Qwen generation. `client.messages.create(params, { signal })`
  comes from `AnthropicProvider.stream` unchanged.
- **responses subclass**: overrides `buildParams` to set
  `reasoning: { effort: "medium", summary: "auto" }` (default) and, if the Go
  gateway rejects `include: ["reasoning.encrypted_content"]`, drop that include
  (flagged in Unresolved). Keeps `max_output_tokens` advisory.
- **chat family**: the thin `OpenAIChatProvider` delegates directly (no catalog to
  override; honors `max_tokens`).

`OpenCodeGoProvider` overrides the outer `listModels`/`capabilities`/`validateConfig`
with its own roster and family table, and `stream(request, signal)` dispatches
`yield* inner.stream(request, signal)` by the model's compiled family; **unknown
ids (uncataloged) dispatch on the default `chat` family**. Each inner provider
applies its own correct overflow mapping — no unified catch, no per-family regex.

`capabilities(model)` returns the family's `fileTools`:
`apply_patch` for the responses family (gpt-5.6-luna), `text_editor` for the
messages family (MiniMax/Qwen), `string_replace` for the chat family (function-only,
since the chat transport is function-only).

`validateConfig`: rejects a non-empty `preset` (fail-fast; no preset axis in v1).
Uncataloged models pass through to the SDK (same posture as built-ins).

### Catalog

Static compiled roster in the package (mirroring `openai-core`/`anthropic-core`
`MODELS` arrays) — **no runtime fetch, no `buildPlugin` async**. `listModels()`
is synchronous and returns the compiled `ModelInfo[]`. Roster drift is handled by
a future plan (the models subsystem's deferred "automatic model discovery"
item), not speculative picker machinery: the gateway's `GET {base}/models`
returns bare ids only (verified 2026-08-08), so a fetch could not add a
correctly-dispatched model.

- No pricing rows in the catalog (subscription; cost not computable).

### Compiled roster (models.dev `opencode-go` + gateway `/v1/models`, 2026-08-08)

Family per the Go docs; models.dev `npm` tags are a cross-check. Deprecated
entries stay cataloged so old conversations keep capacity math. All ids verified
present on the gateway's live `/v1/models` list (25 models, 2026-08-08); the
roster below is the 25 live models.

| model                     | family      | context | maxOut |
| ------------------------- | ----------- | ------- | ------ |
| grok-4.5                  | responses\* | 500000  | 500000 |
| glm-5.2                   | chat        | 1000000 | 131072 |
| glm-5.1                   | chat        | 202752  | 32768  |
| glm-5 (deprecated)        | chat        | 202752  | 32768  |
| kimi-k3                   | chat        | 1048576 | 131072 |
| kimi-k2.7-code            | chat        | 262144  | 262144 |
| kimi-k2.6                 | chat        | 262144  | 65536  |
| kimi-k2.5 (deprecated)    | chat        | 262144  | 65536  |
| deepseek-v4-pro           | chat        | 1000000 | 384000 |
| deepseek-v4-flash         | chat        | 1000000 | 384000 |
| mimo-v2.5                 | chat        | 1000000 | 128000 |
| mimo-v2.5-pro             | chat        | 1048576 | 128000 |
| mimo-v2-pro (deprecated)  | chat        | 1048576 | 128000 |
| mimo-v2-omni (deprecated) | chat        | 262144  | 128000 |
| hy3                       | chat        | 256000  | 64000  |
| hy3-preview               | chat        | 256000  | 64000  |
| gpt-5.6-luna              | responses   | 1050000 | 128000 |
| minimax-m3                | messages    | 1000000 | 131072 |
| minimax-m2.7              | messages    | 204800  | 131072 |
| minimax-m2.5 (deprecated) | messages    | 204800  | 65536  |
| qwen3.8-max               | messages    | 1000000 | 131072 |
| qwen3.7-max               | messages    | 1000000 | 65536  |
| qwen3.7-plus              | messages    | 1000000 | 65536  |
| qwen3.6-plus              | messages    | 1000000 | 65536  |
| qwen3.5-plus (deprecated) | messages    | 262144  | 65536  |

\* `grok-4.5` shows `@ai-sdk/openai` (Responses) on models.dev; the Go docs put it
on `/chat/completions`. **Compiled default is `responses`** (models.dev's
explicit tag), corrected by the live Go smoke before the roster is frozen.

### Auth entry (`packages/cli/src/auth.ts`)

Uses the existing `apiKeyEntry` helper (synchronous `createPlugin` — the catalog
is compiled, so no async build is needed):

- `id`: `opencode-go`, label `OpenCode Go (API key)`, env var `OPENCODE_API_KEY`,
  validate non-empty (no documented key prefix).
- `defaultModel`: `{ provider: "opencode-go", model: process.env.OPENCODE_MODEL ?? "gpt-5.6-luna" }`.
- `createPlugin`: `({ apiKey }) => createOpenCodeGoPlugin({ apiKey })`.

## Config schema changes (`packages/config/src/settings.ts`)

- Rename the union literal `"openai-compatible"` → `"openai-responses-compatible"`.
  Keep the same fields (`sendInstructionsAsSystem` stays Responses-only).
- Add `"openai-completions-compatible"` branch: `customProviderBase` +
  `presets` (reuse `openaiPresetSchema`: temperature/topP/maxTokens/
  frequencyPenalty/presencePenalty/extraBody). `fileTools` default
  `string_replace`, and the branch **rejects `fileTools: "apply_patch"`** (the
  workspace would otherwise route the freeform `apply_patch` custom tool into a
  function-only transport and fail at runtime — reject at schema time instead).
  No `sendInstructionsAsSystem` (chat renders instructions as a system message
  natively).
- **Rename error message**: a `superRefine` on the union **never fires** when the
  inner `z.discriminatedUnion` fails (zod 4.4.3 aborts before parent refinements),
  and `.error()` is not a zod 4 API. Implement the hint as a pre-parse check on the
  `customProviders` record: scan entries for `type === "openai-compatible"` and
  raise a dedicated error naming the rename. **Centralize it in a single exported
  `parseSettingsDoc(raw, path)`** (pre-parse scan + `safeParse` + `formatIssue`)
  and route BOTH the settings resolver (`resolve.ts`) and the CLI startup path
  (`config/write.ts` `readGlobalSettings`, which is a separate `safeParse` that
  does not flow through `resolve.ts`) through it — so the hint fires at harness
  startup and through `resolveSettings`. (Note: `auth login` persistence goes
  through `writeSettings`' own `safeParse` at `write.ts:62`, a third parse site;
  routing it through `parseSettingsDoc` too is optional — the resolver + startup
  paths are the stated acceptance.) Assert the exact message in `resolve.test.ts`.
  Also update the stale `"openai-compatible"` comment at `settings.ts:58`. The
  feature shipped one commit ago (`1a3a340`), so breaking the old literal is
  accepted; docs carry the migration.

`custom-providers` factory: rewrite as an **exhaustive switch** over the three
union literals (no else-default — the current else silently turns a mishandled
type into an Anthropic provider). `"openai-completions-compatible"` →
`CustomOpenAICompletionsProvider extends OpenAIChatProvider` (drop-in mirror of
`CustomOpenAIProvider`): applies presets as chat sampling knobs — including
`preset.maxTokens` → `max_tokens` (NOT `max_output_tokens`, which is the Responses
field) — keeps `fileTools`, single-model catalog, preset guard.

## Invariants

- Every transport normalizes to the same `ModelStreamEvent` contract with
  terminal `completed` + usage; cancellation aborts the underlying stream.
- Chat reasoning is plaintext round-trip only; never a replayable payload; the
  `reasoning` output item is emitted before any following output of the same
  choice.
- `ContextWindowExceededError` is the only normalized overflow signal, mapped in
  the provider stream wrappers (not inside the stateless mappers); the inner
  opencode-go providers inherit theirs.
- The opencode-go catalog is a static compiled roster — no runtime fetch, no
  mid-session mutation; `listModels` stays synchronous.
- Every advertised model is dispatchable (default chat family for unknown ids).
- A chat-family request carries **at most one** leading system message.
- Presets remain provider-opaque strings; a preset on `opencode-go` is rejected,
  not ignored.

## Non-goals

- OpenCode Zen (pay-per-request, different base URL) — future plan.
- A generic "universal provider" that auto-detects API shape per model.
- Live catalog discovery/refresh, disk caching, staleness machinery, or picker "dimming"
  (gateway `/v1/models` returns bare ids only — a fetch adds nothing dispatchable).
- Per-model effort/reasoning presets on the opencode-go provider.
- Converting the built-in OpenAI provider away from Responses
  (`encrypted_content` round-trip stays the cloud path).
- `finish_reason` "length" surfaced as a distinct error or continue-trigger.
- Chat `type: "custom"` tools (function-only; the SDK offers them but local
  backends reject them).

## Implementation slices

### Slice 1 — chat/completions transport in `openai-core`

`request.ts` (`buildChatParams`), `stream.ts` (`toChatEvents`), `provider.ts`
(`OpenAIChatProvider`, thin, `capabilities` = string_replace), `index.ts` exports.
Unit tests: request mapping (instructions/messages/reasoning merge into message
AND tool_call/single system message/tool_call/tool_result/compaction/context/
prompt/custom-tool throw/system-role message throw); stream translation (deltas,
`reasoning_content` → `reasoning` item **before** following output (content OR
tool_call), tool-call fragmentation/aggregation, `length` drops all tool calls,
`completed` fallback when no usage chunk, abort, terminal error).

### Slice 2 — config schema rename + new type

`settings.ts` union rename + `openai-completions-compatible` branch (rejects
`fileTools: "apply_patch"`) + centralized `parseSettingsDoc(raw, path)` rename
hint shared by `resolve.ts` and `write.ts`; update `resolve.test.ts` and the
existing `custom-providers.test.ts` factory tests that pass the old literal;
rewrite factory as exhaustive switch; add `custom-openai-completions.ts` (presets
map `maxTokens` → `max_tokens`) + factory wiring + tests.

### Slice 3 — `opencode-go` package

Scaffold `packages/opencode-go` (deps: protocol, openai-core, anthropic-core,
openai-api, anthropic-api). `roster.ts` (static compiled 25-model table + family
map), `provider.ts` (`OpenCodeGoProvider` = three inner provider instances:
`OpenAIChatProvider` + a responses subclass + an Anthropic subclass overriding
`buildConfig` for roster `maxTokens`; family switch on `stream`/`capabilities`/
`validateConfig`/`listModels`; unknown id → chat family; preset rejection),
`index.ts` (`createOpenCodeGoPlugin`, sync). Unit tests: roster mapping, unknown-id
default family, family dispatch, capabilities, baseURL construction (root for
Messages, `/v1` for OpenAI), messages subclass `maxTokens` from roster, responses
subclass `reasoning` + `max_output_tokens`, preset rejection.

### Slice 4 — CLI wiring

`auth.ts` `apiKeyEntry` for `opencode-go` (sync `createPlugin`); `auth.test.ts`
covers key present/absent. `index.tsx` unchanged (`buildPlugin` is already
iterated).

### Slice 5 — validation + docs

Live smoke against Go (chat + responses + messages each one request, tool loop,
prior-reasoning round-trip; reconcile grok-4.5 family and the encrypted-content
include) and against a local OVMS chat-completions endpoint (prior-thinking
round-trip, standalone `content: null` acceptance, reasoning→tool_call merge
shape, tool loop, `length` recovery). Update `docs/subsystems/models/README.md`
(OpenAI family section, new `OpenCode Go` family, config types, source map incl.
`packages/opencode-go` and `custom-providers`, record the **pricing exception**:
subscription providers may omit pricing, cost rows record null),
`docs/subsystems/models/PLAN.md` (scoped lift of the "Automatic model discovery
and pricing fetches" deferral for opencode-go only — now a static roster, no
fetch), `PLAN.md` (add OpenCode Go to the provider list ~line 69; bump the As-of
date), `docs/TESTING.md` (coverage notes: live-smoke-only boundaries, deferred
engine-loop chat regression).

## Affected boundaries

| Package                                                     | Change                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/openai-core`                                      | `buildChatParams`, `toChatEvents`, `OpenAIChatProvider` (string_replace), exports |
| `packages/config/src/settings.ts`, `resolve.ts`, `write.ts` | type rename + `openai-completions-compatible` + centralized rename-hint           |
| `packages/custom-providers`                                 | `custom-openai-completions.ts`, exhaustive factory switch                         |
| `packages/opencode-go` (new)                                | static roster, three inner providers, plugin factory                              |
| `packages/anthropic-core`, `anthropic-api`                  | reused as-is for the messages family (no changes)                                 |
| `packages/cli/src/auth.ts`                                  | `opencode-go` auth entry (`apiKeyEntry`)                                          |
| `docs/subsystems/models/*`, `docs/TESTING.md`, `PLAN.md`    | transport + provider + schema + pricing exception + coverage notes                |

## Validation

### Unit tests

- Chat request mapping incl. reasoning merge (into message AND into tool_call),
  single leading system message (context hoisting, `"\n\n"` join), system-role
  message throw, and custom-tool throw.
- Chat stream: deltas; `reasoning_content` accumulation → `reasoning` item
  emitted before the following output (text **and** the reasoning→tool_call
  no-text sequence); tool-call fragmentation/aggregation; `length` drops all
  tool calls; `completed` fallback without a usage chunk; abort; overflow error
  via the provider wrapper.
- Schema: old literal rejected with the rename-hint message (through BOTH the
  resolver and `readGlobalSettings` startup paths); new type parses; preset
  knobs map (`maxTokens` → `max_tokens`); `fileTools: "apply_patch"` rejected on
  the completions type. Schema-parse tests live in `resolve.test.ts` (via
  `resolveSettings` against a temp file, matching the existing pattern).
- opencode-go: roster mapping (25 models), unknown-id default chat family, family
  dispatch, capabilities per family, baseURL construction (root for Messages,
  `/v1` for OpenAI), messages subclass `maxTokens` from roster, responses subclass
  `reasoning` + `max_output_tokens`, preset rejection, no fetch (no network calls).
- auth entry: key present/absent registers the plugin.
- factory: exhaustive switch — each of the three types maps to the right provider
  subclass; a future unknown type is a compile error.

### Live smoke (Slice 5)

- Go: one chat-family request with a prior `reasoning` item round-trip; one
  responses request (gpt-5.6-luna); one messages request (MiniMax/Qwen) — including
  `cache_control`/`tool_choice`/`system` array acceptance; tool loop; grok-4.5
  family reconcile; encrypted-content include reconcile.
- OVMS: prior-thinking round-trip, standalone `content: null` acceptance,
  reasoning→tool_call merge shape, tool loop, `finish_reason: "length"` recovery.

### Failure scenarios

- Unknown model id → default chat family, no catalog entry (compaction off), streaming works.
- Custom tool in a chat-family request → loud throw (impossible state).
- System-role `message` item in a chat request → loud throw (second system message).
- Context overflow on any family → `ContextWindowExceededError` (each inner
  provider's own mapping).
- Backend ends without an `include_usage` chunk → `completed` with zero usage (no engine throw).
- Mid-session 401/403 (bad/revoked key) → turn fails with the SDK status message,
  surfaced like the built-ins (optionally hint `harness auth login --provider
opencode-go`).

## Documentation impact

- `docs/subsystems/models/README.md`: chat/completions transport under the OpenAI
  family; new `OpenCode Go` section (three-protocol dispatch, static roster,
  reasoning round-trip); config types renamed + new; source map includes
  `packages/opencode-go` and `custom-providers`; record the pricing exception
  (subscription providers may omit pricing; cost rows record null).
- `docs/subsystems/models/PLAN.md`: note the scoped lift of the "automatic model
  discovery and pricing fetches" deferral for opencode-go only — resolved as a
  static compiled roster (no fetch; the gateway `/v1/models` is bare-ids only).
- `PLAN.md`: add OpenCode Go to the provider list; bump the As-of date.
- `docs/TESTING.md`: record live-smoke-only boundaries and the deferred
  engine-loop chat regression.
- `docs/plans/cross-cutting/2026-08-08-custom-model-providers.md`: update its
  example and text from the old `"openai-compatible"` literal to
  `"openai-responses-compatible"` (the sibling plan's schema section still shows
  the old name).

## As built (2026-08-08)

- `packages/openai-core`: `buildChatParams`, `toChatEvents`, `OpenAIChatProvider`
  (capabilities = `string_replace`) exported; chat tests in `chat-request.test.ts`,
  `chat-stream.test.ts`, `chat-provider.test.ts`.
- `packages/config`: `"openai-responses-compatible"` rename +
  `"openai-completions-compatible"` (rejects `fileTools: "apply_patch"`);
  centralized `parseSettingsDoc`/`parseProjectDoc`, routed through
  `resolve.ts` (per-layer) and `write.ts` (`writeSettings`,
  `readGlobalSettings`, global `updateLocalSettings`). No migration hint for
  the old `"openai-compatible"` literal: it fails the union and the error
  lists the valid type names.
- `packages/custom-providers`: exhaustive factory switch;
  `CustomOpenAICompletionsProvider` (presets map `maxTokens` → `max_tokens`).
- `packages/opencode-go` (new): static 25-model roster (verified against the
  gateway's live `/v1/models`), `OpenCodeGoProvider` delegating to the chat
  `OpenAIChatProvider`, a Responses subclass (drops `include`), and an Anthropic
  Messages subclass (`buildConfig` supplies roster `maxTokens`); `familyOf`
  defaults unknown ids to `chat`; `validateConfig` rejects presets.
  `createOpenCodeGoPlugin` builds the OpenAI client at
  `https://opencode.ai/zen/go/v1` and the Anthropic client at the server root.
- `packages/cli`: `apiKeyEntry` for `opencode-go` (`OPENCODE_API_KEY`, default
  model `gpt-5.6-luna`).
- Live smoke: `packages/opencode-go/src/provider.live.test.ts` (chat / responses /
  messages / reasoning round-trip), skipped without `OPENCODE_API_KEY`.
- Docs updated: `docs/subsystems/models/README.md` (chat transport, OpenCode Go
  family, config types, pricing exception, source map),
  `docs/subsystems/models/PLAN.md` (scoped deferral lift), `PLAN.md` (provider
  list, As-of date), `docs/TESTING.md` (coverage notes), and the sibling plan's
  renamed literal.

## Unresolved / risks

- **grok-4.5 family**: shipped in the compiled roster as `responses` (its models.dev
  tag; the Go docs still suggest chat/completions). The conflicting family is
  pinned by test and streams on Responses today; re-run the live Go smoke before
  relying on it and flip the roster row if the resource rejects.
- **goMc responses reasoning**: `include: ["reasoning.encrypted_content"]` is dropped
  unconditionally for the opencode-go responses family (`GoResponsesProvider`),
  so Go gpt-5.6-luna reasoning is live-display-only and does not replay outbound.
  Accepted per non-goals; a futures switch to keep the include would need a live
  trunk that accepts it.
- **Messages-family request acceptance**: whether the Go `/v1/messages` endpoint
  accepts `cache_control` (breakpoints), `tool_choice`, and the `system` array
  form as built by `buildMessages` is unverified — the messages live smoke asserts
  only a completed turn, not these fields.
- **Messages-family reasoning**: whether Go surfaces MiniMax/Qwen reasoning via
  the Messages thinking blocks is unverified; if absent, reasoning is simply not
  displayed (acceptable).
- **Standalone `content: null` and reasoning→tool_call merge shapes**: accepted
  per the user OVMS trace and covered by the chat-request unit tests
  (`content: null` standalone and merged assistant message). A fresh OVMS live
  smoke is not committed; the live path is a documented smoke boundary
  (`docs/TESTING.md`), not a checked-in test.
- **Context hoisting**: chat hoists tool-staged `context` items into the leading
  system message, diverging from Responses (developer at position) and Messages
  (user at position) — a deliberate semantic choice, documented; no smoke asserts
  the multi-system rejection (OVMS accepts one leading system).
- **Interleaved reasoning**: a choice that streams `reasoning_content` again after
  the first `content` delta is shown live but not folded into the persisted
  `reasoning` item (the finalized item is emitted once, at the first boundary).
  Fixture-tested; a backend that interleaves reasoning mid-text is a known display
  boundary, not a persisted-content guarantee.
- Chat `reasoning_content` is untyped in the OpenAI SDK; a loose cast is required
  (documented in code).
- **Roster drift**: a new Go model (beyond the 25 verified 2026-08-08) won't
  appear until a future catalog-discoverability plan lands; unknown ids already
  stream on the default chat family, so the gap is picker visibility only.

## Review loop (2026-08-08)

Independent review of the implementation-that-plan found three fix-class issues,
now implemented and tested:

- `buildChatParams` no longer merges pending `reasoning` onto a non-assistant
  message; it flushes a standalone assistant reasoning message instead
  (`chat-request.test.ts`, request-mapping regression).
- `toChatEvents` no longer `continue`s past a chunk that carries both
  `reasoning_content` and a content delta (which dropped the text);
  `reasoning` output-item emission stays single at the first output boundary.
- The zeroed-usage `completed` fallback is gated on having seen a terminal
  `finish_reason`: a stream that dies mid-flight with no finish and no usage tail
  now ends without `completed`, so the engine records no spend and surfaces the
  missing-event error (fail fast), rather than silently accounting an empty turn.

Plus new schema tests (completions type parses, `apply_patch` and
`sendInstructionsAsSystem` rejected) and the `readGlobalSettings` startup path.

Focused re-review (correctness; remaining notes, all known-boundary, not
actioned):

- The standalone reasoning flush in `buildChatParams` is enforced on non-
  assistant `message` items only. `tool_result` and `compaction` items set
  `pendingReasoning` in no current engine ordering (`reasoning` is always
  followed by its own assistant message or a `tool_call` in
  `engine.ts:607-619`, and compactions fold before a retained reasoning
  item), so no extra flush point is added today. If a future item ordering
  makes that reachable, flush must be added to those branches.
  **Superseded:** the `buildChatParams` rewrite (2026-08-09) now flushes the
  open generation on `tool_result`, `compaction`, and `context`.
- Interleaved streams that emit `reasoning_content` again after the first
  output boundary show those later segments live but do not persist them
  into the already-finalized `reasoning` item (`stream.ts:149-155`). Same-
  capture design decision, already noted as a display boundary; not
  double-emitted and not a regression from the fix.
- Ordering of `reasoning` before `tool_call` from the same choice is now
  asserted strictly (`chat-stream.test.ts`), not just via `toContainEqual`.

Architecture/failure-risk review (independent lens, 2026-08-09) — no blockers;
the transport invariants, layering, and plugin wiring held. Actioned findings:

- Declared `openai` and `@anthropic-ai/sdk` as `devDependencies` of
  `@harness/opencode-go` (its live suite imports them directly; the versions
  match the sibling core packages so only one SDK type instance resolves).
- Added a strict full-shape request assertion to the messages-family streaming
  test (`opencode-go.test.ts`): roster `max_tokens`, no thinking/effort
  machinery, plain native body — the one wire surface previously untested
  beyond `max_tokens`.
- Centralized the duplicated project-doc parse+throw: new `parseProjectDoc`
  in `settings.ts`, used by both `updateLocalSettings` (`write.ts`) and the
  project layer of `readDoc` (`resolve.ts`), matching `parseSettingsDoc`'s
  error format.
- Documented in `docs/subsystems/models/README.md` the unconditional
  `stream_options.include_usage` (which some strict backends reject), the
  zeroed-usage `completed` fallback for backends that omit the usage tail, and
  the no-`completed` on mid-flight death.

Deferred for live evidence (not actioned here):

- `stream_options.include_usage` / `tool_choice` have no per-provider opt-out
  yet; decide after real local-backend smoke (vLLM/Ollama/OVMS).
- Interleaved second reasoning segments after the first content boundary are
  display-only (see the correctness note above).

Also on 2026-08-09, the rename-hint machinery was removed entirely (per an
explicit decision not to carry backwards compat): a stale `"openai-compatible"`
literal now fails the union and the error lists the valid type names, with no
targeted migration message. The "As built" entry above reflects the resulting
wiring.
