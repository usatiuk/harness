# Feedback integration

`@harness/feedback` owns optional case capture and delivery to the sibling MAI
controller. The server composes its runtime, registers typed plugin RPC methods
on each client session and drains it during shutdown. Desktop uses those RPCs;
MAI never reads Harness SQLite directly or executes agent tools.

## Configuration and user flow

Settings → Feedback edits global `feedback` configuration: `enabled` and
`endpoint`. Paste the MAI token in its masked field. Saving uses the existing
Harness credential backend, scoped to the controller endpoint. Leaving the field
blank keeps the saved token. The token never appears in configuration, status,
or outbox records. The form uses shared controls and layout in its own tab,
separate from MCP servers. HTTPS is required except for loopback HTTP; URL
credentials, queries and fragments are rejected. Vote icons appear beside Copy
on completed assistant messages when enabled and a stored token is available.
Tool and reasoning details also have vote controls. Selecting a thumb opens an
optional comment popover.

Earlier development configuration used `plugins.feedback.tokenEnv`. Remove that
obsolete property once from `settings.json`, then paste the token in Feedback
settings. The dev home used for this implementation has already been updated.
No environment variable is required.

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

The endpoint-scoped secret-store and Copy-row icon changes pass the full check
(1,394 passed, 41 gated skips), plus the focused RPC regression. That regression
covers first-use credential-backend selection, omission from settings/status/
outbox, endpoint isolation and retained tokens on ordinary settings saves. The
running dev server also reports enabled/configured after the token was saved to
its existing keyring. Native visual acceptance remains with the user.

A follow-up fixed the client’s route parameter: conversation routes expose
`conversationId`, not `id`. The previous guard silently hid every vote control.
The user confirmed the corrected buttons appear in the dev app. A browser
regression covers Copy-row icons and submission from the actual conversation
route, using the existing full-router fixture. Do not launch `desktop:dev` for
the user; they explicitly asked to control desktop startup themselves.

The route fix passes the full Harness check (1,394 passed, 41 gated skips). The
new browser regression is authored but has not been executed; the user confirmed
the buttons are visible in the actual dev app.
