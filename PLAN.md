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
- **Simple product surface.** Keep the TUI opinionated and useful before adding
  additional clients or generalized frameworks.

## Non-goals for the current version

- Provider-owned execution tools or opaque provider agent loops.
- Durable resumption of in-flight model streams, processes, approvals, or
  subagents after process exit.
- A general workflow engine, distributed scheduler, or multi-user daemon.
- Full branch management merely because the store can represent branches.
- Provider server state such as `previous_response_id` as conversation truth.
- Web, desktop, ACP, or remote-control surfaces before the TUI and service
  contracts are dependable.
- Generic compaction pipelines, server-side compaction, or a model-capability
  framework without a concrete implementation that needs them.
- Compatibility preservation for disposable pre-release database schemas.

## System overview

```text
CLI / TUI
    ↓
HarnessService
    ↓
Engine ── PluginHost ── providers / tools / middleware / policies / services
    ↓
Store interface
    ↓
SQLite (production) or in-memory (tests)
```

The primary package direction remains `protocol → store → core → service →
cli`. Feature packages are plugin contributions wired at the CLI composition
root. They may depend on protocol and narrower feature contracts, but the kernel
does not import provider, workspace, sandbox, approval, activity, or subagent
packages.

## Current implementation status

As of 2026-08-08, Harness provides:

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
- One active top-level TUI conversation whose complete runtime/subagent family is
  disposed and rebuilt on switch or reload, including immediate sandbox changes.

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

1. [x] Replace obsolete monolithic design documents with this product plan and
       current subsystem documentation.
2. [ ] Add minimal provider error normalization and bounded transient model
       retry middleware.
3. [ ] Choose one concrete vertical plugin: LSP diagnostics for coding quality,
       or MCP callable tools for ecosystem reach.
4. [ ] Close the native filesystem mutation race before strengthening sandbox
       isolation claims.
5. [ ] Reassess product ergonomics and diagnostic export before adding another
       client surface.

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
