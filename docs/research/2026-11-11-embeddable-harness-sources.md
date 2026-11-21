# Embeddable harness source survey

Source inspection on 2026-11-11. See the [design exploration](2026-11-11-embeddable-harness.md)
for the proposed contracts and experiments. The external projects are shallow
clones under `D:/projects/ref`. Source links pin the inspected revisions.
The Planner checkout is `D:/projects/planner`. No reference services,
installers, or test suites were run. Runtime behavior and performance remain
unmeasured.

| Checkout           | Revision                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Harness            | `bdce65cfb95bdee888b09954f32d089417fb860b`, conversation source inspected in the local worktree                                          |
| Planner            | `d054c7b12c760deec691a3f652bb4bced6df95bb`, conversation source inspected in the local worktree                                          |
| Open WebUI         | `b0e6098e940942281d9c83f3529ea117287a3a22`                                                                                               |
| LibreChat          | `e6567c7a681ce67869dce31486a21d3a25d6931b`                                                                                               |
| LibreChat Agents   | App pins `4.2.1`, tag at `708c9118f478a84f28e8e253148a373b49fec191`. Clone HEAD is `7ea84fc4db98ec9cf373b6927a3cee9549661f28` (`4.2.2`). |
| Pi                 | `2a64f907566e43c2d68a12a71d3c38ec7edede32`, earendil-works/pi                                                                            |
| OpenCode           | `6ec9395bd4218af9fb11608d70fc2dfdcbe625b7`, v2 development architecture                                                                  |
| DeepSeek Harness   | `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`                                                                                               |
| OpenAI Codex       | `392ced7d3a9160fd35d40c606359869215f50522`                                                                                               |
| Deep Agents JS     | `cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81`                                                                                               |
| Deep Agents Python | `f2a6e02dc8e2dcb05885c5133b94102ccc79b794`                                                                                               |

## Harness

- **Composition.** `Engine` consumes a store, a plugin host, a config resolver,
  and a code evaluator. Plugin registration includes provider types, context,
  tool, model and request middleware, and conversation-lifetime services.
  `HarnessService` composes the engine and configuration. The shipped server
  binds an exclusive SQLite store and local credentials and initializes shell,
  sandbox, workspace, and product APIs. There is already an engine seam and a
  transport seam. A usable alternate host still needs a composition with explicit
  lifecycle and configuration inputs. [Engine](../../packages/core/src/engine.ts#L142-L152),
  [plugin contract](../../packages/protocol/src/plugin.ts#L45-L101),
  [server wiring](../../packages/server/src/index.ts#L86-L115),
  [service composition](../../packages/server/src/index.ts#L138-L203).
- **Admission and restart.** The input acknowledgment follows a synchronous
  recency write and an in-memory inbox mutation. The drain creates the turn and
  appends the inputs later. Finalized items, payloads, and usage are durable.
  Load-time reconciliation pairs dangling calls and fails a stale turn. The
  contract includes workspace and worktree operations and a synchronous
  `recordUserInput`. Making SQLite calls asynchronous would leave inbox durability
  and ownership unchanged. A better precedent for new guarantees is the existing
  atomic `appendQuestionResponse` operation. [Delivery](../../packages/core/src/engine.ts#L168-L222),
  [drain](../../packages/core/src/engine.ts#L1083-L1168),
  [reconciliation](../../packages/core/src/reconcile.ts#L8-L47),
  [store contract](../../packages/protocol/src/store.ts#L57-L142).
- **Children and clients.** An attach snapshot includes live state for the
  conversation tree. Clients subscribe to scoped events and page durable items.
  A subagent is an ordinary durable conversation with plugin-state parent and
  slug records. Child creation and those records are currently separate writes.
  Live activities and their completion delivery are process-bound. That is a
  concrete difference from a durable child queue across worker restarts.
  [Attachment](../../packages/service/src/rpc-session.ts#L439-L530),
  [child creation](../../packages/subagents/src/activity.ts#L176-L207),
  [orchestration](../subsystems/orchestration/README.md).

## Planner

- **Admission belongs to the product.** The Koa application checks ownership,
  claims uploads, writes the user item and attachment links, and inserts a
  queued turn under one PostgreSQL transaction. Mobile capture reuses the
  unit-of-work function. It can create an entire first chat with that command.
  This is an actual need for a composition that supports shared transactions
  if Planner keeps its existing acknowledgment contract.
  [Conversation writes](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/services/conversation-writes.ts#L212-L325),
  [transaction caller](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/services/conversation-writes.ts#L398-L453),
  [mobile capture](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/services/mobile-captures.ts#L141-L158).
- **Execution and publication have different owners.** PostgreSQL claims
  queued or expired running turns with `FOR UPDATE SKIP LOCKED`, persists a
  unique claim token, and renews its lease. Owned transcript and terminal
  writes recheck the token. Redis holds live SSE state scoped to stream
  namespace and attempt. Continuation is tied to a matching provider/model
  and prior output. The source implements specific recovery paths.
  [Worker claim](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/ai/turn-processor.ts#L705-L815),
  [lease renewal](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/ai/turn-processor.ts#L914-L955),
  [owned write](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/ai/turn-runner.ts#L1322-L1358),
  [stream key and cursor](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/ai/turn-streams.ts#L77-L112),
  [continuation](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/ai/turn-runner.ts#L508-L546).
- **A fenced transcript can still miss a real side effect.** The runner
  persists a call, executes the tool with authenticated user context, then
  persists its result. A Planner item can commit in a separate transaction.
  A crash between those commits leaves an ambiguity even if a stale worker
  cannot append to the transcript. The app already has a strong seam in its
  tool registry and domain services. Its existing context, uploads, knowledge,
  and voice endpoints can remain product capabilities.
  [Dispatch and result](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/ai/turn-runner.ts#L618-L711),
  [create-item tool](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/ai/tools/planner.ts#L1304-L1322),
  [domain transaction](https://github.com/usatiuk/planner/blob/d054c7b12c760deec691a3f652bb4bced6df95bb/backend/src/services/planner-items.ts#L989-L1015).

## Open WebUI

- **Native web chat is the path this research aims to improve.** Payload middleware
  assembles app context and capabilities. The streaming response handler has
  its own tool loop and upserts assistant output into app chat state. The chat
  storage code manages the application message tree. During its persistence
  transition it writes normalized message rows and legacy chat JSON under the
  same lock. Local asyncio tasks own execution with Redis coordination.
  [Payload path](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/utils/middleware.py#L2018),
  [stream and tool loop](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/utils/middleware.py#L5805-L5865),
  [chat persistence](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/models/chats.py#L449-L488),
  [task ownership](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/tasks.py#L160-L183).
- **The terminal adapter demonstrates transport interoperability.** The `agent:` path dispatches before native
  payload processing. A terminal agent session uses Codex app-server RPC, Pi
  RPC, or ACP for OpenCode and other agents. The native runtime owns its own
  conversation and execution. Open WebUI keeps a signed session reference bound
  to the user, chat, and agent. It renders items and usage and routes approvals
  and interrupts. The adapter constrains continuation to saved chats and new
  messages. Product retrieval and tools still belong to the separate native
  path. Approval-card persistence lets the web app relay decisions while a
  terminal session is alive. For this research, the relevant design question is
  whether a shared engine can own the ordinary chat path and run those
  product capabilities as part of the same turn.
  [Dispatch branch](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/main.py#L1683-L1713),
  [agent runner](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/utils/agents/runner.py),
  [Codex adapter](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/utils/agents/codex.py#L65-L174),
  [approval projection](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/utils/agents/output.py#L130-L189).

## LibreChat

- **The app already embeds a separate harness.** The authenticated route
  restores applicable resume config and checks agent and conversation access.
  The controller creates a generation and returns a stream ID for the separate
  SSE connection. Its API package
  supplies authorization-aware tools, hooks, checkpoint configuration, and
  agent settings to the LangGraph-based `@librechat/agents` runtime. This is
  a real same-language SDK seam with meaningful host policy. It also shows how
  much integration is still needed to use the same engine under a product.
  [Route middleware](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/api/server/routes/agents/chat.js#L45-L102),
  [SSE authorization and attach](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/api/server/routes/agents/index.js#L186-L281),
  [run assembly](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/packages/api/src/agents/run.ts#L2807-L3048),
  [SDK invocation](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/packages/api/src/agents/run.ts#L3182),
  [pinned SDK run](https://github.com/LibreChat-AI/agents/blob/708c9118f478a84f28e8e253148a373b49fec191/src/run.ts#L484).
- **Three kinds of state.** Mongo holds product messages. Redis-backed
  generation jobs and bounded stream replay support reconnect. A selective
  Mongo saver retains resumable approval and explicit actor checkpoints.
  Generation fencing and final-message-before-terminal-event ordering protect
  ownership and presentation. The controller still needs recovery across the
  two stores. Checkpoint support is narrower than general active-run recovery.
  [Selective saver](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/packages/api/src/agents/checkpointer.ts#L200-L253),
  [resume subscription](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/packages/api/src/stream/GenerationJobManager.ts#L6237),
  [Redis chunk log](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/packages/api/src/stream/implementations/RedisJobStore.ts#L5175),
  [terminal persistence](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/api/server/controllers/agents/request.js#L3122-L3154),
  [recovery](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/api/server/controllers/agents/request.js#L3295-L3316).

## Pi

The [Pi Durable follow-up](2026-11-12-pi-durable.md) traces the newer checkout,
including the p2 host and the default behavior for interrupted tool calls.

- **Classic Pi and Pi Durable are distinct implementations.** The classic
  coding SDK uses the agent runtime and a JSONL session tree by default.
  Its example subagent extension spawns a separate non-session CLI and reads
  its output. Pi Durable is a separate package with typed durable
  submissions, immutable entries, documents, tasks, and an explicit
  scheduler. It is a closer model for embedding inside a product.
  [Classic SDK](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/coding-agent/src/core/sdk.ts#L191-L204),
  [example subagent](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/coding-agent/examples/extensions/subagent/index.ts#L362-L400),
  [Durable state model](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/durable/README.md#L92-L138).
- **Host storage and atomic batches.** The store returns a durability
  receipt separately from publication. SQLite receipts follow transaction
  completion. Adapters include memory, SQLite, IndexedDB, JSONL and Cloudflare
  with a single-writer contract. One example atomically writes host metadata
  as a typed Durable document and admits a submission. A second shares the
  underlying Chord store with host tables but demonstrates two separate
  commits. That distinction matters for Planner's admission contract.
  [Storage contract](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/durable/src/types.ts#L1355-L1402),
  [SQLite implementation](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/durable/src/storage/sqlite/storage.ts#L152-L196),
  [same commit](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/durable/test/examples/34-submit-in-commit.ts),
  [shared store](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/durable/test/examples/35-durable-on-the-store.ts#L37-L81).
- **Explicit recovery and child ownership.** A tool intent is committed
  before execution. Restart repeats an interrupted invocation only when
  persisted intent and current policy both permit replay. A child has its
  own conversation and stable task identity. Background ownership changes
  what parent cancellation and waiting mean. This is a direct reference
  for a narrow recovery state machine.
  [Tool recovery](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/durable/src/harness/tool.ts#L223-L257),
  [child tasks](https://github.com/earendil-works/pi/blob/2a64f907566e43c2d68a12a71d3c38ec7edede32/packages/durable/README.md#L872-L917).

## OpenCode

- **A supported embedding path.** The v2 SDK boots the same router with an
  in-memory fetch transport, can open SQLite, and accepts workspace drivers
  and plugins. Workerd hosts the same core in a Durable Object and substitutes
  platform-dependent services. Plugin instances can be reconstructed per session
  from saved metadata. The SDK explicitly leaves authorization and isolation to
  its host. This is evidence for sharing the runtime and varying composition.
  [Embedded host](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/sdk/src/internal/host.ts#L22-L65),
  [SDK contract](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/sdk/README.md#L30-L76),
  [Workerd](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/server/src/workerd.ts#L22-L92).
- **State changes and the stream.** Durable events update SQL projections
  transactionally, with optional retained event rows and an explicit
  DB-local commit hook. Text deltas on the public feed are volatile. The
  bounded feed disconnects lagging subscribers, and the client refreshes
  active state on reconnect. Execution recovery scans durable claims, caps
  attempts, and assumes the old owner is dead. Its external execution
  semantics are at-least-once.
  [Commit path](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/core/src/bus.ts#L311-L435),
  [live feed](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/server/src/event-feed.ts#L27-L74),
  [reconnect](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/client/src/solid/data.ts#L704-L741),
  [restart contract](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/core/src/session/execution/restart.ts#L36-L63).
- **Delegation as an owned job.** Child sessions have scoped parentage,
  independent input, and foreground/background jobs. Terminal settlement
  can record a child report with the result. The outbox feeds the parent's
  inbox using a stable notification ID before clearing the report. This is
  justified when the completion must survive a crash between sessions.
  [Child lifecycle](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/core/src/tool/plugin/subagent.ts#L120-L254),
  [terminal settlement](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/core/src/session/execution.ts#L136-L176),
  [report outbox](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/packages/core/src/session/execution/subagent-report.ts#L80-L136).

## DeepSeek Harness

- **Same runtime, replaceable composition.** Web, headless, SDK, and ACP
  profiles select bundles from a shared stack. TypeScript and Python SDKs
  launch the same standard runtime over stdio JSON-RPC. Cordis has scoped,
  reversible registrations with distinct observer, waterfall, and serial
  semantics. The tool pipeline runs transforms before mandatory monotonic
  guards and dispatch. The design lets product composition vary without
  making an observer or output hook an authorization mechanism.
  [Profiles and SDK](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/architecture.md#L7-L74),
  [Cordis lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/cordis-primer.md#L7-L33),
  [tool execution](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/tool-execution-pipeline.md#L4-L66).
- **Bounded durability and delegation.** The persistence handle separates
  accepted and readable append from durable flush. JSONL provides a
  writer lease and repair. Recovery closes interrupted turns and distinguishes
  calls that did not start from calls with unknown outcomes. A local child
  owns a durable session and at most one live activation. An external provider
  can supply one-shot activation, with resource lifetime and result routing
  under the manager. These choices are useful even without adopting its broader
  plugin service model.
  [Persistence handle](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/session/session-persistence/src/handle.ts#L83-L116),
  [recovery](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/session/session-persistence/README.md#L34-L61),
  [subagent model](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/subsystems/subagent.md#L136-L175),
  [activation dispatch](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/subagent/subagent/src/index.ts#L251-L291).

## OpenAI Codex

- **The TypeScript SDK launches the Rust CLI.** In the inspected
  `@openai/codex-sdk` source, the thread wrapper invokes
  `codex exec --experimental-json`, writes the prompt to the subprocess, and
  parses its JSONL output. The
  bidirectional integration for custom clients is the separate app-server
  protocol. The documented Python SDK uses that protocol. These are two
  different ways to reach the same Codex runtime.
  [Codex SDK docs](https://learn.chatgpt.com/docs/codex-sdk),
  [exec arguments](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/sdk/typescript/src/exec.ts#L94-L100),
  [TypeScript subprocess wrapper](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/sdk/typescript/src/exec.ts#L203-L247).
- **Polyglot clients with native extensions.** A typed Rust in-process client
  shares the app-server contract with external JSON-RPC transports. The
  experimental dynamic-tool path accepts descriptors in `thread/start`.
  A Rust handler registers a pending call and waits on a cancellable
  one-shot channel. App-server sends `item/tool/call` to the client with the
  tool name, arguments, and call identity. The client runs its own handler
  and returns success and content. App-server decodes the reply and submits
  it to the thread under the same call identity. Deeper extensions such as
  model-request interception, tool lifecycle, and context contribution are
  typed Rust contributors in the native registry.
  [App-server dynamic tools](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental),
  [In-process client](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server-client/README.md#L23-L37),
  [native registry](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/ext/extension-api/src/registry.rs#L70-L151),
  [core wait](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/core/src/tools/handlers/dynamic.rs#L190-L243),
  [dynamic tool dispatch](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server/src/bespoke_event_handling.rs#L1113-L1142),
  [reply routing](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server/src/dynamic_tools.rs#L18-L54).
- **OpenAI's similarly named APIs have different ownership.** The Agents
  SDK (`@openai/agents` for TypeScript) runs its own loop in the application
  and accepts local async tool functions. The hosted Agents API runs the
  managed Codex harness. Its application functions use a pending-action and
  tool-result protocol keyed by turn and call ID, with a pending-action
  lookup available after reconnect.
  [Agents runtime comparison](https://developers.openai.com/api/docs/guides/agents),
  [SDK tool context](https://developers.openai.com/api/docs/guides/agents/define-agents#keep-local-context-separate-from-model-context),
  [managed function calls](https://developers.openai.com/api/docs/guides/agents-api/tools/functions).
- **Thread history and live attachment.** The local `ThreadStore` keeps
  JSONL canonical history with SQLite metadata. Warm resume attaches to a
  live thread, including pending requests. Managed daemon handoff covers
  persisted root threads. Neither implies general replay of an interrupted
  effect. Child threads have persisted parent links, capacity controls and
  reload. The examined completion path is explicitly best effort.
  [Thread store](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/thread-store/README.md#L3-L29),
  [warm resume](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L1254-L1290),
  [daemon handoff](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server/src/request_processors/daemon_snapshot.rs#L15-L54),
  [child creation](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/core/src/agent/control/spawn.rs#L834-L914),
  [completion](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/core/src/agent/control/completion.rs#L1-L5).

### Where the JavaScript actually runs

`@openai/codex-sdk` is the Node subprocess wrapper. Its `Thread` feeds the
prompt and an optional saved thread ID into `CodexExec.run`, parses events,
and remembers the ID from `thread.started`. The exec wrapper closes stdin
after the prompt and reads stdout line by line. The Rust executable owns
the turn. A bidirectional app-server client uses a separate interface.
[Thread wrapper](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/sdk/typescript/src/thread.ts#L65-L111),
[subprocess I/O](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/sdk/typescript/src/exec.ts#L203-L247).

`@openai/agents` re-exports `@openai/agents-core`. At inspected revision
`7589b9c40120b89a7d2d28a5a60b4defe1ed7bf5`, the run loop is a TypeScript
`while` loop in `Runner`. The tool executor calls `invokeFunctionTool`.
The tool wrapper validates the input and awaits `options.execute` inside
the application. This directly establishes where the loop and custom tool
execute. [Package entry](https://github.com/openai/openai-agents-js/blob/7589b9c40120b89a7d2d28a5a60b4defe1ed7bf5/packages/agents/src/index.ts#L1-L12),
[runner](https://github.com/openai/openai-agents-js/blob/7589b9c40120b89a7d2d28a5a60b4defe1ed7bf5/packages/agents-core/src/run.ts#L1666),
[tool dispatch](https://github.com/openai/openai-agents-js/blob/7589b9c40120b89a7d2d28a5a60b4defe1ed7bf5/packages/agents-core/src/runner/toolExecution.ts#L1435),
[handler invocation](https://github.com/openai/openai-agents-js/blob/7589b9c40120b89a7d2d28a5a60b4defe1ed7bf5/packages/agents-core/src/tool.ts#L2466).

### Three Codex extension paths

1. **Client-executed dynamic tool.** `thread/start` carries the name,
   description, and input JSON Schema. When the model calls it, core inserts
   a Rust one-shot sender keyed by the tool's `callId` in active-turn state.
   The `item/started` handler sends a second message, `item/tool/call`,
   which has its own JSON-RPC request ID and carries `threadId`, `turnId`,
   `callId`, tool name, and arguments. The client answers that RPC request
   with `success` and `contentItems`. App-server translates the response
   into a core operation using the original `callId`, and the session
   removes and resolves the pending sender. Core awaits the reply with
   cancellation. A live thread can replay pending requests on warm resume.
   The reply slot settles once. A side-effecting client handler still
   needs to account for repeated delivery of its request.
   [Descriptors](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/protocol/src/dynamic_tools.rs#L10-L27),
   [wire fields](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1815-L1846),
   [request IDs](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server/src/outgoing_message.rs#L384-L396),
   [core reply slot](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/core/src/session/mod.rs#L3865-L3882),
   [pending request replay](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L1283-L1285).
2. **Configured lifecycle hook.** At `PreToolUse`, Codex selects handlers
   by event and tool matcher. The payload includes tool name, arguments,
   tool-use ID, and turn/session identity. A command handler gets JSON on
   stdin and returns output the event-specific parser interprets. Codex
   enforces a deadline while sending input and reading output. An MCP
   handler uses an existing MCP connection and the same event-specific
   contract. For supported calls, the result can deny, replace arguments,
   or add context. The core resolves multiple results and owns execution.
   A JS script or MCP server can implement this interface.
   [Hooks docs](https://learn.chatgpt.com/docs/hooks),
   [transport dispatch](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/hooks/src/engine/dispatcher.rs#L205-L241),
   [process I/O and deadline](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/hooks/src/engine/command_runner.rs#L280-L352),
   [input and outcome](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/hooks/src/events/pre_tool_use.rs#L119-L196).
3. **Native contributor.** A Rust `ModelRequestContributor` can contribute
   metadata and construct a per-request interceptor. The interceptor takes
   ownership of a typed model response stream and returns another stream.
   The core composes the wrappers. Dropping a wrapper must cancel its
   upstream stream. That is a deeper contract than returning a JSON decision
   at a defined point in a turn.
   [Native trait](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/ext/extension-api/src/model_request.rs#L21-L53),
   [composition](https://github.com/openai/codex/blob/392ced7d3a9160fd35d40c606359869215f50522/codex-rs/core/src/model_request.rs#L28-L65).

## Deep Agents JS and Python

- **Middleware is a strong composition model.** Both versions assemble
  filesystem, summarization, delegation, skills, caching, and interaction
  middleware around LangChain's agent builder. There are distinct graph
  checkpoints, long-term stores, and filesystem backends. The default JS
  filesystem can be backed by graph state, and a composite backend can route
  path prefixes. Swapping a filesystem backend therefore changes a different
  contract from swapping a graph checkpointer.
  [JS assembly](https://github.com/langchain-ai/deepagentsjs/blob/cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81/libs/deepagents/src/agent.ts#L489-L593),
  [JS types](https://github.com/langchain-ai/deepagentsjs/blob/cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81/libs/deepagents/src/types.ts#L559-L612),
  [state-backed files](https://github.com/langchain-ai/deepagentsjs/blob/cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81/libs/deepagents/src/backends/state.ts#L173-L216),
  [Python assembly](https://github.com/langchain-ai/deepagents/blob/f2a6e02dc8e2dcb05885c5133b94102ccc79b794/libs/deepagents/deepagents/graph.py#L920-L953).
- **Checkpoint cost follows the execution model.** LangGraph persists graph
  state at execution steps. Resuming an interrupt restarts the node from the
  beginning and requires care with preceding side effects. This serves
  workflow graphs with branching and resumable work. A conversational engine
  with defined transitions can persist less state and expose simpler guarantees.
  [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence),
  [interrupt semantics](https://docs.langchain.com/oss/javascript/langgraph/interrupts).
- **Two delegation mechanisms.** The synchronous JS `task` tool invokes a
  nested agent with fresh or selected context and returns a filtered or
  structured result. The async middleware launches a remote thread and run
  before it persists those IDs into the parent's state. Source order shows a
  possible crash window between launch and registration. The JS tree also
  contains a reproduction test asserting that forced `keep: 0` summarization
  drops an active instruction, and a skipped nested interaction scenario.
  These are scoped findings from inspection.
  [Nested invocation](https://github.com/langchain-ai/deepagentsjs/blob/cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81/libs/deepagents/src/middleware/subagents.ts#L884-L934),
  [remote launch](https://github.com/langchain-ai/deepagentsjs/blob/cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81/libs/deepagents/src/middleware/async_subagents.ts#L1253-L1295),
  [summarization reproduction](https://github.com/langchain-ai/deepagentsjs/blob/cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81/libs/deepagents/src/middleware/summarization.active-turn.repro.test.ts#L8-L58),
  [interaction test](https://github.com/langchain-ai/deepagentsjs/blob/cca721d0289ca0f9eb1c483e2cbff1bc7dc07b81/libs/deepagents/src/middleware/subagents-hitl.int.test.ts#L126-L150).

## Evidence still needed

- Run an ordinary web chat on a Harness composition with scoped retrieval and
  attachments. Check history, cancellation, interactions, and access across
  reconnect.
- Measure which Planner writes truly need a shared transaction. Exercise the
  tool crash window with a durable effect receipt and compare an embedded
  adapter with an independent runtime handoff.
- Specify the desired behavior of queued submissions, pending interactions,
  interrupted tool calls, and child completion on process death before
  selecting a recovery depth. Prototype against real SQLite and PostgreSQL
  constraints once the workflow needs both.
