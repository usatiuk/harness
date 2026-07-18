# Kernel Seams — Amendment to DESIGN.md

This amends DESIGN.md after working three concrete plugin problems (LSP-on-edit,
tool-aware compaction, rewind) against the kernel. Each exposed a **mislocated
seam** — a seam placed where it cannot see what it needs to see. None required new
ambition; all required moving a seam. The headline promise ("kernel reaches final
shape in P1; everything else is plugins") is _only true_ once these seams are in
the right place — otherwise compaction, LSP feedback, peek, streaming, and rewind
each need kernel surgery later.

The whole amendment reduces to one model and two seams.

---

## 0. The model in one paragraph

The kernel owns an **append-only, immutable log of items** plus **one movable
pointer, `head`**. Items are never edited. The kernel touches content at exactly
**two discrete moments**: (A) **produce** — when a tool runs, a composable
_ToolMiddleware_ chain builds/annotates the resulting item; (B) **edit-by-append**
— at compaction triggers, composable _CompactionStrategies_ materialize a new
immutable `compaction` item that supersedes a prefix, and `head` advances past it.
Everything else — rewind, undo, branch, compaction — is "move or fork `head`."
The model sees the compacted view (bounded by the latest compaction cursor); the
UI reads the full immutable log directly. Live work is **pulled** by the model via
tools (`peek`), never pushed. All plugin influence is a **typed return value**,
never mutation of shared state; the only read-only fan-out is `Observers`.

That is the entire change. The rest is detail and rationale.

---

## 1. Why the original seams were wrong

Three problems, one disease.

1. **"Inject on every edit/read" (LSP).** DESIGN §6 said the only fan-out is
   read-only `Observers`, and an earlier answer suggested injecting into the
   prompt prefix via a `ContextSource`. Both are wrong: read-only can't inject,
   and prefix injection destroys prompt-cache stability (§7/§10). Every production
   harness — Claude Code (`PreToolUse`/`PostToolUse`), Codex hooks, LangChain
   `wrap_tool_call`, opencode `tool.execute.before/after` — solves this with a
   **mutating tool-call-lifecycle seam whose output attaches at the tool-result
   position**, not the prefix. (opencode's mutate-by-reference variant is _buggy_ —
   mutations to `output.output` are silently dropped — which is the argument for a
   **return-value** contract, not mutate-in-place.)

2. **Tool-aware compaction ("keep only the latest read of each file").** DESIGN's
   `OutputProjection` runs at **exec time** and freezes `forModel` into the item
   forever. "Keep latest read" needs to see the _future_ (was this file read
   again later?); streaming needs output that grows _after_ exec. An exec-time
   frozen value can do neither. This is the same disease: the projection seam is
   at the wrong _time_.

3. **Rewind + immutability.** A first cut modeled compaction as `edits:
replace(itemId → content)` — i.e. mutating what an item projects to. That
   reintroduces the exact mutate-by-reference pattern opencode got wrong, and it
   makes rewind impossible (you destroyed the old state). DESIGN §4/§B already say
   items are immutable and the log is the only durable state. Compaction must
   **append**, not edit.

The fix is not new machinery. It is: **two seams, at two distinct times, over an
immutable log.**

---

## 2. Seam A — ToolMiddleware (produce; exec-time)

A single composable chain replaces both `ToolGate` and `OutputProjection`.

```ts
interface ToolMiddleware {
  readonly id: string;
  wrap(
    call: ToolCall,
    ctx: ToolMiddlewareContext,
    next: (call: ToolCall) => Promise<ToolResult>,
  ): Promise<ToolResult>;
}

interface ToolMiddlewareContext extends ToolContext {
  // adds to {conversationId, signal, emit}
  putBlob(bytes: Uint8Array): Promise<OutputRef>; // spill large output
  request(req: Request): Promise<Response>; // blocking ask (approval seam, deferred)
}
```

The chain composes `m1(m2(m3(execute)))`: each middleware may call `next` zero
times (short-circuit), once (normal), or many (retry). One seam subsumes the lot:

- **Gate** → a middleware that returns an error `ToolResult` without calling
  `next` (deny), or calls `ctx.request` to block for approval (the `ask` path),
  then decides. Replaces `ToolGate`. (No allow-all default is needed: **absence of
  any gating middleware = allow**.)
- **Output bounding / redirect** → a middleware that calls `next`, then truncates
  `forModel` and spills the full bytes to a blob. Replaces `OutputProjection`. It
  ships as the default **innermost** middleware (nearest `execute`), so contributed
  middlewares wrap _outside_ it and e.g. LSP diagnostics are appended untruncated.
- **LSP-on-edit** → a middleware that calls `next`, then — _because it can finally
  see `call.args`_ — runs diagnostics on the edited file and **appends them to the
  returned `forModel`**. The result lands on the `tool_result` item (the volatile
  tail), exactly where Claude/Codex put it — cache-safe, never the prefix.
- **Retry / timeout / rate-limit** → middlewares, for free.

The result a middleware returns becomes the item's content. `ToolResult` is widened
so a producing tool/middleware can also stash structured data and full bytes:

```ts
type ToolResult = {
  forModel: ContentBlock[]; // → item.content (canonical, model+UI facing)
  full?: OutputRef; // → item.blobs (full bytes; never auto-sent)
  data?: unknown; // → item.data  (structured, e.g. {path, mtime} for a read)
  status: "ok" | "error";
};
```

`Observers` remain, for genuinely read-only fan-out (UI, metrics, logging). They
are **not** a substitute for middleware; the bug was believing they were.

---

## 3. Seam B — Compaction (edit-by-append; event-time)

Compaction never edits an item. It **appends one immutable `compaction` item**
carrying materialized, plugin-composed content plus a cursor for what it covers:

```ts
interface CompactionItem extends Item {
  // an ordinary item; immutable like all of them
  type: "compaction";
  coversThrough: Seq; // items ≤ this seq are rendered by this item instead
  content: ContentBlock[]; // materialized: dedup stubs, head+tails, summaries
}
```

Originals ≤ `coversThrough` stay in the log, untouched and inspectable. A context
build for the current head is:

```
[ active compaction.content ]  ++  [ items with seq > coversThrough ]
```

**The content is produced by composing plugin strategies — not one "LLM summarize
all" pass.** This is where the field is going (Anthropic ships three separate
strategies — `clear_tool_uses`, `clear_thinking`, server compaction; Letta runs
multiple strategies with a summarizer _fallback_; OPENDEV's ACC is a five-stage
pipeline). The summarizer is the _last-resort_ strategy, not the mechanism.

```ts
type CompactionElement = { content: ContentBlock[]; covers: Seq[]; data?: unknown };

interface CompactionStrategy {
  readonly id: string;
  // A transform over the working set: touch what you understand, pass the rest
  // through. Disjoint predicates ⇒ surgical/partition behavior emerges; a
  // whole-context summarizer is a terminal stage that returns one element.
  apply(working: CompactionElement[], ctx: CompactionContext): Promise<CompactionElement[]>;
}

interface CompactionPolicy {
  // the single slot: WHEN + strategy order
  plan(state: CompactionState): Promise<CompactionPlan | undefined>; // undefined = no-op
}
```

Examples of strategies (all plugins):

- **read-dedup** — keep the latest read per path full; replace superseded reads
  with `[stale read of X @seq]`. (Reads `item.data.path`.)
- **tool-output-elide** — results older than K over T tokens → head+tail + blob
  pointer.
- **reasoning-evict** — keep last N turns' reasoning, drop older (Anthropic's
  `clear_thinking` as a strategy).
- **structured-state** — a todo/plan plugin emits its _current_ list, collapsing
  intermediate edits.
- **summarize (fallback)** — prose with no better strategy → structured-JSON
  summary (intent / decisions / files / errors / pending), not free text.

**Composition — one ordered transform pipeline (fold).** "Claim-partition vs fold"
was a false dichotomy: partition is just a fold where the strategies don't overlap.
A whole-context **handoff summarizer** must act on _everything_ — including items
other strategies already touched — so partition can't express it. Resolution: a
single ordered pipeline; the kernel folds `working = await strategy.apply(working)`
in `CompactionPolicy` order, then flattens into `compaction.content`. Surgical
strategies are selective transforms (touch their kind, pass the rest through) and
degrade to partition when predicates are disjoint; the handoff summarizer runs
**last** and returns one element. Ordering is the policy's job (reductions first,
summarizer last) and each strategy must tolerate upstream output — easy, because
they are selective. A pure `/compact` is a policy that runs only the summarizer;
aggressive compaction is reduce-then-summarize.

**Edit granularity:** a strategy may rewrite a single element (dedup one read) or
collapse many into one (summarize seq 1–50 → one element, via `covers`). Both fall
out of the transform shape; both materialize into `compaction.content`.

**Materialize, never re-run.** The strategy runs _once at the trigger_ and bakes
concrete content into the compaction item. Re-running strategies at build time is
the old2 "re-derive every pump" fragility DESIGN §10 explicitly warns against.

**Cache.** Each compaction is a deliberate cache-break checkpoint (Anthropic:
"tool result clearing invalidates cached prefixes... clear enough to make it
worthwhile"). Between compactions nothing changes → cache holds. This is "edit at
points, not live."

**Summarize is async + fallible.** A compaction that calls the model can fail or
time out. `CompactionPolicy` must have a deterministic fallback (elide/truncate),
or a failed compaction strands the turn. (Letta's two-stage fallback exists for
exactly this.)

---

## 4. The immutable log + the single head

Once items are append-only with a `parent` link, **the only mutable cell in the
system is `conversation.head`** (a pointer to the current leaf). Then four features
are the _same_ operation:

- **Rewind** = move `head` to an earlier item. Nothing deleted; the old tail
  simply leaves head's ancestor chain.
- **Continue after rewind** = append from that item → it now has two children → a
  branch. The old branch remains, reachable, unreferenced.
- **Undo** = move `head` back one. **Compaction** = append a compaction item +
  advance `head`. **Branch/explore** = append from any non-leaf.

This is DESIGN §B refined: _an append-only log plus a head pointer; the head is the
only thing that moves._ `head` is durable store state (reconstructable) — not the
operational runtime state §7 forbids. "Generation" counters disappear: the active
generation is just whichever compaction item lies on head's ancestor chain.

**v1 surface:** expose only **linear rewind** (move head). Model `parent` + `head`
now (two fields) so branching is _possible_; do not build branch management. This
is the §2/§16 discipline — don't build it, don't foreclose it.

---

## 5. Items, provider payloads, and why the write-barrier vanishes

```ts
interface Item {
  id: ItemId;
  seq: Seq;
  parent: ItemId | null;
  conversationId;
  turnId?;
  type;
  createdAt;
  content: ContentBlock[]; // canonical fallback — ALWAYS present, renders without any plugin
  data?: unknown; // optional structured plugin data
  blobs?: OutputRef[]; // optional refs to full bytes
}
interface Conversation {
  /* ... */ head: ItemId;
}
```

`content` is mandatory so an item always renders even if its producing plugin
isn't loaded (DESIGN §11 "render with fallback"); `data`/`blobs` are enhancements.

**Provider payloads** (§5, opaque encrypted reasoning / signatures) stay keyed by
`itemId` and are **self-contained per item** — providers design them so clearing an
_earlier_ item does not invalidate a _later kept_ payload (that is the only reason
context-editing works at all). Because compaction **appends** and never edits,
**no payload is ever broken** — there are no edited items. The earlier
`invalidatedPayloads` idea was wrong twice over: it conflated cache invalidation
(positional, automatic, never stored) with payload validity, and it tracked a set
that is derivable. Under append-only it isn't even needed. If some future provider
ever made payloads prefix-bound, that rule lives in the **adapter**, not the
compaction record.

---

## 6. Access paths (the tree is a data model, not a traversal)

- **Context build (hot, every step):** `WHERE conversationId = ? AND seq >
coversThrough ORDER BY seq` — indexed range scan over the _post-compaction
  window_ only. O(window), independent of total length. Retires §16's "eagerly
  loads the whole log."
- **UI scroll (cold):** `WHERE conversationId = ? AND seq BETWEEN ? AND ? LIMIT n`
  — pagination, O(viewport). The UI reads the immutable log directly, so it shows
  the **full uncompacted history**; compaction only affects the _model's_ view.
- **`parent` is inert for linear conversations** (seq order = lineage order). It
  only costs during branch resolution, which v1 doesn't expose; when branching
  lands, use a standard tree-in-SQL pattern (lineage tag / closure table), not
  pointer-chasing.
- One index does it: `(conversationId, seq)`.

---

## 7. The extension surface, restated (replaces DESIGN §6)

**Registries (many typed entries):**

- `ModelProviders`
- `Tools`
- `ContextSources` — cache-stable prefix fragments
- `ToolMiddleware` — **ordered chain** (NEW; subsumes ToolGate + OutputProjection)
- `CompactionStrategy` — composed at compaction events (NEW)
- `Observers` — read-only fan-out

**Policy slots (exactly one each):**

- `ContextPolicy` — selection + cache-stable prefix assembly (no longer owns the
  compaction _mechanism_, only selects the post-cursor window)
- `CompactionPolicy` — **when** to compact, scope, fallback, strategy composition (NEW)

**Removed slots:** `ToolGate`, `OutputProjection` — both are now `ToolMiddleware`s.
Absence of a gating middleware means allow; a truncate middleware ships as the
default innermost wrapper. One ordering rule: **outermost = first registered** (runs
first inbound, last outbound).

**Delivery** (`send`/`steer`/`queue`/`interrupt`) is unchanged.

---

## 8. The foolproof invariants (the "as simple as possible" core)

1. **Items are immutable and append-only.** Only `head` moves.
2. **Two content seams, both discrete:** produce (exec, ToolMiddleware) and
   edit-by-append (event, Compaction). **No continuous build-time projection.**
3. **Every plugin influence is a typed return value** — never mutation of shared
   state. (The only read-only fan-out is `Observers`.)
4. **Live data is pulled by the model via tools (`peek`), never pushed.** Streaming
   to the UI is an `Observer`/`PluginEvent`; the model's view is always settled
   items.
5. **Compaction appends; never edits.** It is a deliberate cache-break checkpoint.
6. **Provider specifics live in adapters; payloads are self-contained per item.**
7. **The model sees the compacted view; the UI sees the full immutable log.**
8. **One mandatory `content` per item** guarantees render-without-plugin.

If a proposed feature needs to break one of these, it is a kernel-design
conversation — not a plugin.

---

## 9. Deep plan (phased; kernel finalized in P1)

**Phase 1 — kernel final shape (must include both seams or P4 is a rewrite).**

- `protocol`: immutable `Item` (+`parent`, `content`/`data`/`blobs`), `compaction`
  item, `Conversation.head`, `ToolMiddleware` + `ToolMiddlewareContext`,
  `CompactionStrategy` + `CompactionPolicy`, `ContextPolicy` (selection only),
  widened `ToolResult`. Keep `Provider`/`Tool`/`ContextSource`/`Observer`.
- `store`: append-only items, `head` pointer, index `(conversationId, seq)`, blob
  store, payloads. In-memory + sqlite + one shared contract suite.
- `core`: tool-shaped loop (exists); **middleware chain in `#dispatch`**; the
  **compaction pass + `CompactionPolicy` trigger at turn boundaries**; context
  build bounded by `coversThrough`; PluginHost registries.
- Defaults: fake provider, read-only tools, allow-all gate middleware, truncate
  projection middleware, no-op/identity compaction.
- `service` typed event stream; `cli`.
- _Verify:_ contract suite green on both stores; a fake LSP middleware appends to
  an edit result; a fake read-dedup strategy collapses a repeated read; rewind
  moves head and the next build reflects it.

**Phase 2 — first real provider** (`model-openai`, in flight on
`feat/openai-backend`): Responses, stateless, encrypted reasoning round-trips via
self-contained payloads. No core change.

**Phase 3 — side-effecting tools + approval.** `write`/`edit` and the substrate command tool arrive with an
approval `ToolMiddleware` using `ctx.request` (the blocking ask path) and the
`approval.requested` event/render.

**Phase 4 — the plugins this was all for (no kernel change).** LSP middleware;
real `CompactionStrategy`s (read-dedup, tool-output-elide, reasoning-evict,
structured-state, summarize-fallback); background processes + `peek`/`wait`/`kill`
tools; MCP; subagents.

**Phase 5 — surfaces & environments.** Rewind/branch UI over the immutable log;
richer TUI/web + optional ACP adapter; non-local `ExecutionContext`; Anthropic +
Gemini adapters.

---

## 10. Prior-art grounding

- Claude Code hooks — `PreToolUse`/`PostToolUse`, `additionalContext` next to the
  tool result: https://code.claude.com/docs/en/hooks
- LangChain agent middleware — `wrap_tool_call`/`wrap_model_call` (return-value
  contract): https://docs.langchain.com/oss/python/langchain/middleware/custom
- Codex hooks — Pre/PostToolUse, UserPromptSubmit:
  https://developers.openai.com/codex/hooks
- opencode plugins (and the mutate-by-reference bug):
  https://opencode.ai/docs/plugins/ ·
  https://github.com/anomalyco/opencode/issues/13574
- Anthropic context editing (`clear_tool_uses`/`clear_thinking`, cache-break
  semantics): https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic compaction (server-side, the preferred default):
  https://platform.claude.com/docs/en/build-with-claude/compaction
- "Context editing is a GC without write barriers" (the hazard, designed away by
  append-only): https://conikeec.substack.com/p/context-editing-looks-like-a-feature
