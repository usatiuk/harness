# MCP tools and settings

Status: Completed; qualification evidence and remaining platform limits are recorded below.

## Outcome and scope

Add local stdio and hosted Streamable HTTP MCP tool servers as one plugin.
Desktop and TUI configure servers, environment variables, headers, authentication,
and permission defaults/overrides through the existing Harness JSON-RPC connection.
Human approval timeout lives in the approval plugin and both clients' approval
settings. Agent calls use ordinary discovery, dispatch, history, cancellation,
allowlists, and code mode.

First delivery: manually configured stdio/HTTP servers, environment/header value
sources, stored credentials, bearer auth, OAuth authorization-code/PKCE login,
Dynamic Client Registration (DCR), refresh, startup discovery, text and structured
JSON results, and settings in both clients. Configuration and manually changed
credentials take effect after an
explicit Harness server restart; OAuth token refresh belongs to the running auth
owner. Use the official TypeScript SDK and existing configuration writers, secret
backends, process cleanup, approval UI, and client controls.

Outside this delivery: legacy HTTP+SSE transport, resources/prompts,
sampling/elicitation, MCP Apps, marketplaces/importers, automatic reconnect/replay,
live catalog/config replacement, asynchronous human approval, additional OAuth
grants, generated settings UI, and a general permission or credential framework.
The agent waits for a bounded human decision; expiry denies the call and lets it
continue. There is no later execution of expired work.

## Grounding

- [Plugin contracts](../../../packages/protocol/src/plugin.ts) already support
  synchronous tool contributions and middleware. Await MCP initialization in
  [server bootstrap](../../../packages/server/src/index.ts); keep contributors
  synchronous.
- [Approval middleware](../../../packages/approval/src/approval.ts) currently
  gates all tools using workspace defaults. Its shared contracts require a
  workspace relationship. MCP needs its own gate and a workspace-neutral prompt.
- [Approval RPC](../../../packages/server/src/approvals.ts) and its
  [client](../../../packages/approval/src/client.ts) already carry prompts/answers.
  [Server tests](../../../packages/server/src/shared-server.test.ts) cover pending
  approvals across client disconnection and exactly one racing decision.
- [Tool inputs](../../../packages/core/src/tools.ts) use Zod; the
  [content contract](../../../packages/protocol/src/content.ts) is text-only.
  Preserve MCP JSON Schema and map supported results explicitly.
- [Secret stores](../../../packages/secrets/src/store.ts) and
  [backend selection](../../../packages/server/src/credential-store.ts) already
  serve the executing host. [Provider composition](../../../packages/server/src/auth.ts)
  supplies instance-scoped slots; reuse that pattern without registering MCP as a
  model provider. [Auth RPC](../../../packages/server/src/app-api.ts) shows safe
  status-only responses and live auth-owner reuse.
- Primary sources checked on 2026-10-10:
  [SDK](https://github.com/modelcontextprotocol/typescript-sdk),
  [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
  [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
  [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
  [SDK auth hooks](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/auth.ts),
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
  Annotations describe claimed behavior; they do not enforce it. OAuth is for HTTP;
  stdio receives credentials through its child environment.

## Design

### Ownership

`@harness/mcp` owns SDK transports, catalog/adapters, configuration, authentication,
annotations, and permission evaluation. SDK types stay inside that package.
`@harness/mcp/client` exports browser-safe configuration/RPC contracts and typed
calls. Desktop/TUI own presentation; the server wires startup, RPC, and shutdown.

MCP middleware gates only its own tools. The approval plugin owns the shared
question/answer, human timeout, and decision-recording mechanism. The approval-owned `createToolApproval(reader)` callable performs prompting and
decision recording. MCP passes the selected permission and ordinary tool call;
the callable reads approval configuration through the existing config reader. Scope the existing default gate away from MCP-owned tools through
a narrow predicate wired at server composition;
preserve its behavior for every other tool. No MCP classification, inheritance,
or trust model goes into core or shared approval.

### Startup and tool calls

Own one SDK client/transport per enabled server for the Harness server lifetime;
stdio additionally owns a child process, HTTP does not.
Await bounded initialization and discovery before admitting work. Classified
connection/auth failures leave the affected server unavailable and editable;
startup never waits for interactive sign-in. Malformed configuration and internal
defects fail normally. Use configured server IDs to namespace tool identities,
retain raw names inside adapters, and reject collisions.

Build the catalog once at startup. Use a maintained JSON Schema validator and the
existing tool-contract resolver first; add input support only if those boundaries
cannot preserve/validate the advertised schemas. Do not handwrite a JSON Schema
converter. Map text, structured JSON, and MCP `isError` to existing results/output
handling. Unsupported content or requested capabilities fail explicitly;
multimodal provider changes are outside scope.

Forward per-call cancellation through the SDK. Connection loss fails the call
without replay, because a write may already have happened. GUI/TUI disconnection
does not close MCP. Server shutdown drains calls and closes/terminates its child
processes and HTTP transports. Use SDK protocol negotiation and bounded HTTP
requests; do not add a custom HTTP transport or replay after ambiguous dispatch.
MCP runs on the selected Harness host; conversation sandbox settings do not
automatically contain it.

### MCP permission settings

Shared tool permission choices: `allow`, `ask`, `ask-human`, `deny`, owned by the
approval package and available to ordinary tools as well as MCP. Omitted MCP server/tool overrides mean
Inherit. MCP resolves global MCP defaults, then server defaults, then the exact
tool override. Two defaults are sufficient: read-only and other. Read-only starts
as Allow; writes, destructive tools, and missing/unknown hints start as Ask.
Contradictory hints use Other. Do not infer read-only behavior from names or
`destructiveHint: false`.

Manually enabling a server authorizes using its read-only declarations under the
configured policy; explain this in the settings editor. Explicit overrides win.
Keep this choice inside MCP configuration, without a separate trust registry.

Allow executes; Deny records rejection without calling the server. Ask follows
existing auto-review settings. Ask human sends the ordinary approval request with
`allowAutoApproval: false`; add that field to the shared server-side approval
request contract. The auto-reviewer passes it through to the human UI. Make
workspace relationship optional in shared prompt/decision and client contracts,
bump the approval client contract version, and omit absent workspace facts in both
clients and reviewer context. Existing workspace callers retain their facts.

`plugins.approval.humanApprovalTimeoutSeconds`, a positive finite duration,
defaults to 60 and applies to all human tool approvals, including MCP. Both clients
edit it in approval settings through the existing app settings RPC. The shared
approval callable resolves its own configuration and passes the duration as an
optional generic request-parking timeout through `ctx.request`. MCP does not read
or copy it. The single pending-request owner in `Engine.#parkRequest` starts and
owns the timer after auto-review passes
through. Expiry settles/removes the request once, emits the ordinary resolution,
and returns a timeout that shared prompting records as denial. RPC sessions only
project pending prompts and submit answers; the timer works with zero clients.
Late answers cannot execute the call. Cancel the timer on answer/interruption.
Keep timeout/routing options server-side; the UI needs no extra policy fields or
countdown. The existing auto-review timeout/denial behavior stays unchanged.
Existing workspace permission defaults/rules stay unchanged; their human prompts
gain the same bounded waiting behavior.

Code mode uses the same governed call path: expiry/denial returns the ordinary
failed child result. No pending handle, background execution, or evaluator change.

### Configuration and client communication

Store host-wide startup configuration under global `plugins.mcp`. Add a small
global-only declaration to existing plugin config registration; the resolver
rejects project/local/profile/conversation contributions before merging them.
MCP declares that scope; config/service remain unaware of MCP semantics. No
project/profile/conversation MCP configuration workflow.

Use explicit transport and value-source unions, validated by the MCP package:

```ts
type McpValueSource =
  | { type: "literal"; value: string } // non-secret configuration
  | { type: "env"; name: string } // executing host's environment
  | { type: "secret"; slot: string }; // this server's stored credential
type McpCredentialSource = Exclude<McpValueSource, { type: "literal" }>;

type McpTransportConfig =
  | {
      type: "stdio";
      executable: string;
      args: string[];
      cwd?: string;
      env: Record<string, McpValueSource>;
    }
  | {
      type: "http";
      url: string;
      headers: Record<string, McpValueSource>;
      auth:
        | { type: "none" }
        | { type: "bearer"; token: McpCredentialSource }
        | {
            type: "oauth";
            clientId?: string;
            clientSecret?: McpCredentialSource;
            clientMetadataUrl?: string;
            scopes?: string[];
          };
    };
```

`servers` is keyed by stable server ID; each entry contains `enabled`, `transport`,
and permission defaults/tool overrides. Literal env/header values are persisted
plaintext; label that source accordingly. Credential inputs use env references or
write-only stored slots. Reject a configured OAuth client secret without a client
ID. Do not add interpolation or implicit source precedence, or copy credential
input values into settings.
HTTP auth owns `Authorization` when bearer/OAuth is selected; reject a conflicting
header case-insensitively. Reserve SDK protocol/framing headers and validate URL
and header syntax before I/O. Hosted endpoints use HTTPS; HTTP is for loopback
development. Do not put credentials in URL userinfo/query strings or forward
configured headers to OAuth discovery/token endpoints or cross-origin redirects.
Inject resource headers only into MCP requests; OAuth discovery, DCR, and token
requests use an auth fetch without resource headers. Do not place credential
headers in SDK transport-wide request defaults inherited by its auth helpers.
Stdio uses the SDK's minimal platform environment plus configured entries; do not
inherit the entire Harness environment. Missing referenced values make that
server unavailable with a safe diagnostic.

### Credentials and OAuth

Keep three separate structures: saved connection configuration, scoped stored
credentials, and safe runtime/auth status. Server composition injects the existing host `SecretStore`; MCP creates scoped
views per stable server ID. Keep user aliases under
`mcp-server:<encoded ID>:credential:<encoded slot>` and internal OAuth records
under `mcp-server:<encoded ID>:oauth:<record>`. Configuration and credential-write
RPCs can address only user aliases; they cannot read/write OAuth token/client
records. Configuration contains local aliases, never physical store keys. Reuse
the host's existing `auth.store` selection/write path: macOS Keychain/Linux Secret Service,
Windows DPAPI, or the existing explicitly selected owner-only file backend on
supported hosts. Report the selected backend; do not invent encryption or silently
switch a pinned backend. OAuth records serialize the SDK's validated token/client
objects in an MCP-owned record with the configured endpoint/client identity;
preserve SDK issuer stamps and resource binding. An identity mismatch reads as
auth-required, so endpoint/client changes cannot send prior OAuth credentials to
a new target before discovery.

A user credential alias stores a validated `{ target, value }` record, with
`target` taken from the saved HTTP endpoint or stdio executable/args/cwd when the
credential is submitted. On resolution compare against the active or Test target;
a mismatch means credentials must be re-entered, before any value is injected.
Changing headers or source mappings within that configured target is an explicit
configuration choice; do not bind aliases to every incidental settings field.
Secret keys remain separate from the physical record format.

Credential inputs use dedicated set/delete RPCs, separate from settings save.
Return presence/source/auth status, never values, refresh tokens, or auth codes;
clear entered values in clients after submission. Resolve credentials only inside
the MCP host adapter, inject them into the selected child environment or HTTP
request, and exclude them from history, model context, logs, and diagnostics.

Use the SDK's OAuth discovery, DCR, pre-registered client support, PKCE, code
exchange, and refresh hooks. Honor its registration selection: configured client
ID, then a supplied Client ID Metadata Document URL when supported, then DCR using
the discovered registration endpoint. The metadata URL references an existing
document; Harness does not host or generate one. Persist issued client
information, including client secrets, in the scoped secret backend and reuse it
after restart. If registration is unavailable, report that a configured client ID
or compatible metadata URL is required; do not invent a public hosting service.
One auth owner per server serializes credential mutations/refresh across active
and Test transports. Login/logout cancel or drain
outstanding work before replacement/deletion; a late callback or refresh cannot
restore deleted credentials. Interactive sign-in is explicit in settings, with
bounded, cancellable attempts. The host keeps state/verifier and exchanges the
code; the client opens/displays the authorization URL. Capture the callback on a
reachable host loopback listener, with a full redirected-URL paste/complete RPC
for remote/headless use; validate redirect, state, issuer, and attempt ownership.
The initiating RPC session owns completion/cancellation authority; detachment
cancels its attempt, matching existing provider sign-in lifetime. A different
connection starts a fresh attempt. The host listener can complete the active
attempt independently of a client round-trip. Do not assume arbitrary MCP
servers offer device codes or add callback relays.
Missing credentials or required reauthorization remain visible; startup, Test,
and tool calls may refresh an existing session but cannot register a new client
or begin interactive login. Never launch a browser from those paths.
SDK auth-challenge retries are bounded;
transport/connection failures never replay a dispatched tool operation.

### RPC and client settings

Register typed `plugin.mcp.settings.get`, `plugin.mcp.settings.set`,
`plugin.mcp.tools.list`, and `plugin.mcp.test` requests in server composition.
Add typed `plugin.mcp.credentials.set/delete` and
`plugin.mcp.auth.start/complete/cancel/logout` calls for the credential/login
workflow. Login start returns an opaque attempt ID and authorization URL; complete
accepts that attempt's callback, never tokens. Reuse existing auth status and
cancellation presentation patterns without extending model-provider RPCs.
Get/set edit saved configuration. Tools list reads the active catalog. Test only
connects/discovers using the selected saved definition and always cleans up its
temporary transport/process; it reports auth-required without initiating login.
Set uses the existing serialized atomic writer to replace only the MCP slice,
preserving other
settings and allowing overrides to be cleared. Return saved settings, active
status, and restart-required state without exposing environment or secret values.

Desktop gets a focused MCP settings section. TUI uses its existing settings/command
patterns for equivalent operations. Both use the same browser-safe contracts to
edit transports, env/header sources, auth, defaults, and server/tool overrides.
Both expose credential replace/delete and OAuth sign-in/cancel/logout with safe
status. Add the timeout to their existing approval settings. They do not evaluate
policy or add a runtime permission-provenance display. Reuse approval UI and explicit
server restart controls.

## Milestones and completion checks

- [x] Startup and tool adapter
  - Add MCP package/config validation, global-only config registration, startup
    discovery for stdio/Streamable HTTP, input/result adapters, and shutdown. This
    precedes permissions and client integration.
  - Check: real fixture stdio and HTTP tools work through the public service;
    invalid args never reach MCP; duplicate names, startup failure, connection loss,
    cancellation, process/transport cleanup, and absence of replay have observed
    outcomes. Project/local/profile/conversation MCP config is rejected before I/O.
- [x] Credentials and HTTP authentication
  - Add typed value/auth sources, scoped host storage, safe status, and SDK OAuth
    owner. Depends on server identities/configuration and transport adapters;
    precedes client auth integration.
  - Check: env and stored values reach only the configured child/request; headers
    and bearer auth work; missing values/backend failures are visible; credential
    write inputs never enter settings/read responses, and user aliases cannot
    address internal OAuth records. Stored env/header/bearer values do not reach
    changed HTTP endpoints or stdio commands. A fixture proves configured resource
    headers are absent from OAuth discovery, DCR, token, and cross-origin redirect
    requests. Fixture OAuth proves PKCE,
    discovery, DCR, supplied metadata URLs and pre-registered clients, registration
    failure, callback/state validation, client/token persistence across restart and refresh,
    cancellation/expiry, endpoint isolation, and logout versus late refresh.
    Actual external sign-in remains a separate credential-dependent qualification.
- [x] Permissions and shared prompting
  - Add MCP defaults/overrides/middleware, scope the existing gate, share prompting,
    and add Ask human plus approval-owned configurable expiry. Depends on stable
    identities.
  - Check: inheritance, all four choices, exactly one gate, auto-review bypass,
    configurable expiry with zero/one/two clients, racing/late answers, prompt
    snapshots on reattach, and preserved existing permission decisions pass through
    direct calls, code mode, and scoped subagents.
- [x] RPC and desktop/TUI settings
  - Add contracts/handlers, connection Test, client editors, and credential/auth
    controls. Depends on configuration, authentication, and permission contracts.
  - Check: both clients configure both transports/env/headers/auth, load/save/clear
    rules, and edit the shared approval timeout on the selected host; restart
    activates changes. Exercise local callback and remote/headless completion.
    Test executes no tool and leaves no process/transport; responses expose no
    credential values. Verify MCP's dependencies are bundled.
- [x] Qualification and handoff
  - Update README, PLAN, owning subsystem docs, client schema, and TESTING.
  - Run focused regressions and `npm run check`; exercise the bundled server with
    external stdio/HTTP/OAuth fixtures and actual desktop/TUI controls on supported
    qualification paths. Record platform limits precisely. Obtain independent correctness,
    architecture/simplicity, and tests/scope reviews; resolve material findings.
  - Check: requested behavior is verified; required unfinished work stays open.

## Status and evidence

Implementation uses one MCP package and the existing approval, configuration,
JSON-RPC, tool dispatch, and secret-store boundaries. The official client SDK is
pinned to 2.3.1; SDK pagination is already bounded (64 pages), avoiding a second
pagination implementation. Catalog admission additionally bounds tool count and
serialized descriptors and rejects duplicate identities/invalid schemas atomically.

The scoped credential view separates user aliases from OAuth records. Malformed
records are classified as auth-required without exposing their contents. OAuth
identity includes endpoint, configured client authentication, metadata URL, and
normalized scopes. One owner per server serializes mutations; logout cancels
listener setup as well as established login and drains admitted refresh before
clearing records. Resource redirects are rejected and OAuth fetches contain no
configured resource headers. Client disconnect cancels its explicit sign-in;
server-owned tool approvals remain pending independently of client lifetime.

Three independent read-only review lenses covered correctness, architecture and
simplicity, and evidence/scope. Material findings were resolved and rechecked:
own-property permission lookups, safe credential-backend diagnostics, bearer
snapshot behavior, recovery from invalid stored OAuth client records, and
server-specific client sign-in cleanup. MCP validates configuration before generic
RPC JSON normalization; dictionary keys named `__proto__` are rejected explicitly
instead of silently discarded. Other prototype-named keys remain usable.

Observed qualification on macOS, 2026-10-10:

- Real SDK stdio and HTTP fixtures execute through public service direct/code
  calls, preserve JSON Schema, text/structured/error results, and reject invalid
  arguments/unsupported blocks. Paginated discovery, duplicate names, invalid
  schemas, unavailable-server isolation, cancellation, uncertain connection loss
  without replay, and scoped child allowlists are exercised.
- OAuth fixtures cover DCR, supplied Client ID Metadata Documents,
  pre-registered clients, unavailable-registration guidance, PKCE and resource
  binding, real loopback and pasted callbacks, wrong state, cancellation,
  expiry, restart persistence, changed auth identity, refresh, and logout races.
  Resource-header separation and redirect refusal are verified.
- Real RPC covers global-only settings, restart indication, write-only credential
  storage, namespace isolation, Test without tool calls/catalog replacement,
  and initiating-session auth authority/disconnect cleanup. Shared approval tests
  cover zero-client expiry plus existing multi-client/racing/reattach behavior.
  Native Ask human and auto-review bypass regressions pass.
- Rendered Ink controls cover configuration save, masked credential entry,
  pasted OAuth completion, and cancellation on leave/refresh while another server
  is signing in.
  Chromium exercises the production MCP editor for both transports and the
  production settings route for shared Ask human/timeout changes; existing
  conversation/composer checks run alongside them. All three affected browser
  scenarios pass. The latest full browser run has 12 passes and one unchanged
  conversation-canvas geometry failure; that case passes in a focused run, but
  its intermittent timing cause remains unisolated. No assertion was changed.
- Desktop web build, native macOS release compilation, and portable server
  bundling pass. The actual bundled
  NDJSON server is exercised with real external stdio/HTTP/OAuth fixtures,
  explicit sign-in, persisted credentials across server restart, redaction, Test
  without execution, and termination of all observed stdio child processes.
  The bundle qualification substitutes only `os.homedir` at the test boundary
  to keep the existing file backend away from the user's credentials.

Final `npm run check` passes typecheck, lint, and formatting. Vitest reports
127 passing files, two failing files, and 12 skipped files: 1,157 passing tests,
three failures, and 61 skips. The failures are the two unchanged CLI host setup
cases described below and the unchanged QuickJS computation test. All affected
MCP, approval, configuration, server, and client tests pass. The focused final
MCP/OAuth/RPC/TUI run passes 26 tests; approval and wider integration regressions
also pass in the full run. Review is complete with no remaining material findings.

Earlier full-check failures were investigated: Homebrew's dynamically linked Node cannot be
copied as a standalone packaged runtime; that check passes with the official
standalone Node 26.9.0 archive. Parallel process tests exhausted host file watchers;
bounded-worker external retries pass. CLI host tests saw the user's unrelated
`~/.harness/settings.json` as project configuration under a temporary Harness
home; all four pass from an isolated project directory. An unchanged QuickJS
microtask computation test takes approximately 7.8 seconds on this host against
its existing 5-second test timeout. Its interpreter still returns the computation
limit error; evaluator/worker code is untouched. No assertions or timeouts were
weakened to mask these findings.

Native Windows WebView2/DPAPI, Linux stdio/keyring, and live third-party OAuth
sign-in are not qualified by macOS browser/fixture checks. No such platform or
live-credential qualification is claimed; native WebView interaction is not
covered by release compilation or Chromium controls. Configuration remains startup-only;
legacy SSE, resources/prompts, automatic replay, and asynchronous approval remain
outside the requested scope.
