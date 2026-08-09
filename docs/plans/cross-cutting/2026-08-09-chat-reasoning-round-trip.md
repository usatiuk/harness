# Chat/completions reasoning round-trip refactor

**Status:** Complete — implemented and validated on 2026-08-09; `npm run check`
(typecheck, lint, format, 685 tests) passes. Live smoke is opt-in behind
`OPENCODE_API_KEY` and has not been run in this session. See "As built".
**Created:** 2026-08-09
**Area:** cross-cutting (openai-core; opencode-go chat family; config-defined `openai-completions-compatible` providers)

Corrects the chat/completions transport shipped by
`docs/plans/cross-cutting/2026-08-08-opencode-go-and-chat-completions.md`. This plan
supersedes that plan's "Thinking round-trip (chat)" merge rule, its `buildChatParams`
description, and its "interleaved reasoning is a display-only boundary" notes (see
"Documentation impact").

## Goal

Make the chat/completions transport reconstruct a model generation's **native
assistant message** — `content`, `reasoning_content`, and `tool_calls` on **one**
wire message — so that every piece of reasoning the harness recorded is passed
back to the API, with no ordering heuristics and no per-model special cases.

**Completion condition:** a chat-family conversation whose tool-calling turn also
produced reasoning and text reconstructs that turn as the native single assistant
message on every follow-up request; the DeepSeek 400 ("The `reasoning_content` in
the thinking mode must be passed back to the API") disappears; regression tests
pin every wire shape and the fail-fast guard; docs record the invariant; live
smoke (opt-in) confirms the corrected shape is accepted by the gateway.

## Grounding and evidence

### The defect

The harness records one model generation as separate items — `reasoning` (one or
more), assistant `message` text, `tool_call` ×N — then `tool_result` ×N
(`packages/core/src/engine.ts:585-626`, `#appendOutputItem` at `:709`). Each
transport must rebuild the provider-native request from these.

`buildChatParams` (`packages/openai-core/src/request.ts`) mapped items 1:1 to wire
messages and attached a pending `reasoning` item only to the **immediately
following** assistant output — either the text message **or** the first tool-call
message. A generation with reasoning + text + multiple tool calls therefore
produced a text message carrying `reasoning_content` and tool-call messages
carrying none. DeepSeek's thinking mode rejects the follow-up request:

> for requests carrying the `tools` parameter, the `reasoning_content` must be
> fully passed back to the API in all subsequent requests. If your code does not
> correctly pass back `reasoning_content`, the API will return a 400 error.
> (api-docs.deepseek.com/guides/thinking_mode, "Tool Calls")

The documented native shape is one assistant message:
`{ role: "assistant", content, reasoning_content, tool_calls }`.

**Live evidence** (conversation `ffd7dbbd-5ca1-46d4-9a79-b55a85a2bac0`,
`C:\Users\stepu\.harness\store.db`, read-only): turn 2 recorded `reasoning`
(seq 4) → assistant `message` (seq 5) → `tool_call` ×3 (seq 6-8) → `tool_result`
×3 (seq 9-11). The request after the tool results — which carries `tools` —
failed with the 400. Earlier requests in the same conversation, whose assistant
messages all carried `reasoning_content`, succeeded; the failing request's only
assistant messages lacking `reasoning_content` were the three tool-call messages.
That isolates the defect to the tool-call reconstruction.

### Why Responses and Anthropic are not affected

- **OpenAI Responses** has a first-class `{ type: "reasoning", id, summary,
encrypted_content }` input item. The harness stores the `encrypted_content` blob
  - id as an opaque payload on inbound (`openai-core/payload.ts`) and `toInputItem`
    replays it 1:1 as a native reasoning item (`openai-core/request.ts:41-54`). There
    is no "glue reasoning onto a message" step; tool calls are separate
    `function_call` items. On payload mismatch the item is skipped and OpenAI accepts
    the omission (lost KV-cache reuse only).
- **Anthropic Messages** was written as per-generation accumulation from the start:
  `toMessages` (`anthropic-core/request.ts:51-117`) collects a generation's
  thinking block, assistant text, and tool_use into **one** assistant message
  `[thinking, text, tool_use]`, flushed at each user-side boundary. This is the
  shape the chat transport lacks.

Chat/completions is the only transport where reasoning is plaintext and must be
re-glued onto the assistant message — and its glue was the 1:1 ordering heuristic.

## Chosen approach

### `buildChatParams`: per-generation native-message accumulation

Rewrite the message-assembly loop in `buildChatParams` (signature unchanged) as an
accumulator, mirroring `toMessages`' boundary discipline:

- Open one `assistant: ChatMessageWithReasoning` lazily on the **first assistant-side
  item** of a generation, then fold every assistant-side item into it until a
  user-side boundary:
  - `reasoning` → `reasoning_content` (concatenated if more than one; position-
    independent — it folds in whether it arrives before or after the text).
  - `message` (role `assistant`) → `content` (concatenated across text items).
  - `tool_call` → appended to `tool_calls`.
- User-side items close the generation (`flushAssistant` → emit) and emit their own
  wire message:
  - `message` (role `user`) → `{ role: "user", content }`.
  - `tool_result` → `{ role: "tool", tool_call_id, content }` (`status` still not
    transmitted, same as the Responses transport).
  - `compaction` → `{ role: "user", content }`.
  - `context` → collected for the leading system message (hoisted, unchanged) and
    treated as a generation boundary.
- A `reasoning`-only generation (reasoning item, then a user-side boundary) is the
  natural degenerate case: the reasoning item opens the assistant message, nothing
  else folds in, and `flushAssistant` emits `{ role: "assistant", content: null,
reasoning_content }` (existing behavior, unchanged).
- Instructions + context still render as the single leading system message; a
  `message` item with role `system` still throws (second system message); freeform
  `custom` tools still throw (function-only); `request.prompt` still appends a
  trailing user message.

This removes the `pendingReasoning`/`ensureAssistant` fold and the standalone
special case of the draft design: the native message opens on the first
assistant-side item and is flushed at any user-side boundary. No item-ordering
assumptions remain.

### `toChatEvents`: fail fast rather than silently drop

Keep the current emission point (the finalized `reasoning` item is emitted once,
before the first following output). Add a guard: **if `reasoning_content` arrives
after the item was finalized** (`reasoningEmitted === true`), throw

```
chat stream interleaved reasoning after output; trailing reasoning cannot round-trip
```

instead of showing it live and dropping it from the persisted item. The guard keys
off `reasoningEmitted`, **not** "content seen": an interleaved
`content → reasoning → content` stream finalizes the item at the second content
delta, so reasoning between two content deltas is fully captured (the currently
working `[message, reasoning, message]` shape keeps working). Only reasoning that
arrives _after_ finalization throws. The thrown error is a plain `Error`; it
surfaces raw through `OpenAIChatProvider.stream`'s wrapper (which maps only
`ContextWindowExceededError` and rethrows everything else), aborting the turn.

This is the documented limitation, enforced loudly: the chat transport never
silently discards streamed reasoning. Reasoning before the finalization point is
always fully accumulated; reasoning after it cannot be persisted faithfully, so the
transport refuses rather than losing it.

### What does not change

- **Responses transport**: encrypted-content payload replay, provider/model-gated
  skip. API-imposed; unchanged.
- **Anthropic transport**: signature payload replay, lone-thinking-block drop
  (Anthropic's own constraint; chat instead emits a standalone reasoning message —
  a pre-existing, intentional divergence). Unchanged.
- **Item model / store / engine**: no change. The split item log stays canonical;
  transports remain the only reconstruction boundary. Consumers inherit the fix
  through the shared `buildChatParams`: `OpenAIChatProvider.stream`
  (`openai-core/provider.ts:214`), `CustomOpenAICompletionsProvider.buildParams`
  (`custom-providers/custom-openai-completions.ts`), and the compaction path
  (`core/policies.ts` `modelCompaction` → `models.invoke`).
- **No fabricated `reasoning_content`**: the field is emitted only when a
  `reasoning` item exists. A strict non-DeepSeek backend (OVMS/vLLM serving a
  non-reasoning model) could reject an unexpected provider-specific field, so the
  transport passes back exactly what was recorded — never invents it.

## Invariants

- One model generation renders as **at most one** assistant message carrying all of
  its `content`, `reasoning_content`, and `tool_calls`.
- Every recorded `reasoning` item either folds into its generation's native
  assistant message or is flushed as a standalone reasoning message — never
  silently dropped by the chat transport.
- A generation's reasoning rides the same wire message as its tool calls.
- The chat transport never silently discards streamed reasoning: reasoning that
  arrives after the item was finalized throws a loud error.
- The reconstruction is position-independent (no reliance on item ordering) and
  identical for every chat-family provider (opencode-go and config-defined
  completions-compatible, which share `buildChatParams`).

## Non-goals

- Changing the store's item model or the engine's append order.
- Buffering a whole generation in the inbound, or deferring the reasoning item to
  the terminal finish: deferral would capture interleaved reasoning without a throw
  but flips the persisted transcript order to `[message, reasoning]` (the reasoning
  block would render after the answer). The `[reasoning, …]` display order is a
  product invariant, so fail-fast is chosen to surface the boundary instead.
- Making Responses/Anthropic payload-bound replay unconditional.
- Emitting provider-specific fields on messages that never reasoned.

## Implementation slices

### Slice 1 — `packages/openai-core`

- `src/request.ts`: rewrite the `buildChatParams` message-assembly loop as the
  accumulator above; update the function doc comment to state the per-generation
  native-message invariant.
- `src/stream.ts` (`toChatEvents`): add the `reasoningEmitted`-keyed fail-fast
  guard described above.

### Slice 2 — unit regressions (`chat-request.test.ts`, `chat-stream.test.ts`)

`chat-request.test.ts`:

- The failing conversation shape: `reasoning` → assistant `message` → three
  `tool_call` → three `tool_result` renders exactly one assistant message with
  `content` + `reasoning_content` + all three `tool_calls`, followed by the three
  `tool` messages.
- `reasoning` → multiple `tool_call` (no text): one message with `reasoning_content`
  - all calls.
- Generation boundary: `reasoning` → `message` → `tool_call` → `tool_result` →
  `message` → `tool_call` renders **two** separate assistant messages; the second
  carries no reasoning and does not merge with the first.
- Position independence: `message` → `reasoning` → `tool_call`, and the realizable
  interleaved `[message, reasoning, message]` shape (`content → reasoning →
content` from an interleaving backend), both fold into one message with
  concatenated `content` and `reasoning_content`.
- Compaction/context boundary flush (realizable via the compaction-continuation
  path, `core/engine.ts:1219-1227`): `reasoning` → `compaction` renders a standalone
  reasoning message then a `user` message; `…` → `tool_result` → `compaction` →
  `reasoning` → `message` renders two generations with no cross-boundary reasoning.
- Existing expectations stay green: reasoning+message, reasoning+single tool_call,
  standalone reasoning, user-side standalone flush, system hoist (`"\n\n"` join),
  compaction→user, prompt append, custom-tool throw, system-role-message throw.

`chat-stream.test.ts`:

- **Fail fast**: a stream that emits `reasoning_content` after the item was
  finalized at a content boundary throws `/interleaved reasoning/` (nothing
  silently dropped). Fixtures cover (a) reasoning after a content delta and
  (b) the boundary is keyed on finalization, not on the first content delta
  (`content → reasoning → content` still completes, emitting `[reasoning, text]`).

### Slice 3 — live smoke (`packages/opencode-go/src/provider.live.test.ts`)

Extend the opt-in chat-family suite with the exact failing round-trip on
`deepseek-v4-flash`: a request whose items are `reasoning` → assistant `message` →
`tool_call` → `tool_result`, **carrying a `tools` array that declares the function
the `tool_call` references** (the DeepSeek 400 fires only when `tools` is present,
so the smoke must not be vacuous), followed by the trailing user steer that mirrors
the failing conversation. Assert completion without a 400. Skipped without
`OPENCODE_API_KEY`. The existing prior-reasoning round-trip test stays.

### Slice 4 — documentation

- `docs/subsystems/models/README.md`: replace the chat-transport reasoning sentence
  ("round-trips prior reasoning as plaintext `reasoning_content` on the assistant
  message that follows it") with the per-generation native-shape invariant, the
  DeepSeek requirement, and one sentence recording the fail-fast behavior.
- Sibling plan `2026-08-08-opencode-go-and-chat-completions.md`: add a banner near
  the title pointing to this plan; keep its `Status: Complete`. The superseded
  pieces are the "Thinking round-trip (chat)" locked-decision row, the
  `buildChatParams` description, and the two review-loop notes that call
  interleaved reasoning a tolerated display boundary.
- `docs/TESTING.md`: refresh the chat reasoning round-trip coverage note (the
  "merge into the following assistant output" wording) and record the fail-fast
  boundary.

## Affected boundaries

| Package / doc                           | Change                                                            |
| --------------------------------------- | ----------------------------------------------------------------- |
| `packages/openai-core/src/request.ts`   | `buildChatParams` accumulation + doc comment; no signature change |
| `packages/openai-core/src/stream.ts`    | `toChatEvents` fail-fast guard on interleaved reasoning           |
| `packages/opencode-go`                  | live smoke addition only                                          |
| `docs/subsystems/models/README.md`      | chat reasoning invariant + fail-fast note                         |
| `docs/plans/cross-cutting/2026-08-08-…` | supersession banner (status stays Complete)                       |
| `docs/TESTING.md`                       | regression coverage note                                          |

Consumers that inherit the fix with no code change: `OpenAIChatProvider`,
`CustomOpenAICompletionsProvider`, and the compaction path (all route through
`buildChatParams`).

## Validation

- Focused: `chat-request.test.ts`, `chat-stream.test.ts`, `chat-provider.test.ts`,
  `opencode-go.test.ts`.
- Full: `npm run check` (typecheck, lint, format, full Vitest suite).
- Live (opt-in, needs `OPENCODE_API_KEY`): the failing shape (with `tools`) completes
  on `deepseek-v4-flash`; prior-reasoning round-trip still passes.

## Failure scenarios

- A generation whose reasoning item sits anywhere within it → still folds into the
  one native message (position-independent).
- Backend emitting `reasoning_content` after the reasoning item was finalized →
  the transport throws a loud error, aborting the turn. This is a deliberate
  behavior change: today such streams complete with trailing reasoning silently
  dropped. It can affect chat-family backends that interleave reasoning after
  output (e.g. some config-defined local OVMS/vLLM endpoints); the limitation is
  documented and surfaced, never hidden.
- Tool-calling generation with no recorded reasoning (non-thinking model, or a
  resumed conversation that lost items) → no `reasoning_content` invented; a later
  request to a thinking model would reconstruct that turn without it. Recorded as a
  remaining gap: the harness only passes back what it captured.
- Provider/model switch on payload-bound transports → Responses/Anthropic skip
  replay (API-correct); chat always replays plaintext regardless.

## Documentation impact

As listed under Slice 4.

## Unresolved / risks

- Whether DeepSeek additionally requires `reasoning_content` on assistant messages
  of turns that never reasoned when `tools` is present is unverified. The harness
  records reasoning for every chat-family turn (thinking is default-on), so this
  only matters after a model/transport switch; not actioned, since fabricating the
  field risks strict non-DeepSeek backends.
- Live smoke is the only evidence the corrected shape is accepted by the gateway;
  unit tests pin the wire shape but cannot exercise server validation.
- The fail-fast can hard-fail turns on backends that interleave reasoning after
  output (accepted tradeoff; see Failure scenarios).

## As built (2026-08-09)

- `packages/openai-core/src/request.ts`: `buildChatParams` rewritten as the
  per-generation accumulator (`assistant` / `flushAssistant` / `ensureAssistant`,
  `AssistantMessageWithReasoning` narrowing `content` to `string | null`). One
  native assistant message per generation: content, reasoning_content, and all
  tool_calls together, position-independent; flushed at every user-side boundary
  (`message` user, `tool_result`, `compaction`, `context`, end of log); reasoning
  with no assistant output flushes as the standalone `content: null` message.
- `packages/openai-core/src/stream.ts`: `toChatEvents` guard throws when
  `reasoning_content` arrives after the item was finalized
  (`reasoningEmitted`), naming the `provider`/`model` in the error.
- Tests: `chat-request.test.ts` (+9: failing-conversation shape, no-text
  multi-call, `tool_result` boundary, position independence, interleaved
  `[message, reasoning, message]`, compaction and context boundaries,
  two-reasoning concatenation, standalone flush); `chat-stream.test.ts` (+2:
  fail-fast on trailing reasoning, content→reasoning→content still captured).
- `packages/opencode-go/src/provider.live.test.ts`: opt-in smoke for the 400
  shape (reasoning + text + `tool_call` + `tool_result` with a declared `tools`
  array and a trailing steer on `deepseek-v4-flash`); skipped without
  `OPENCODE_API_KEY`.
- Independent review (2026-08-09, four read-only lenses: correctness,
  architecture/failure risk, tests/evidence/docs, simplicity) found no blockers.
  Actioned: provider/model in the fail-fast error; a dedicated context-boundary
  regression; a two-reasoning concatenation regression; the sibling plan's
  "no flush needed" review-loop note flagged superseded. Deferred: a
  reasoning-after-`tool_calls`-finish fixture (same shared guard; unreachable
  after a terminal finish).
- Docs: this plan (Complete); models README chat-transport paragraph;
  `docs/TESTING.md` coverage notes; sibling plan supersession banner.
- Full validation: `npm run check` passes (685 tests, 28 skipped live tests).
- Remaining opt-in step: run the live smoke with `OPENCODE_API_KEY` to confirm
  gateway acceptance of the corrected wire shape.
