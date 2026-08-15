# Harness client protocol v1

Harness exposes one bidirectional JSON-RPC 2.0 connection. The current TUI uses
it over an in-process queue; `harness server --stdio` uses newline-delimited JSON
over pipes, including through SSH. Transport does not change message semantics.

The committed [JSON Schema](client-v1.schema.json) defines every core and shipped
plugin parameter, result, notification, and attach snapshot. Zod is the
TypeScript authoring/runtime source. This document defines behavior schemas
cannot express.

## Connection

`initialize` is the first request and requires protocol version `1`. It exchanges
peer identity and supported `{id, version}` plugin contracts. JSON-RPC request
IDs may be strings or integers and are scoped to the requester, so both peers may
use the same ID concurrently. Batches are unsupported.

Both peers may make requests. The requester may cancel with the standard
`$/cancelRequest` notification; handlers observe an abort signal and cancelled
work returns error `-32800` when a response has not already won the race.
Connection closure rejects outstanding requests and closes every root scope whose
attachment started on that connection, including failed or in-flight attachment.
Unknown requests return `Method not found`; unknown optional notifications may be
ignored.

Stdio carries one compact JSON object per UTF-8 line. A frame is at most 4 MiB and
the serialized writer queue at most 8 MiB. Stdout is protocol-only; diagnostics
use stderr. Frame or queue overflow closes the connection instead of parking a
request whose response could not be written. The SSH client executes the fixed
command:

```text
ssh -T -- <destination> harness server --stdio
```

Only the validated destination varies. Workspace paths and other inputs remain
JSON-RPC parameters. The server has the authority of the remote OS user and is
not an unauthenticated network service.

## Conversations and attachment

`conversation.attach` prepares a conversation and admits its root scope to
the connection's live set. It returns a bounded authoritative snapshot of the
root, loaded conversation-tree state, aggregate usage, and already-created plugin state. It
does not return transcript history.

Ownership begins before asynchronous preparation. Failure or connection shutdown
force-cleans a newly prepared runtime. After preparation and store reads, the
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

The server does not maintain a generic UI reducer. Store owns immutable items;
runtime owns turns and accepted pending input; each plugin owns its live objects.
Attach reads small projections from those authorities. Anything actionable and
long-lived, such as an approval or activity, is owned by a connection coordinator
or included in a bounded snapshot rather than reconstructed from old events.

## History and live events

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
missed delta converges when the durable item arrives. V1 has no reconnect, replay
log, sequence cursor, or exactly-once claim.

Closing or reloading a root affects only that conversation tree. Switching the visible TUI
screen leaves other attached roots running. Closing the connection force-closes
all its root scopes and server-owned processes.

## Plugins

Plugins use ordinary namespaced JSON-RPC messages such as
`plugin.activities.peek`; there is no remote-object proxy or generic
`extension.invoke`. A plugin may contribute a bounded synchronous attach
snapshot derived only from already-created state. Large data uses a feature
request, not the attach response.

The shipped contracts cover activities, workspace shell streaming, sandbox
control, subagent list filtering, and approval. Workspace shell IDs are allocated
connection-wide and duplicate active activity IDs fail rather than overwrite. Approval is a server-to-client
request owned connection-wide, so a child approval remains answerable while a
different conversation is visible and simultaneous approvals remain queued. V1
requires attach before work can create an approval; it does not replay requests
during attachment. If the client did not advertise the approval contract, the
server denies instead of leaving work parked.

Wire values are strict JSON. No dates, bigints, maps, sets, classes, functions,
`undefined`, coercion, or Zod transforms cross the boundary. Invalid inbound
values are rejected once at dispatch; an invalid outbound value is a program
defect and closes or errors the affected protocol operation without exposing
stacks, credentials, provider bodies, or opaque provider payloads.
