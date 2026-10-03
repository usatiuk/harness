# Named provider instances and dynamic LiteLLM catalogs

Status: Active — implementation and available qualification are verified. Actual vendor
cryptographic qualification remains open because no gateway/upstream credentials
are available. The user authorized autonomous implementation and local commits
in two feature increments followed by related cleanup. No push is authorized.

## Outcome

Every built-in API/OAuth and compatible provider supports stable named connections
with independent credentials. One LiteLLM plugin supplies a configurable type;
any number of connections can use the same gateway with different virtual keys.
Each connection owns its catalog, discovered once at boot. Saved selections
remain `{provider, model, preset?}`, with the instance ID in `provider`.
Labels are editable and never change identity or credential storage.

Periodic/manual refresh, plugin hot reload, model weights, code from a remote
index, disk catalog caches, automatic fallback/routing, and generic plugin
dependency ordering are outside V1. Connection/key edits take effect on explicit
server restart. Existing saved unavailable selections are never silently replaced.

The [research note](../../research/2026-10-03-dynamic-provider-catalogs.md) records
the GitHub baseline, primary sources, rejected alternatives and qualification
boundaries. Current contracts live in the [models subsystem](../../subsystems/models/README.md)
and [interface subsystem](../../subsystems/interface/README.md).

## Accepted implementation

### Construction and configuration

`Plugin` and `PluginDefinition.providerTypes()` contribute type factories before
async server bootstrap. Existing ready-made `providers()` contributions remain
valid. The host validates the machine-global instance envelope; each selected
type parses its own strict config synchronously before credential or network I/O.
`prepare(config)` constructs an instance from an ID, label and scoped opaque
secret access. The instance owns its auth method and async `buildProvider()`.
There is no async general PluginHost lifecycle or second invocation registry.

Types are `openai-api`, `anthropic-api`, `opencode-go`, `openai-codex`,
`litellm`, `openai-responses-compatible`,
`openai-completions-compatible` and `anthropic-compatible`.
Existing built-in IDs are implicit default instances with legacy credential slots.
Additional named sign-ins do not alter global model selection. Legacy global
`customProviders` entries normalize into the same instance map with their IDs
preserved; collisions fail before I/O. Compatible schemas belong to their plugin,
not a central config union. Project/profile/conversation layers reject providers.

### Credentials and lifetime

Additional secrets use
`provider-instance:<encodeURIComponent(id)>:<encodeURIComponent(slot)>`.
Providers own record formats; API keys use `api-key`, OAuth uses `oauth`.
API sources select stored credentials, one exact environment reference, or
explicit environment precedence over storage. Environment-only connections
cannot accept/delete stored keys. Compatible providers retain literal keys for
legacy/local keyless endpoints. Windows uses the existing DPAPI backend.

Codex instances own independent sessions, caches and coalesced refreshes.
Interactive sign-in excludes newly admitted refreshes, and sign-in/logout drain
an already admitted rotation before replacing/deleting the session. A controlled
browser-callback regression proves an old account cannot overwrite the new one.
No real multi-account browser login was performed.

### LiteLLM catalog and metadata

`GET /v1/models` supplies exact public aliases; optional `GET /model/info` enriches
advertised and explicitly configured hidden aliases with the same instance key.
Internal deployment IDs/vendor model names never replace public aliases.
Configured exact entries override discovered profiles. Qualified
`model_info.harness` version-one annotations accept the local profile fields.

Deployment claims must be complete and consistent to describe a routing alias.
Sparse/unknown fields remain unknown. Invalid/conflicting metadata is diagnostic,
not an empty successful catalog. Input/output bounds are separate; legacy
`max_tokens` is not a combined context claim. Combined context, separate limits,
reasoning support, adaptive/legacy/always-on thinking, effort levels/defaults and
explicit gateway rate cards survive the public wire/domain boundary. Metadata
alone does not invent controls/presets or encrypted-reasoning requests; explicit
profiles define request behavior. Upstream price estimates are not gateway billing.

Positive non-chat or unsupported-tool claims exclude the alias unless explicitly
qualified with `codingCompatible: true`. A label alone cannot override exclusion.
Local presets replace remote presets; a missing/conflicting preset table cannot
leave an invalid default behind. Successful refresh constructs a complete new
snapshot before publication. Failure preserves configured/prior entries; lost
enrichment drops stale controls. One resolved entry drives listing, capabilities,
validation and streaming.

### Adapters and failure handling

Transport selection is explicit local config, agreed Harness annotation, then
instance default (Chat Completions). Alias/vendor heuristics and paid endpoint
probes are not used. Shared OpenAI/Anthropic packages construct connection-specific
adapters with gateway credentials, never the user's direct-provider login.
Messages has a bounded advisory default; other routes send no invented output cap.
Hard capacity and advisory request limits remain distinct.

All inner streams carry outer instance/public-alias identity. The existing model
middleware runs once. Responses uses `store: false`; opaque item payloads remain
Harness history. Saved Responses/Messages fidelity must match its original route,
version and enabled Messages thinking profile before a request is sent.

Bootstrap uses four discovery workers, a ten-second total network budget and a
three-second enrichment budget. Response limits are 2 MiB/5,000 rows, aliases at
most 512 characters, resolved catalogs at most 5,000 models per LiteLLM instance.
The actual projected aggregate wire catalog has a 3 MiB budget below the frame
limit. Credential/discovery external failures remain per-instance diagnostics;
unknown packaged defects propagate. Redirects are not followed with credentials.
Cancellation aborts/drains owned operations before SQLite/credential lifetime
ends. Only actual abort errors are classified as timeouts.

### Clients

Server-owned `app.providers.list` and settings expose type, label, safe auth/source
status, registration, discovery state, model count and bounded diagnostics.
CLI/desktop login and logout address the instance ID. Clients show provider labels
and known model limits/reasoning metadata, preserve saved unavailable selections,
and request restart after credential edits. Secrets never enter RPC catalogs.

## Milestones and completion checks

- [x] Ground repository/GitHub behavior and primary LiteLLM sources; record bounded design.
- [x] Implement instance/type/auth foundation and built-in API/OAuth isolation.
      Check: named keys, legacy IDs, exact env sources, validation before I/O,
      independent OAuth cache/rotation and secret namespace regression pass.
- [x] Implement LiteLLM catalogs, all three routes and boot diagnostics.
      Depends on foundation. Check: real SDK HTTP/SSE tests cover aliases,
      prefixes, tool continuations, opaque reasoning, usage and cancellation.
- [x] Integrate public client key/status/catalog behavior.
      Depends on bootstrap. Check: RPC login/logout/restart preserves selection,
      secret isolation and metadata; actual Windows key/restart/unavailable
      conversation flows pass.
- [x] Simplify legacy config/type ownership and remove duplicate provider builds.
      Check: compatible schemas validate real settings through plugin ownership;
      legacy IDs remain unchanged; no second auth-owned construction path remains.
- [x] Independently review behavior, architecture/simplicity and evidence.
      Check: three read-only reviewers; consequential findings fixed and verified.
- [x] Qualify official LiteLLM v1.103.2 with controlled upstreams.
      Check: real virtual-key restrictions, forbidden invocation, all three native
      routes, both Responses origins, shared-alias affinity and synthetic
      Messages-signature replay pass.
- [x] Finish post-review full `npm run check`, native metadata rerun and final diff.
      Check: 886 tests passed / 31 skipped, all 12 native tests passed, formatting
      and diff checks passed. Docker fixture resources were confirmed removed.
- [ ] Qualify actual vendor-encrypted reasoning/signature continuations through a
      credentialed gateway. Requires unavailable real upstream access; synthetic
      payloads, source inspection and a compile do not complete this check.

## Delivery and evidence

1. `8a886a6 Add named provider instances with isolated authentication`.
2. `417a477 Add LiteLLM catalogs and provider instance status`.
3. Cleanup increment, `Unify provider construction and preserve catalog metadata`:
   plugin-owned compatible schemas,
   single provider construction, namespace/auth/failure fixes, complete catalog
   metadata, real gateway/native qualification and documentation reconciliation.

The second increment passed full `npm run check`: 872 tests, 30 skipped. Final
post-review `npm run check` passed TypeScript, ESLint, Prettier and **886 tests /
31 skipped**. Focused metadata RPC/client tests passed 44 tests; independent review
reran three provider files / 28 tests. The final packaged Windows suite passed
**12 tests**, including visible metadata and existing unavailable conversations.

The final native run initially exposed an incorrect test prerequisite: credential
presence was already true before restart, so logout could be submitted on the old
page. The test now waits for a populated ready boot catalog, the actual restart
result. Both affected auth scenarios and then all 12 native tests passed. No
timeouts, retries or assertions were weakened. A final lint failure in the OAuth
fixture was corrected by requiring its actual URLSearchParams form body.

Real Docker qualification passed against
`ghcr.io/berriai/litellm:v1.103.2@sha256:f63fb81b831b170ec16851e23c36ac5bf52ef106b271406429524a2ed730bbfd`,
with isolated Postgres, fake upstream keys and synthetic ciphertext/signatures.
Both forced upstream origins and a shared alias pass two actual gateway turns.
No vendor API generations or spend occurred. [Testing guidance](../../TESTING.md)
records the reproducible opt-in command and coverage boundary.
