# Harness — Design Doc

A local-first, **provider-agnostic** coding-agent harness. The core is a tiny
kernel; **everything that is behavior is a plugin.** First concrete model adapter:
OpenAI Responses + ChatGPT/codex auth. The kernel is model-, tool-, and
UI-neutral and is designed to reach near-final shape in Phase 1 and then *not
grow* — later capability ships as plugins, not as kernel rewrites.

---

## 1. Context — why this exists

Two prior attempts live under `old/`. They are **cautionary prior art only** — no
code is imported, and no idea is justified by "old did it." They're kept as a
record of what went wrong.

- **`harness-old`** (~12k LOC) — full ambition up front. A **god-kernel**
  (`kernel.ts`, ~1482 LOC, ~44 public methods) owned profiles, conversations,
  turns, tool-executions, activities, interactions, execution-contexts,
  workspaces, assets, artifacts, state-namespaces, events, context-blocks,
  provider-events, approvals, and compaction — all first-class on day one.
  Plugins/subagents/MCP/sandbox were built before the conversation core was proven.
- **`harness-old2`** (~5k LOC) — the over-correction. Stripped tools, plugins,
  activities, approvals, subagents, MCP, sandbox. Cleaner but *too* minimal (no
  tool seam at all), and the loop re-derived "covered" state from all context
  builds on every pump.

The diagnosis: it "got weird fast — contracts unclear, abstractions leaky,
everything fragile, so a small intent change (*'I don't want queue, I want
steer'*) meant rewriting everything." Two root causes:

1. **Everything was first-class and entangled at once.** No concept earned its
   place; they all arrived together and cross-referenced.
2. **The control loop hard-coded its policies.** Input delivery, context
   selection, and approval were branches inside the loop, so changing one meant
   surgery on all of it.

**Goal:** modular and plugin-based, but *simple and straightforward*, with clean
interfaces — where the full ambition (tools, approvals, subagents, MCP,
background work) is reachable by **adding plugins, not rewriting the core.**

---

## 2. Research grounding (the decisive constraints)

**Provider APIs — the finding that shapes the core.** All three frontier
providers carry **opaque, encrypted reasoning state that must round-trip verbatim
during tool-calling turns:**
- **Anthropic Messages** — stateless (resend transcript); `thinking` blocks carry
  a `signature` preserved byte-exact; tool use = `tool_use`/`tool_result` blocks;
  prompt caching is a strict **prefix match**.
- **OpenAI Responses** — we run it **stateless**: `store:false` +
  `include:["reasoning.encrypted_content"]`, passing the encrypted reasoning back.
  (`previous_response_id` server-state is explicitly *not* used.)
- **Gemini** — stateless `contents[]`; `thoughtSignature` **must** be returned
  during function calls on Gemini 3 (else 4xx); only the first call-part carries
  it; order matters.

→ This makes **per-item opaque provider payloads** the load-bearing abstraction
for provider-agnosticism (§5), and dictates a **stateless core** (§3).

**Harness convergence.** opencode (client/server + a `ProviderTransform` seam +
SQLite); codex-rs (layered core; "turn" = one input→response cycle spanning many
model↔tool iterations); LangGraph (per-step checkpoints keyed by thread);
**pi.dev** (tiny core + 4 tools + *everything else is a package/skill*, no bespoke
plugin registry); Vercel AI SDK (`LanguageModelV2/V3` spec + typed message parts);
**Agent Client Protocol** (JSON-RPC `session/*` + streamed `session/update` +
`request_permission` — "LSP for coding agents"). These confirm the layering, the
"turn," and the tiny-core-plus-packages model. **External protocols (ACP
especially) are inspiration and a compatibility cross-check — never architecture
drivers** (§11).

Sources: [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) ·
[OpenAI reasoning items](https://cookbook.openai.com/examples/responses_api/reasoning_items) ·
[Gemini thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures) ·
[opencode](https://deepwiki.com/sst/opencode/2.1-application-core) ·
[codex-rs](https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/) ·
[pi.dev](https://www.dev-ore.com/blog/pi-dev-terminal-coding-harness/) ·
[ACP](https://agentclientprotocol.com/protocol/schema) ·
[codex auth](https://developers.openai.com/codex/auth).

---

## 3. The governing ideas

Two sentences carry the whole design:

> **A. The kernel owns *mechanism*; plugins own *behavior*.** Plugins contribute
> typed capabilities into a tiny, fixed set of registries / policy slots. They
> never touch control flow. The kernel consults them at published boundaries.

> **B. The item log is the only durable state.** All runtime state — pending
> approvals, the position within a turn, any live process — is ephemeral and
> reconstructable from the log (or simply discarded on exit). Stateless to the
> provider *and* stateless within the harness itself.

Everything below follows from these.

### Design principles (anti-convolution rules)

1. **Minimum viable concept set; grow on a rule.** A concept becomes a durable
   kernel record only when a real feature needs it *and* it can't be expressed by
   composing existing concepts. New *behaviors* are plugins, not kernel concepts.
2. **Strict one-directional layering.** `protocol → store/model contracts → core
   → tools → plugins → service → cli`. A lower layer never imports a higher one.
3. **Contracts explicit and validated at the boundary.** Every cross-module value
   is a `protocol` type with a zod schema, parsed where it crosses a
   persistence/provider/process boundary. No module leaks another's internals.
4. **The loop is a tiny state machine; its decisions are policies.** Delivery,
   context, approval, output are swappable policy objects, not branches.
5. **Dual item representation:** canonical content (for UI + cross-provider
   rendering) + optional opaque provider payload (for reasoning fidelity).
6. **Stateless, transcript-authoritative.** The kernel can always rebuild the
   model request from items + payloads. No provider server-state dependency.
7. **Cache-stable context.** The context builder emits a deterministic prefix;
   dynamic capabilities are *appended*, never swapped mid-session.
8. **Behavior is always a plugin; the kernel never grows.** Built-in tools and
   providers are plugins too. The extension surface is fixed and finite (§6).
9. **One façade, many clients.** A single typed event stream out + one delivery
   seam in. UI owns no control state.
10. **Real modules, not monolith files.** Split by responsibility.

---

## 4. The kernel — concepts and what is durable

The kernel owns exactly three things: **the item log, the Turn state machine, and
prompt legality.** Its concept set is fixed and tiny:

- **Conversation** — durable root; owns one ordered item log + config.
- **Item** — immutable canonical log entry. Types: `message` (user/assistant/
  system), `tool_call`, `tool_result`, `compaction`, `error`. Carries dual
  representation (§5).
- **Turn** — one activation of the loop (= one agentic turn; spans many model
  steps + tool calls until a final non-tool response). Thin: status is a *hint*,
  largely derived from items. Not log content.
- **ContextBuild** — recorded selection of items + instructions for one model
  step; the only source of truth for "what the model saw"; inspectable.
- **ProviderPayload** — per-item opaque provider fidelity (§5).
- **Profile** — named model config + prompt fragments + enabled plugins.

**Durable state is the log and nothing operational beyond it:** items,
conversation/turn metadata, context builds, provider payloads, a generic
**plugin-state** facility (namespaced per conversation, owned by plugins), and a
**blob store** (full tool output, §8). There are **no** durable execution
records, interactions, or activities — those were the confused concepts (§9).

---

## 5. Provider-agnostic model layer (the crux)

```ts
interface ModelProvider {
  readonly provider: string;            // "openai" | "anthropic" | ...
  capabilities(): ProviderCapabilities; // content types, tool-calling, payload type+version
  validateConfig(c: ModelConfig): void;
  stream(req: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
interface ModelRequest {
  instructions: ContentBlock[];                          // cache-stable prefix
  items: { item: Item; payload?: ProviderPayload }[];    // dual representation
  tools?: ToolSchema[];
  modelConfig: ModelConfig;
}
type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "completed"; content: ContentBlock[]; payload?: ProviderPayload; usage: Usage };
```

- **The kernel never branches on provider id.** Codex OAuth, encrypted reasoning,
  `thoughtSignature` ordering — all live in the adapter and round-trip through
  opaque **`ProviderPayload`** `{ itemId, provider, modelId, type, version,
  payload }`. A payload is reused only when its item is selected *and*
  provider/model/type/version match; otherwise the item renders from canonical
  content. This single shape covers Anthropic signatures, OpenAI encrypted
  reasoning, and Gemini thought-signatures uniformly.
- **First adapter:** `model-openai` (Responses, stateless; ChatGPT/codex PKCE
  OAuth + token refresh + keyring/`auth.json`). A `fake` provider that can script
  tool calls backs all tests. Anthropic/Gemini are thin later additions behind the
  unchanged contract.

---

## 6. The extension surface (the whole thing, on a napkin)

Behavior is contributed through a **fixed, finite** surface. This is what keeps
"everything is a plugin" from becoming a hook-bus mess.

**Registries (many typed entries):**
- `ModelProviders` — providers are plugins too.
- `Tools` — every tool, built-ins included.
- `ContextSources` — prompt fragments, skills, project context, rendered state.
- `Observers` — **read-only** event subscribers (UI, logging, metrics).

**Policy slots (exactly one each, composable from plugin-contributed rules):**
- `DeliveryPolicy` — steer / queue / interrupt (§7).
- `ContextPolicy` — selection + cache-stable prefix + compaction (§10).
- `ToolGate` — approval: `allow | deny | ask` (§9).
- `OutputProjection` — bound tool output → `(forModel, full)` (§8).

```ts
interface Plugin {
  id: string;
  providers?(): ModelProvider[];
  tools?(): Tool[];
  contextSources?(): ContextSource[];
  policies?(): Partial<{ delivery: DeliveryPolicy; context: ContextPolicy;
                         toolGate: ToolGate; output: OutputProjection }>;
  observers?(): Observer[];   // read-only
}
```

**Hard rules** (the antidote to harness-old's convolution):
- A plugin **never touches control flow** — it registers a capability or provides
  a policy that returns a typed value.
- Mutation happens *only* through typed registration; never "let every plugin
  mutate the live turn."
- The only fan-out is `Observers`, and they are **read-only**.
- **You do not add a new extension *kind*** without a concrete second use case.
  (Future `ExecutionStrategy` for parallel tool calls would slot in here under
  that rule; not built now.)

The Store/blob and the loop are foundational singletons injected at construction —
not "plugins." "Everything that is *behavior* is a plugin" is the precise claim.

---

## 7. The control loop and the delivery seam ("steer not queue")

The loop is a small state machine over a Turn with **published boundaries**; it
contains no `if (intent === ...)` branches.

```ts
type LoopBoundary =
  | "idle" | "before-model-step" | "after-model-step"
  | "after-tool-result" | "turn-complete";

type DeliveryIntent = "send" | "steer" | "queue" | "interrupt";
type DeliveryAction = "start-turn" | "inject" | "hold" | "cancel-and-restart";

interface DeliveryPolicy {
  decide(in: { intent: DeliveryIntent; boundary: LoopBoundary; turn?: Turn }): DeliveryAction;
}
```

The loop's whole job: advance state and, at each boundary, ask the relevant
policy and act. **Changing "queue" to "steer" edits a `DeliveryPolicy` mapping —
never the loop, never the store.**

Crucially, **all input that wakes the agent flows through this one seam with an
intent** — user messages, steering, queued input, interrupts, and (later)
approval answers and any plugin-sourced input. There is exactly one path in, not a
bespoke path per source.

The turn cycle: model step → emit text/tool_calls → if tool_calls, dispatch and
append one `tool_result` per call → loop → end when the model returns a final
non-tool response. **Invariant (enforced in one place): every `tool_call` gets
exactly one `tool_result`.** This loop is **tool-shaped from Phase 1** so tools
are never a loop rewrite (§13).

---

## 8. Tools, output, and the blob model

Tools are **synchronous from the loop's view**: a call blocks the turn until it
returns a `ToolResult`. A `ToolResult` is not a string:

```ts
interface Tool { readonly name: string; readonly schema: JSONSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>; }
type ToolResult = { forModel: ContentBlock[]; full?: OutputRef; status: "ok" | "error" };
interface ToolContext { execution: ExecutionContext; conversationId: string;
  signal: AbortSignal; emit(event: Event): void; }
```

- **`forModel`** is the bounded, model-facing content — it *is* the canonical
  content of the `tool_result` item and what the provider receives. (`ContentBlock[]`,
  not `string`, so results can be text, an image, a file ref.)
- **`full`** is an optional reference to the complete raw output in the **blob
  store** — rendered by the user's UI, peeked by the agent, kept as the durable
  record; never auto-sent to the model.
- The **`OutputProjection`** policy turns raw output into `(forModel, full)` —
  "keep last N," "head+tail," "summarize," "elide+link." "Redirect to file when
  too long" is just: always write the blob; `forModel` becomes a pointer past a
  threshold. The same model serves synchronous tool output *and* any future
  background-process output — there is **no output machinery specific to
  long-running work.**

Phase 1 ships a trivial truncate projection and read-only tools (`read_file`,
`glob`/`grep`). Side-effecting tools (`write`/`edit`/`bash`) arrive *with* the
approval gate (§9). `peek`, redirect thresholds, and background processes are
later plugins; the *shape* above accommodates them with zero rework.

---

## 9. Approvals, and why there is no durable execution state

**Approval is a blocking gate, not a durable record.** Before executing a tool,
the loop consults the single composed `ToolGate`:

```ts
interface ToolGate { evaluate(call: ToolCall, ctx): Promise<"allow" | "deny" | "ask">; }
```

- `allow` → execute. `deny` → synthesize an error `tool_result`. `ask` → the loop
  **blocks** (awaits an answer delivered through the one delivery seam, §7) and
  emits an `approval.requested` event for clients to render.
- The "pending approval" state is **derived from the log** (a trailing `tool_call`
  with no result + the gate said `ask`), never stored. No `Interaction` record.

**There is no durable `ToolExecution`, no `Activity` in the kernel, and no
recovery subsystem.** Reasoning:

- *What does "durable" buy?* Only surviving a process restart. Walk the cases:
  approval (nothing has happened yet — re-ask, or the session is just over);
  long-running sync tool (its child process died with the harness anyway);
  background work (rare; advanced).
- **Crash = the session ends. Nothing resumes, nothing re-runs.** On reload the
  log is read-only history. A trailing `tool_call` with no result → the turn is
  **failed**; a synthetic error `tool_result` (`"interrupted: session ended"`) is
  appended so the transcript stays prompt-legal and the conversation remains
  *continuable* by a new user message. A stale `running` turn → marked failed.
  That one rule is the entire "recovery" story.
- **Background / long-running work is a plugin, period** — completely irrelevant
  to the kernel. A plugin holds runtime handles for its processes and exposes
  `peek`/`wait`/`kill` as ordinary synchronous tools. The kernel has no concept of
  it.

---

## 10. Context building and prompt-cache stability

The `ContextPolicy` owns selection *and* must emit a **cache-stable prefix**,
because all three providers structure caching around prefix-match:

- **Frozen prefix first:** deterministic system prompt + deterministically-ordered
  tool schemas. No timestamps/uuids/session-ids in the prefix.
- **Volatile last:** newest items and dynamic fragments after the stable region.
- **Append, don't swap:** when skills/tools load mid-session, append their schemas
  (tool-search style) rather than mutating the prefix — keeps the cache and the
  provider payloads valid.
- **Compaction** is a canonical `compaction` item with a `coversThroughSeq`
  cursor; later builds use compaction + newer items; old items stay inspectable.
  "What's covered" is read from the recorded `ContextBuild` + the compaction
  cursor — **not** re-derived across all builds each pump (old2's fragility).

---

## 11. Clients, UI, and the event stream

The kernel depends on no UI; **UI owns no control state** (the explicit non-goal
from prior art). The contract is symmetric — **typed events out, typed input in**:

- **Out — a typed event stream:**
  `message`, `tool_call.{started,output,completed}`, `approval.requested`,
  `turn.status`, `plan`, … Each event is **structured data with a type**, never
  pre-rendered text. Plugins emit typed payloads; they don't draw UI.
- **Render — by type, with fallback.** Clients (CLI/TUI/web/Zed-via-ACP) hold
  renderers keyed by event type; **unknown types fall back to a generic
  JSON/text renderer**, so plugin data is always inspectable. A plugin *for a
  specific client* may ship a renderer component (opt-in, client-specific,
  core-invisible).
- **In — one delivery seam.** Approval answers, interrupts, steering, and user
  messages all come back as typed input events with an intent (§7).

Every client is just a different renderer of one event stream + a different
emitter into one delivery seam.

**On ACP — inspiration, not a driver.** We design the event stream and delivery
seam on their own merits. ACP is a well-considered distillation of the *same*
editor↔agent boundary, so it's worth borrowing ideas from and worth using as a
**compatibility cross-check**: if our model turned out *incompatible* with ACP,
that's a smell worth investigating — not a constraint to conform to. An optional
**ACP adapter** (mapping ACP `session ↔ Conversation`) could expose the harness to
ACP editors later; it is never load-bearing, and under no circumstances does ACP
dictate the internal model.

---

## 12. Package / module map

Strict downward dependencies; each split by responsibility.

```
protocol/       pure types + zod schemas + ids. zero logic, zero deps.
store/          Store interface + in-memory impl + store-contract test suite
store-sqlite/   sqlite impl via Kysely (typed SQL, migrations colocated; no ORM)
model/          ModelProvider contract + ModelRegistry + fake provider
model-openai/   OpenAI Responses + ChatGPT/codex OAuth adapter (first real one)
core/           the loop, context builder, turn manager, policy slots, blob store.
                orchestration only — depends on store + model *contracts*, not impls
tools/          Tool contract + ToolRegistry + ExecutionContext iface + host impl
plugins/        Plugin contract + thin PluginHost (composes registries/policies)
service/        façade API + typed event stream over core (what every client calls)
cli/            thin CLI over service
testkit/        shared fakes + reusable contract test suites
```

Persistence is **Kysely behind the `Store` interface** — typed SQL, real
migrations, no ORM magic (a fit for an append-only-log data model; an ORM's
identity-map/unit-of-work fights it). In-memory and sqlite impls share one
contract test suite. The choice is contained behind `Store` and low-stakes.

---

## 13. Core contracts (interface sketches)

```ts
// Store — persistence boundary (one contract test proves in-memory ≡ sqlite)
interface Store {
  createConversation(i): Promise<Conversation>;
  getConversation(id): Promise<Conversation | undefined>;
  appendItem(i: NewItem): Promise<Item>;                 // append-only; assigns seq
  listItems(conversationId, range?): Promise<Item[]>;
  createTurn(i): Promise<Turn>; updateTurn(p): Promise<Turn>;
  getActiveTurn(conversationId): Promise<Turn | undefined>;
  recordContextBuild(i): Promise<ContextBuild>;
  putProviderPayload(p): Promise<void>;
  getProviderPayloads(itemIds): Promise<ProviderPayload[]>;
  putPluginState(plugin, conversationId, key, value): Promise<void>;   // generic durability
  getPluginState(plugin, conversationId, key): Promise<unknown>;
  putBlob(bytes): Promise<OutputRef>; getBlob(ref, range?): Promise<Bytes>;
  // + profiles
}

interface ContextPolicy { select(i): Promise<ContextBuild> }   // selection + cache-stable prefix
interface OutputProjection { project(raw: Bytes, meta): { forModel: ContentBlock[]; full?: OutputRef } }
interface ExecutionContext { /* read / write / search / run — local host first */ }
```

---

## 14. Phased roadmap

The kernel is essentially complete in Phase 1; later phases ship **plugins against
an unchanged kernel.**

1. **Conversation + tool-loop core.** protocol; store (Kysely + in-memory +
   contract test); fake provider (scripts tool calls); the tool-shaped Turn loop
   with all four policy slots (default `DeliveryPolicy`, `ContextPolicy` with
   compaction, allow-all `ToolGate`, truncate `OutputProjection`); read-only
   built-in tools; blob store; the typed event-stream service; cli. Provider-agnostic.
2. **First real provider.** `model-openai` (Responses, stateless, encrypted
   reasoning) behind the unchanged contract; payloads round-trip.
3. **Side-effecting tools + approval.** `write`/`edit`/`bash` arrive *with* a real
   `ToolGate` plugin and the `approval.requested` event/render path.
4. **More plugins (no kernel change).** Tasks/todos (ContextSource + tool +
   plugin-state); MCP (a plugin registering remote tools); background processes
   (runtime handles + `peek`/`wait`/`kill` tools); subagents (a tool that spawns a
   child Conversation).
5. **Surfaces & environments.** Richer TUI/web + an optional ACP adapter over the
   same event stream; non-local `ExecutionContext` (docker/worktree/ssh) behind the
   existing interface; Anthropic + Gemini adapters.

---

## 15. How it stays simple (definition of done)

- **Steer-not-queue:** changing input-delivery edits only a `DeliveryPolicy` —
  never the loop or store. ✅ §7
- **Provider-swap / encrypted-reasoning:** adding Anthropic/Gemini, or swapping
  the store, edits no `core`; reasoning round-trips through `ProviderPayload` with
  zero provider-specific code in core. ✅ §5
- **Kernel-never-grows:** approvals, MCP, subagents, tasks, background work all
  ship as plugins; the kernel concept set is unchanged from Phase 1. ✅ §6, §9
- **No-durable-runtime:** crash ends the session; "recovery" is one rule (dangling
  tool_call → failed). No reconciliation subsystem. ✅ §9
- **One-output-model:** tool output and (future) background output share
  `forModel`/`full`/projection; no long-running-specific machinery. ✅ §8
- **UI-owns-nothing:** clients are renderers of one event stream + emitters into
  one delivery seam. ✅ §11
- **File test:** no package is a single 600-line file. ✅ §12

---

## 16. Non-goals / explicitly deferred

Built only when a concrete second use case appears, always as plugins or behind an
existing interface — never as kernel growth:

- durable execution/interaction records; turn resume across restart
- background/long-running process management, parallel tool execution
- approvals beyond a blocking gate; non-local execution (docker/worktree/ssh)
- subagents, MCP, task tracking, multimodal asset pipelines
- `previous_response_id` server-state; ORM-based persistence
- polished TUI/web/desktop/daemon

## 17. Open questions

- **Profiles vs. per-conversation config** overlap — settle the precedence in P1.
- **ContextPolicy compaction trigger** (token threshold vs. explicit) — default in
  P1, tune later.
- **Tool arg validation** location (kernel vs. tool) — lean kernel-side via the
  tool's JSON schema before `execute`.
