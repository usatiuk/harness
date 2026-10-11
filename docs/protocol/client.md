# Harness client protocol

Harness exposes one bidirectional JSON-RPC 2.0 connection. Desktop and TUI
attach to a shared background server through local, WSL, or non-interactive SSH
adapters. Isolated stdio and in-process transports use the same current contract.
Transport does not change message semantics. Only the current protocol and
plugin contract versions are supported; there are no older-format adapters.

The committed [JSON Schema](client.schema.json) defines every core and shipped
plugin and shipped application parameter, result, notification, and attach snapshot. Zod is the
TypeScript authoring/runtime source. This document defines behavior schemas
cannot express.

## Connection

`initialize` is the first application request and requires protocol version `6`. It exchanges
peer identity and supported `{id, version}` plugin contracts. JSON-RPC request
IDs may be strings or integers and are scoped to the requester, so both peers may
use the same ID concurrently. Batches are unsupported.

Version 5 includes required schema-declared provider settings in application
provider status and the provider-config update request. Version 4 clients and
servers fail the exact-version handshake; no settings compatibility adapter exists.

Both peers may make requests. The requester may cancel with the standard
`$/cancelRequest` notification; handlers observe an abort signal and cancelled
work returns error `-32800` when a response has not already won the race.
Connection closure rejects outstanding requests and removes that observer. Accepted
work and prepared root runtimes belong to the shared server.
Unknown requests return `Method not found`; unknown optional notifications may be
ignored.

Stdio carries one compact JSON object per UTF-8 line. A frame is at most 4 MiB and
the serialized writer queue at most 8 MiB. Stdout is protocol-only; diagnostics
use stderr. Frame or queue overflow closes the connection instead of parking a
request whose response could not be written. WSL and SSH adapters execute a
fixed bridge from the prepared runtime. SSH uses OpenSSH BatchMode and the user's
configuration for aliases, keys, ports, and host verification. Workspace paths
and other inputs remain JSON-RPC parameters. The server has the authority of the
selected OS user.

`harness server --background` runs the shared owner without a client transport.
`harness server --bridge` ensures that owner is ready and relays stdio into its
authenticated local socket or named pipe. Closing the bridge removes that connection;
the owner continues with zero clients. `--stdio` owns an isolated composition
and disposes it on EOF.

Discovery lives under the canonical Harness home's user-private `.running-server`
directory. Windows protects the random token with current-user DPAPI as well as
directory ACLs; POSIX uses owner-only permissions. The socket accepts a token line
of at most 128 bytes within five seconds and returns one identity JSON line of at
most 4 KiB before NDJSON RPC begins. Clients validate that identity against the
requested canonical home and discovery record. They verify readiness rather than trusting a
discovery file or PID. Unix uses a user-private socket; Windows uses an account-local
named pipe with current-user permissions and remote clients rejected. There is no
local TCP listener or fallback. SQLite exclusive ownership arbitrates simultaneous starts.

Before application initialization, management version `1` exposes
`management.inspect`, `management.stop`, and `management.release`. Inspection
returns the management and product versions together with the server identity,
including its application protocol version. Stop/release require the inspected
instance ID. This lets a client inspect or stop a protocol-incompatible owner
without pretending application initialization succeeded. Management and ordinary
RPC use the same authenticated local connection.

After initialization, `server.info` returns the canonical home, stable server ID,
per-process instance ID, PID, platform, management/product/protocol versions and build ID.
`server.stop` returns acceptance and then drains the shared composition and closes
its clients. Acceptance does not mean drainage is finished; the control adapter
waits for connection closure. `server.release` atomically accepts shutdown only
when its authenticated control connection is the sole remaining client, then
closes admission. Desktop uses it for the remembered Local stop-on-exit policy.
If another client remains, it leaves the owner running. These owner controls are provided by background
servers, not isolated in-process compositions.

## Conversations and attachment

`conversation.attach` prepares a conversation and admits its root scope to
the connection's live set. It returns a bounded authoritative snapshot of the
root, loaded conversation-tree state, aggregate usage, and already-created plugin state. It
does not return transcript history.

The shared RPC host admits preparation and owns its lifetime. Failed or cancelled
attachments remove only their observer; they cannot dispose another client's runtime. After preparation and store reads, the
server captures the live snapshot and admits the root scope without another await. The ordered
connection may deliver an early notification before the request promise resumes,
so the client coordinator buffers notifications during attach, applies the
snapshot first, then releases them. This is per client operation: no engine,
conversation, or application-wide pause exists. The snapshot and buffered suffix
are each limited to 2 MiB; overflow fails the connection.

Runtime-loading or mutating conversation and plugin requests require attachment.
Close/reload synchronously stops new requests for that root. Forced close first
aborts admitted operations and runtime turns, then waits before disposing root-owned
services. A non-forced close reports `busy` if any tree runtime, input queue, or
plugin service still has live work.

`conversation.detached {rootConversationId}` announces that the old activation
has been removed, including cleanup failures and the teardown part of reload.
It precedes the operation response. Clients clear that activation's buffered
events, membership, and plugin caches; a successful reload then installs the new
snapshot and its event suffix. A failure before teardown preserves attachment.
Snapshot configuration is the live runtime's effective value; durable head/history
remain freshly read from the store.

The server does not maintain a generic UI reducer. Store owns immutable items;
runtime owns turns and accepted pending input; each plugin owns its live objects.
Attach reads small projections from those authorities. Anything actionable and
long-lived, such as an approval or activity, is server-owned and
included in a bounded snapshot rather than reconstructed from old events.

## History and live events

Assistant messages and text deltas carry phase as `null` when unreported or
`{value: string | null}` when explicitly reported. This preserves absent phase
separately from reported null. Reasoning remains a separate item/event.
`provider_output` items contain display-only activity text. Native provider
payloads never cross RPC. Deltas are ephemeral; finalized immutable items replace
previews. Usage summaries include `costIncomplete` for unknown prices/search fees.

History is fetched after attach with `conversation.history`. The first page fixes
an immutable head anchor; subsequent newest-first pages follow parent item IDs.
Pages are byte-bounded. An item too large to inline becomes
`{kind:"itemRef", itemId, byteLength}` and is retrieved in stable base64 ranges
with `conversation.item.read`.

Every durable append emits one `item.appended` value with the same wire shape as
history. Clients deduplicate by item ID; a duplicate canonical text/reasoning item
also removes its overlapping transient draft. Status, pending input, head, and
configuration carry latest semantic values; `usage.changed` replaces the full
aggregate rather than adding a delta. Text and reasoning deltas are transient; a
missed delta converges when the durable item arrives. Reconnect installs fresh attachment and history state. For a turn already running
in that attachment, transient text/reasoning deltas are suppressed until canonical
items arrive; future turns stream normally. There is no replay log or automatic
mutation resubmission. A timeout or transport loss does not prove a send was rejected.

Usage summaries include nullable `agentContext` and `lastTurn`. The checkpoint
contains the latest agent request attempt's provider/model, turn, timestamp and
nullable reported usage. It is published before tools/approval waits; a newer
unknown attempt clears the reported count instead of retaining a stale value.
Cumulative native-search billing can retain known spend while exposing null
checkpoint usage; it is not a single-prompt context measurement.
The latest terminal turn includes aggregate usage/cost, incomplete accounting and
nullable agent output/duration facts. Request duration includes provider latency
and stream consumption, excluding tools and approval waits. Unknown accounting,
historical purpose or duration makes throughput unavailable. Terminal publication
follows accounting settlement. Attachment restores the same authoritative facts.
Version 4 requires these fields, so older peers fail exact-version initialization.

The shared domain client buffers only the initial root attach/history gap;
events for unobserved descendants do not accumulate in an unused presentation
backlog. A client that later opens a root uses fresh history and an attach snapshot.

Closing or reloading a root affects only that conversation tree. Switching the visible
screen leaves other attached roots running. Closing the connection detaches its observer. Explicit root close/reload affects
every client attached to that tree.
Shutdown drains every root and reports real disposal failures after drainage
rather than returning false success.

## Plugins

Plugins use ordinary namespaced JSON-RPC messages such as
`plugin.activities.peek`; there is no remote-object proxy or generic
`extension.invoke`. A plugin may contribute a bounded synchronous attach
snapshot derived only from already-created state. Large data uses a feature
request, not the attach response.

The shipped contracts cover activities, workspace shell streaming, sandbox
control, subagent list filtering, approval, and MCP host settings, credentials,
tools and sign-in. MCP configuration belongs to the host's global settings;
saved changes require explicit host restart. Sign-in belongs to its initiating
client connection and is cancelled on detach. Workspace shell IDs are allocated
with a fresh UUID; duplicate active activity IDs fail rather than overwrite.
The approval contract exposes pending requests in the approval attach snapshot,
created/resolved notifications, and a client-to-server decision request. The first
valid decision resolves the kernel-owned request; subsequent decisions return
resolved=false. Disconnect does not decide an approval. A child approval remains
answerable while another conversation is visible.

Sandbox status includes a `warning` phase. Explicit shared Docker stop/rebuild
warns all affected conversations and proceeds. Ordinary conversation close
releases its environment ownership and work; another owner's environment remains.

Wire values are strict JSON. No dates, bigints, maps, sets, classes, functions,
`undefined`, coercion, or Zod transforms cross the boundary. Invalid inbound
values are rejected once at dispatch; an invalid outbound value is a program
defect and closes or errors the affected protocol operation without exposing
stacks, credentials, provider bodies, or opaque provider payloads.

## Shipped application controls

`@harness/server/client-protocol` defines the composition-owned `app.*` messages,
separate from kernel and plugin semantics:

- `app.settings.get` returns global model/preset, approval, auto-approver enabled
  flag and optional reviewer model/preset, and sandbox defaults,
  home/cwd/platform, and safe provider authentication metadata.
- `app.settings.update` persists the exposed defaults through existing validated
  config writers. Approval and auto-review defaults refresh loaded conversations
  without writing conversation overrides; existing model selections remain pinned.
  Clearing the reviewer model restores use of each conversation's model.
- `app.auth.login` accepts an API key or starts cancellable OAuth with an explicit
  `flow` of `browser` or `device`. `app.auth.url` supplies the sign-in URL and
  nullable `userCode`; device codes are displayed by the client. It never returns
  credentials.
- `app.auth.logout` deletes stored credentials. Auth mutations return
  `restartRequired: true`; the client explicitly restarts its owned server to
  rebuild provider composition.

These operations carry the authority of the local server user, like existing
stdio controls. They are not an unauthenticated network API. Request cancellation
and server close abort OAuth and drain tracked auth/settings mutations before releasing
ownership. Safe classified validation errors can be shown to users; unexpected
internal failures retain the generic protocol error treatment.

Conversation records include nullable `title` metadata. Protocol 6 adds
`title.changed` updates and the application settings naming model/preset.
