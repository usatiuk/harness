# Feedback integration

`@harness/feedback` owns optional case capture and delivery to the sibling MAI
controller. The server composes its runtime, registers typed plugin RPC methods
on each client session and drains it during shutdown. Desktop uses those RPCs;
MAI never reads Harness SQLite directly or executes agent tools.

## Configuration and user flow

Settings → Feedback edits global `feedback` configuration: `enabled`,
`endpoint`, and `tokenEnv` (default `MAI_TOKEN`). It has its own Feedback tab,
separate from MCP servers. The form uses shared controls and layout; token-variable
setup is under Connection details. Credentials come from the server
environment and are never configuration values. HTTPS is required except for
loopback HTTP. URL credentials, queries and fragments are rejected. Controls
appear only when enabled and configured. Restart the server for environment
changes and reopen the conversation after configuration changes.

A vote targets a durable assistant, reasoning or tool item with an optional
comment and stable client-generated ID. The runtime checks branch access and
snapshots the selected item, original model outputs, model/configuration,
transcript, effective context and available Git revision/status/dirty patch.
Nested tool items resolve to their owning model decision. Context and evidence
are bounded; oversized capture fails explicitly. No complete repository snapshot
or perfect replay is promised. Untracked file contents are not captured.

OpenAI chat/Responses adapters expose post-format request bodies through the
optional model-call capture hook. Core links finalized outputs to the originating
attempt, retaining logical middleware context identity. Native chat requests are
exported; other native artifacts remain in Harness. Canonical context still
travels. Opaque provider payloads, headers and environment credentials are excluded.
Readable chat reasoning is distinguished from summaries/unknown artifacts.
Historical or middleware-synthesized items can lack linkage; that limit is explicit.
Prompt and tool content may still contain sensitive text: capture is not a secret
scanner, and users should inspect a case before submitting it to teachers.

## Durable delivery

Before acknowledgement, the immutable case is atomically saved under
`HARNESS_HOME/feedback`. A serialized background drain sends it with bearer auth
and stable case identity; offline delivery retries on a bounded interval and via
Settings. Startup does not wait for delivery. Configuration changes do not reroute
already queued cases. Successful delivery retains only a small receipt under
`feedback/delivered`; routine retries read pending files rather than old evidence.
MAI imports case IDs idempotently. A vote never approves a proposal, submits a
training job or promotes a candidate.

Typed RPCs: `plugin.feedback.status`, `.configure`, `.vote`, and `.retry`. Schemas
are included in the generated client protocol. The standalone MAI web app owns
clarifications, review, export, cloud training and manual keep/reject records.
Candidate models use existing provider configuration and an explicit `trained`
preset; active sessions are not automatically changed.

## Qualification

Real in-process server/RPC/SQLite tests cover disabled capture, immutable case
identity, offline delivery and retry, and artifact exclusion. Engine regressions
cover buffered events and concurrent same-request attempts. Full repository
checks cover desktop types/lint; native clicking of the new controls and live
provider training/serving remain separate acceptance checks. See sibling
[MAI validation](../../../../mai/docs/TESTING.md).

The settings-tab/form correction passes the full check (1,394 passed, 41 gated
skips). Native rendering of the revised form remains a user walkthrough check.
