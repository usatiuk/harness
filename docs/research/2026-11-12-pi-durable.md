# Pi Durable

Source inspection on 2026-11-12. The fresh shallow clone is at
`D:/projects/ref/pi-durable`, from the Pi monorepo at
`b8e1eec80dc54aa87225f854ee152906cf2d2b40`. The package is
`@earendil-works/pi-durable` 1.5.2 at this revision. The earlier comparison
uses a separate pinned checkout. Earendil describes Durable as experimental
and as a separate runtime from the classic coding agent. This investigation
read the source and existing tests without running them.
[Package](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/package.json#L1-L7),
[announcement](https://earendil.com/posts/pi-durable/),
[earlier comparison](2026-11-11-embeddable-harness-sources.md#pi).

## The model-call library underneath

`@earendil-works/pi-ai` already implements the single model call discussed
here. `models.streamSimple(model, { messages, tools }, { signal })` streams
normalized text, thinking, and tool-call events. `stream.result()` returns
an assistant message with finalized calls, usage, stop reason, and provider
metadata. The caller supplies tool schemas, executes any returned calls,
and appends their results. The same primitive can sample a normal answer
or summarize an old transcript prefix with a different prompt and tool set.
Pi Durable adds its scheduler and storage above this layer.
[Pi AI quick start](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/ai/README.md#L108-L209),
[stream types](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/ai/src/types.ts#L831-L847).

Vercel AI SDK has a similar use of `streamText` or `generateText`. These
default to one model generation, and an app can supply function schemas
without `execute` handlers and handle calls itself.
[AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling).

### Streaming, reasoning, and attachments

Pi AI emits typed start, delta, and end events for text, thinking, and tool
calls. Persist the finalized assistant message for the next request. It
keeps provider-specific fields such as Anthropic's signed or redacted
thinking, OpenAI's encrypted reasoning items, and Gemini's thought
signatures on the relevant blocks. Its transcript conversion retains
compatible opaque fields for the originating model and drops thinking
when switching models. Even with the same model, some Anthropic thinking
blocks are bound to the preceding request. Pi's managed adaptive-thinking
path asks the provider to drop invalid blocks after a prefix change.
[Stream events](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/ai/src/types.ts#L824-L847),
[cross-model conversion](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/ai/src/api/transform-messages.ts#L119-L154),
[Anthropic thinking configuration](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/ai/src/api/anthropic-messages.ts#L1539-L1550).

Pi AI's chat input accepts text and base64 images. Model capability governs
image delivery. The normalized chat types have no generic file or audio
part. The p2 host lists attachment paths for tools to read and inlines
eligible images. A document-aware host can use text extraction, render
pages as images, or route native documents through a separate adapter.
Vercel AI SDK exposes a `file` part with a media type, with documented PDF
support in its OpenAI Responses, Anthropic, and Google adapters. The
provider and model still determine which media they accept. Both
approaches leave upload ownership, access checks, and blob storage to
the host. These claims are based on the implementation and official
documentation. No live multimodal requests were run.
[Pi message types](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/ai/src/types.ts#L587-L595),
[p2 attachment conversion](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/apps/p2/plugins/chat/worker.ts#L90-L121),
[AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai#pdf-inputs),
[Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic),
[Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google#file-inputs).

## What an interrupted tool does

The default policy is close to the rule discussed for Harness. A model-issued
tool that might already have run gets an error result with any saved partial
output. The model can inspect the outcome and issue a new call.

1. The generation task commits the assistant item and the tool work together.
   It then waits for the tool tasks to settle. It can schedule a round
   sequentially or in parallel.
2. The tool task resolves the handler, validates arguments, runs
   `beforeTool`, and revalidates any replacement arguments. It commits a
   checkpoint with the final arguments and replay policy before calling
   `execute()`. The live display and the execution checkpoint have different
   durability requirements.
3. If the owner reopens after that checkpoint, the original execution might
   have happened. The default `unsafe` policy settles with an interrupted
   error. A rerun occurs only if the saved policy and the currently selected
   tool both declare `replay: "safe"`. This is an assertion by the tool author.
   A crash before the intent commit can run preparation and gates again.
4. Settlement commits the tool result and the task's terminal state together.
   The generation task can then send the result to the model. The SQLite
   recovery test closes after a tool starts, reopens, checks one execution,
   checks the partial output plus the interrupted diagnostic, and checks that
   the run reaches its answer.

[Generation commits the call and task](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/generation.ts#L1178-L1205),
[tool admission and intent](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/tool.ts#L169-L205),
[durable checkpoint](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/tool.ts#L362-L378),
[recovery branch](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/tool.ts#L233-L264),
[settlement](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/tool.ts#L1174-L1221),
[one-execution test](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/test/harness-tools-recovery.test.ts#L109-L134).

Two other behaviors have separate contracts. Model requests interrupted by
a crash use the model retry policy, enabled with three retries by default.
A parked tool deliberately suspends for a signal, time, or owned child and
can enter its handler again on a wake with explicit checkpoint data. This
works even for an unsafe tool that successfully committed its park before
the process stopped. The handler is responsible for using the wake data to
pick up the job it started.
[Model interruption](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/generation.ts#L567-L614),
[retry defaults](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/agent.ts#L23-L28),
[parked phase](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/tool.ts#L211-L231),
[tool parking](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L382-L422).

## How the loop and storage fit together

Pi Durable uses a scheduler over explicit task phases. One model round is
tracked by a generation task. Tool calls are tasks owned by that generation.
Conversations contain immutable entries, while typed JSON documents hold
live state, inboxes, agent settings, usage, and application state. Each task
has a name, version, checkpoint, and owner. Durable custom tasks add upgrade
work. A checkpoint may have to migrate or wait for a missing extension.
[Records](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L92-L112),
[generation phases](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/generation.ts#L73-L166),
[task compatibility](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/scheduler.ts#L2160-L2186).

The key API is `commit(tx => ...)`. A host can read a typed document,
admit a submission, and write application state in the same commit. The
visitor-chat example checks a mute list, admits a steer, and records the
message in an application document. This is a genuine shared commit
because the example puts the application state in the same Durable
transaction. The Chord shared-store example puts an application table and
Durable records on the same underlying store and performs those operations
in separate commits. A host that needs to combine existing SQL domain tables
with admission still needs to establish that transaction integration.
[Admission example](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/test/examples/34-submit-in-commit.ts#L64-L80),
[admission constraints](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L635-L647),
[shared Chord store example](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/test/examples/35-durable-on-the-store.ts#L37-L81).

The storage adapter commits typed batches. It assigns a sequence and reports
a durability receipt for each committed batch. The session publishes those
batches to its view in order. A known refusal stops the batch sequence at
that point, preserving the accepted prefix. An unknown commit result fails
the session. The same interface ships with memory, IndexedDB, SQLite,
JSONL, Cloudflare Durable Object SQLite, and Chord StoreStorage adapters.
The host is responsible for **one writer per store**. A PostgreSQL adapter
by itself would still have that ownership contract. The Node SQLite
configuration described in the README protects against a process crash and
can lose recent commits on host or power failure.
[Storage contract and limits](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L1010-L1052),
[SQLite commit and receipts](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/storage/sqlite/storage.ts#L152-L196),
[writer publication](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/session/writer.ts#L160-L200).

The attach path takes a view and subscribes atomically on the session's
mutation queue. Progress can be visible before it is durable via explicitly
deferred document updates. A reconnecting UI can reload committed history
and the current view. Conversation-scoped request IDs let a caller repeat
submission delivery without starting a second run. The admission code
returns the prior same-type submission for that key. It does not compare
the contents of two same-type submissions.
[Atomic observation](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/view.ts#L221-L247),
[deferred publication](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L986-L998),
[submission ID lookup](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/harness/submissions.ts#L220-L237).

## How a host passes tools and hooks

Tools are native TypeScript functions registered through `defineTool` and
`defineExtension`. The process owns their implementation. The conversation
stores names and selection. The host supplies the registry, model access,
storage, and execution environment to `Harness.open`. Per-conversation
configuration limits tools, extensions, model, and working directory.
An extension can wrap a selected tool in TypeScript, install a `beforeTool`
gate or `afterTool` result hook, or contribute generation hooks. The default
tool contribution and execution path needs no FFI. A foreign implementation
can live behind a proxy tool, as p2 does for MCP.
[Extension and registry API](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L273-L292),
[tool visibility](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L424-L440),
[hook contracts](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L750-L803),
[p2 MCP proxy](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/apps/p2/plugins/mcp/tools.ts#L145-L175).

The same machinery supports an approval gate without an open stack frame.
A `beforeTool` hook can park the tool before its intent, waiting for a typed
signal. When the signal arrives, the gate runs again and can allow or deny
the call. The host authenticates who may answer. A policy author needs to
order argument rewrites and approvals so the approved arguments are the ones
executed.
[Approval gate](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L773-L804),
[signal delivery and ownership](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L250-L261).

## Subagents and code mode

A child agent is an ordinary conversation owned by a task. The example
creates it and sets its profile in one commit, reuses the child by owner
task ID, and submits work with a stable request ID. An optional background
anchor gives the child a lifetime independent of the parent's foreground
work. This reuses conversation and task primitives. The product still
defines delegation tools and their access, context, and reporting policy.
[Child ownership and foreground/background examples](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L872-L917).

Code mode opts into a stronger recovery contract. It runs JS with a
deterministic clock and RNG and persists each result it delivers to the VM.
After a restart it runs the JS again, feeds journaled results back in order,
and finds nested calls by key. Finished tool effects remain completed.
A nested call that was in flight still follows that tool's own replay
policy. Version, deadline, fingerprint, or divergent execution can prevent
recovery. This is extra machinery for resumable scripts. A design that
ends an interrupted script can keep its committed child results and omit
the replay journal.
[Code mode behavior](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/README.md#L446-L459),
[journal design in code](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/packages/durable/src/codemode/codemode.ts#L8-L35).

## A real host to study

`apps/p2` is an experimental self-hosted app with browser and terminal
clients. A session worker opens Durable over the session's Chord store and
injects models, extensions, and an environment selected for the conversation.
The chat handler checks access, resolves attachments, and submits user input
and display metadata to Durable. The app uses separate plugins for coding
tools, chat, MCP, and subagents. This is concrete evidence of ordinary chat
and coding capabilities composed around one runtime. The p2 README marks
the app as a prototype and describes owner-level execution access. It is
evidence for composition rather than a verified multi-tenant deployment.
[p2 status and ownership](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/apps/p2/README.md#L1-L10),
[worker composition](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/apps/p2/src/runtime/worker.ts#L743-L768),
[storage adapter](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/apps/p2/src/runtime/session-store.ts#L1-L15),
[chat attachment admission](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/apps/p2/plugins/chat/worker.ts#L435-L450),
[input conversion](https://github.com/earendil-works/pi/blob/b8e1eec80dc54aa87225f854ee152906cf2d2b40/apps/p2/plugins/chat/worker.ts#L248-L271).

For a clean-slate harness, the directly reusable design ideas are the
tool-intent boundary, atomic admission, scoped host tool registration, and
child ownership. Pi's versioned task scheduler, park and signal system, and
code mode replay become relevant when work must continue across process
exit. A design that closes interrupted calls and lets the model decide its
next action needs much less of that machinery. This conclusion comes from
source inspection. This study did not exercise p2, external providers, or
the storage adapters at runtime.
