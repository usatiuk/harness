# Harness plan

## Goals

- **Local-first agency.** Conversations, context, usage, execution, and project
  state remain inspectable and controlled by the local Harness process.
- **Provider independence.** The kernel speaks one model protocol; adapters own
  provider request formats, streaming events, opaque payloads, model catalogs,
  and error normalization.
- **Harness-owned execution.** File, command, approval, sandbox, activity, and
  subagent behavior runs through Harness tools and middleware rather than hidden
  provider-side agents.
- **Durable conversation truth.** An append-only item graph plus a movable head
  supports resume, rewind, compaction, and future branch navigation without
  rewriting history.
- **Additive extensibility.** Providers, tools, middleware, context sources,
  services, policies, and observers enter through the plugin surface; new
  features should not fork the turn loop.
- **Cancellable, observable work.** User input, model calls, tools, approvals,
  background work, and subagents expose bounded lifetimes and typed events.
- **Simple product surface.** Keep the TUI and desktop focused on conversations,
  controls, and inspection rather than an IDE or generalized UI framework.

## Non-goals for the current version

- Provider-owned execution tools or opaque provider agent loops.
- Durable resumption of in-flight model streams, processes, approvals, or
  subagents after process exit.
- A general workflow engine, distributed scheduler, or multi-user daemon.
- Full branch management merely because the store can represent branches.
- Provider server state such as `previous_response_id` as conversation truth.
- Web, ACP, shared daemons, parallel TUI presentation, and desktop side-by-side
  views or IDE features.
- Generic compaction pipelines, server-side compaction, or a model-capability
  framework without a concrete implementation that needs them.
- Compatibility preservation for disposable pre-release database schemas.

## System overview

```text
CLI / TUI / Tauri desktop
    ↓ JSON-RPC (in-process or bounded NDJSON stdio)
Harness client ↔ HarnessService server
    ↓
Engine ── PluginHost ── providers / tools / middleware / policies / services
    ↓
Store interface
    ↓
SQLite (production) or in-memory (tests)
```

The primary package direction remains `protocol → store → core → service →
server`, with CLI and desktop over the public client boundary. Feature packages
are plugin contributions wired at the shared server composition
root. They may depend on protocol and narrower feature contracts, but the kernel
does not import provider, workspace, sandbox, approval, activity, or subagent
packages.

## Current implementation status

As of 2026-10-03, Harness provides:

- An append-only conversation/item graph with one durable head, linear rewind,
  branch-preserving continuation, turn reconciliation, and resumable transcripts.
- A cancellable multi-step agent loop with `send`, `queue`, `steer`, and
  `interrupt`, interleaved reasoning/text/tool output, ordered multi-call tool
  dispatch, correlated host requests, and typed events.
- Tool, model, and request middleware plus plugin-owned context sources,
  per-conversation services, policies, observers, and configuration schemas.
- OpenAI API-key (Responses + chat/completions), OpenAI Codex OAuth, Anthropic
  API-key, OpenCode Go API-key, config-defined OpenAI/Anthropic-compatible
  providers, and a deterministic demo provider with model catalogs, reasoning
  payload fidelity, usage, and cost.
- Harness-owned read/write/edit/patch/glob/command tools selected by the active
  model's trained file-tool dialect.
- Local, Linux Bubblewrap, and dev-container execution; bounded output files;
  human approval and optional model-backed auto-approval.
- Hierarchical `AGENTS.md` instructions, model-backed/manual compaction,
  background activities, and configurable recursive subagents.
- An Ink TUI with streaming Markdown, verbose transcript, resume/rewind,
  model/preset selection, sandbox controls, activities, usage, cost, and context
  fill.
- A Tauri/React desktop client with React Router loaders/actions/fetchers, a
  live conversation sidebar, independent turns/drafts/approvals, virtualized
  bounded history, Markdown/tool/diff/output inspection, provider/settings
  controls, and a bundled owned server with exclusive database ownership.
  Native Windows tests cover actual WebView2, processes, restart, and shutdown;
  other desktop platforms remain unqualified.
- A language-neutral JSON-RPC client/server boundary used identically in-process,
  by a local stdio child, or through SSH. Multiple attached root conversations
  may run concurrently; the TUI renders one while connection-owned approvals and
  server-owned background work remain live.
- Durable model/preset pinning, plugin-owned child inheritance, runtime-bound
  callbacks, authoritative failed-reload detachment, and shared devcontainer
  ownership with conversation-scoped processes/cancellation and warning controls.

## Subsystems

| Subsystem                   | Current architecture                                    | Active plan or next priority                                                             |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Kernel                      | [Architecture](docs/subsystems/kernel/README.md)        | No selected kernel change; add seams only for concrete plugin needs.                     |
| Persistence                 | [Architecture](docs/subsystems/persistence/README.md)   | No selected persistence change; branch navigation and stable migrations remain deferred. |
| Models                      | [Architecture](docs/subsystems/models/README.md)        | [Bounded transient reliability](docs/subsystems/models/PLAN.md)                          |
| Execution and safety        | [Architecture](docs/subsystems/execution/README.md)     | [Native mutation containment](docs/subsystems/execution/PLAN.md)                         |
| Context and compaction      | [Architecture](docs/subsystems/context/README.md)       | Observe v1; add another strategy only for a demonstrated need.                           |
| Orchestration               | [Architecture](docs/subsystems/orchestration/README.md) | No selected change; MCP callable tools remain a next-plugin candidate.                   |
| Configuration and interface | [Architecture](docs/subsystems/interface/README.md)     | [Diagnostics and supportability](docs/subsystems/interface/PLAN.md)                      |
| Testing                     | [Architecture](docs/subsystems/testing/README.md)       | [Evidence for active reliability and security work](docs/subsystems/testing/PLAN.md)     |

## Near-term order

Completed the
[independent parallel conversation foundation](docs/plans/cross-cutting/2026-10-03-parallel-conversations.md)
with full local validation, independent review, real stdio concurrency, and live
Docker/Compose qualification. The service/protocol is ready to underpin a desktop
client. The approved [desktop v1 delivery](docs/plans/interface/2026-10-03-desktop-v1.md)
is complete with full local validation, three independent reviews, and ten
native E2E scenarios against the staged Windows release outside the checkout
without system Node. The NSIS installer builds; installation and other desktop
platforms remain unqualified. TUI parallel presentation and worktrees remain outside
scope. Existing provider reliability and native containment
priorities below remain active follow-up.

1. [x] Replace obsolete monolithic design documents with this product plan and
       current subsystem documentation.
2. [ ] Add minimal provider error normalization and bounded transient model
       retry middleware.
3. [ ] Choose one concrete vertical plugin: LSP diagnostics for coding quality,
       or MCP callable tools for ecosystem reach.
4. [ ] Close the native filesystem mutation race before strengthening sandbox
       isolation claims.
5. [ ] Reassess product ergonomics and diagnostic export in the shipped clients.
6. [x] Establish the transport-agnostic client/server boundary before adding a
       second UI client.
7. [x] Deliver the approved desktop v1 with independent conversations, inspection,
       owned background server, database exclusion, and actual native E2E.

## Documentation roles

- This file tracks product direction and subsystem-level progress.
- Subsystem `README.md` files describe accepted current behavior.
- A subsystem `PLAN.md` exists only while that subsystem has a selected,
  actionable roadmap.
- `docs/plans/` records delivery plans for concrete substantial changes.
- `docs/decisions/` records why significant accepted choices were made.
- `docs/research/` records evidence and unresolved investigation.
- `docs/DEFERRED.md` records known limitations intentionally outside active work.
- Public types, implementation, and executable tests remain the final authority
  when documentation drifts.
