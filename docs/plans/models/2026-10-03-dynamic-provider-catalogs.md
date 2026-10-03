# Named provider instances and dynamic LiteLLM catalogs

Status: Active — implementation underway on 2026-10-03. The user authorized
autonomous implementation and local commits, with two feature increments followed
by related cleanup. No push or publication is authorized.

### Expanded implementation scope

Named instances apply to OpenAI API, Anthropic API, OpenCode Go, Codex OAuth,
compatible custom providers, and LiteLLM. Existing built-in IDs are implicit
default instances; their legacy credential slots remain unchanged. Additional
instances use `provider-instance:<instance ID>:<slot>` in the existing machine
secret backend. API keys use `api-key`; OAuth sessions use `oauth`. OAuth sessions
retain the complete provider-owned token record, with independent caches and
refreshes. Labels never affect identity or credential storage.

Each provider type synchronously validates configuration and constructs a
connection owning its auth method and asynchronous `buildProvider()`. The host
provides scoped opaque secret slots. This replaces the earlier API-key descriptor
proposal below and supports arbitrary provider-owned authentication without
central inference from provider configuration. Every config is parsed before
credential access; ordinary plugin contributions and the runtime stay synchronous.
Built-in IDs may be customized only with their existing provider type. Logging
into an additional named instance never changes the selected global model.

Feature increment one establishes named instances and auth isolation. Feature
increment two adds LiteLLM discovery, adapters, diagnostics and client integration.
The cleanup increment removes superseded configuration ownership and simplifies
boundaries exposed by implementation and independent review. Each increment is
committed only after its relevant checks pass; final completion requires the full
validation and qualification checklist below.

## Outcome and scope

One installed LiteLLM plugin supplies a provider type. Global configuration may
create several stable named connections, even to the same URL with different
keys. Each connection discovers its advertised models at server boot, owns one
in-memory catalog, and invokes the existing Responses, Chat Completions, or
Messages adapter. Saved selections retain `{provider, model, preset?}`.

Complete when two independently keyed instances work through the shipped
server/client boundary, discovery failures are visible without replacing saved
selections, all three transport continuations preserve their supported fidelity,
and legacy custom-provider configuration still works with the same identities.

This is remote model discovery and local provider construction. Installing code
from an index, loading model weights, plugin dependency resolution, periodic
polling, a disk catalog cache, live configuration reload, general model routing,
and manual catalog refresh are outside V1. Connection edits and key rotation
take effect on explicit server restart, matching existing auth behavior.

The [research note](../../research/2026-10-03-dynamic-provider-catalogs.md) records
the GitHub baseline, primary sources, alternatives, and unqualified boundaries.
The proposal supplied in chat gets the principal identities and adapter reuse
right. This plan additionally specifies bootstrap contribution timing,
validation ownership, conflicting deployment metadata, failure classification,
credential management, and reasoning affinity.

## Design

### Identities and configuration

| Identity             | Example            | Owner                                         |
| -------------------- | ------------------ | --------------------------------------------- |
| Plugin ID            | `litellm`          | One code contribution registered once         |
| Provider type        | `litellm`          | Factory, schema, discovery and interpretation |
| Provider instance ID | `work`             | Stable key in global `providers`              |
| Display label        | `Work gateway`     | Editable presentation                         |
| Model ID             | `coding`           | Public gateway alias, sent unchanged          |
| Transport            | `openai-responses` | Instance-local adapter and request controls   |

The plugin ID and its provider type may share a name but are different namespaces.
Instances do not become separate configuration-owning plugins. Changing a label
preserves conversation selections and secret keys; changing an instance ID is an
explicit identity change. Equal URLs never merge instances.

Proposed global configuration, not currently supported syntax:

```json
{
  "providers": {
    "work": {
      "type": "litellm",
      "label": "Work gateway",
      "config": {
        "baseUrl": "https://llm.example.com/team",
        "apiKey": { "env": "LITELLM_WORK_KEY" },
        "defaultTransport": "openai-completions",
        "models": {
          "coding": {
            "transport": "openai-responses",
            "fileTools": "apply_patch"
          },
          "claude": {
            "transport": "anthropic-messages",
            "requestMaxOutputTokens": 8192,
            "fileTools": "text_editor"
          }
        }
      }
    },
    "personal": {
      "type": "litellm",
      "label": "Personal gateway",
      "config": {
        "baseUrl": "https://llm.example.com/team",
        "apiKey": { "stored": true }
      }
    }
  },
  "model": { "provider": "work", "model": "coding" }
}
```

`providers` is machine-global, like today's `customProviders`. The generic
settings schema validates a strict `{type, label?, config}` envelope with
nonempty IDs and JSON configuration values. Each contributing type validates its
own config. Reject instances in project/shared/local settings, profiles, and
durable/programmatic conversation overrides. Model references to these instances
remain valid in those layers.

LiteLLM config owns `baseUrl`, credential source, transport defaults, and exact
model overrides. `models` is optional; entries both override discovery and add
unadvertised aliases. Field precedence is transport defaults, consistent remote
metadata, then explicit model fields. An explicitly configured empty preset map
clears remote presets rather than retaining them via recursive merge.

### Bootstrap extension, not a new runtime registry

Add provider-type contributions to the pre-construction `PluginEntry` contract,
available on both plain `Plugin` and `PluginDefinition`. A shared contribution
interface avoids requiring a conversation `ConfigReader` to discover bootstrap
factories. Collect definitions before `HarnessService` creates runtime plugins.
Retain `providers()` for already constructed providers.

A provider type has a globally unique type name, a Zod configuration schema, and
an instance construction function. It may also expose a synchronous
`credentialSource(config)` descriptor: an API-key source (`env` or `stored`), or
no managed credential. The type interprets its own validated config; generic
auth/status code never reads an assumed `config.apiKey` field. Legacy inline
credentials remain private to their factory and have no managed-key action.
A typed registration helper infers config from the schema and erases it at the
host boundary. Parse every instance once, before
any network work, retaining source paths in errors. The factory receives the
validated config plus an instance-bound context supplying its ID, cancellation,
credential resolver, and safe diagnostics. Protocol types do not import secrets,
auth, config, SDKs, or server implementations.

The shared server builds configured instances, then contributes all successfully
constructed providers through one plain composition plugin with an internal ID.
`PluginHost` continues to consume ordinary providers synchronously; it does not
initialize factories, refresh models, or gain a service locator. The internal
composition plugin ID must be unique independently of instance IDs.

Reject unknown types, duplicate contributed types, duplicate instance IDs across
legacy/new configuration, and collisions with ready-made or reserved built-in
provider IDs. Reserve built-in IDs even while signed out, so signing in cannot
change the meaning of an existing custom connection. Validate all statically
known IDs before discovery I/O. A `PluginDefinition` can contribute providers
only after `create(reader)` runs; retain the final fail-fast collision check in
`PluginHost` for those deferred contributions, with startup cleanup on failure.
Do not add duplicate provider-ID declarations solely to move this check earlier.
Assert factory output has the requested provider ID and catalog entries use that
ID with unique model IDs.

Add optional `ModelProvider.refreshModels(signal)` for the concrete boot
consumer. It returns a small safe result distinguishing a complete catalog from
degraded metadata and identifying warnings; expected index failures use a typed
discovery error. Static providers omit it. `listModels()` remains synchronous
and performs no I/O. The provider owns its snapshot; the server retains only
construction/discovery summaries and provider references, not another catalog.

### Credentials and named-instance management

LiteLLM accepts an explicit environment source or `{stored: true}`. Environment
references resolve on the server host; a missing variable does not fall through
to another key. Stored keys use `apikey:provider-instance:<instanceId>` within the
existing secure store. Display labels are never part of that key. These are
gateway keys, independent of built-in OpenAI/Anthropic credentials.

Reuse `ApiKeyAuth`/secure-store facilities for storing and deleting an instance
key. Its current `getKey()` deliberately falls back from environment to storage
for built-ins; add an explicit source-exact path for configured instances rather
than inheriting that fallback or supplying a fake environment variable. Build
configured auth/status entries from the type-owned credential descriptor, bound
to the instance's storage namespace. Extend the composition-owned auth lookup and public application RPCs to
recognize configured instances. An instance login stores its key and returns
restart-required without inventing a default model before discovery or changing
an existing model selection. Existing built-in login defaults remain intact.
An environment-managed connection explains its source and does not offer a
stored-key action that would have no effect.

Configuration remains file-authored in V1. CLI/desktop can inspect connections
and manage stored keys; a schema-driven connection-creation editor is separate
work. Never return raw config, resolved keys, deployment metadata, request
bodies, or remote error bodies through settings/status RPCs.

### Shared adapters and one resolved model entry

`@harness/litellm` depends on existing adapter implementation packages. It can
reuse API-key SDK construction helpers, as OpenCode Go does today. It never
borrows registered `openai`/`anthropic` providers or invokes `ModelInvoker` from
inside an adapter call. Every stream goes through the existing middleware once.

One immutable resolved entry per model contains catalog fields, capabilities,
transport, and typed request/preset controls. `listModels`, `capabilities`,
`validateConfig`, and `stream` all resolve that entry. Inner adapters use the
instance ID and public alias for all payloads, including replay filtering.

Use the existing protected request hooks for gateway profiles. Add narrow typed
core options only where these hooks cannot express neutral behavior; do not make
a generalized transport-plugin registry or rewrite stream/request mapping.
Responses must omit direct-provider reasoning defaults when no controls are
declared and request encrypted reasoning only for an explicitly supported
profile. Messages must use a gateway request cap independently of the compiled
Claude roster and must not infer thinking/effort from a coincidentally matching
alias. Preserve direct-provider construction defaults and Codex field omissions.

Transport precedence is explicit model `transport`, a recognized and consistent
`model_info.harness.transport` annotation, then instance `defaultTransport`
(default `openai-completions`). Use a versioned, plugin-validated
`model_info.harness` annotation with the same model-field schema for remote
controls. V1 does not guess native protocols from vendor names, aliases, or a
single `supports_reasoning` flag. This deliberate policy makes bare indexes
usable while allowing richer gateways to configure routes automatically.

Unknown file-tool dialect defaults to `string_replace`. `apply_patch` requires
Responses plus an explicit or validated remote dialect declaration; Chat and
Messages reject it. Native API format alone does not imply training or gateway
support for freeform tools. Presets exist only when defined in the chosen
profile/configuration; omission leaves the gateway's generation defaults.

Before network I/O, check matching saved provider/model payloads against the
resolved transport's replay contract. A Responses ciphertext payload or Messages
thinking signature must not be silently dropped because metadata loss or changed
annotations chose another transport. If the current route/profile cannot replay
it, fail with a safe transport-mismatch diagnostic directing the user to restore
the original explicit route, choose another identity, or start a new conversation.
Payloads from another provider/model continue to follow the existing canonical
fallback rule. This request-time check needs no persisted catalog or generation
counter, and protects saved history across restarts and enrichment outages.

`baseUrl` is the gateway root, including any reverse-proxy prefix. Append paths
without losing that prefix: OpenAI SDK base `<root>/v1`, Anthropic SDK base
`<root>`, index `<root>/v1/models`, metadata `<root>/model/info`. Validate URL
shape, reject embedded credentials/query/fragment, and test trailing slashes and
prefixes through real SDK HTTP requests. V1 has no arbitrary metadata-supplied
endpoint or hidden retry through another generation protocol.

### Discovery and catalog publication

1. Fetch `/v1/models` with this instance's credential and cancellation signal.
   Parse public IDs; accept additive fields; reject malformed roster envelopes.
2. Fetch optional `/model/info` with the same credential and the remaining
   budget. Accept the documented array and single-object envelopes. It enriches
   only exact advertised names or explicit configured entries.
3. Group deployment metadata by public alias. Keep a field only when all rows
   agree and have valid values. Retain the distinction between absent metadata
   and contradictory or positively unsupported candidates. Do not pick a
   deployment UUID as the model ID or infer team aliases.
4. Apply explicit model overrides. Validate the final entry, including capacity,
   preset, transport, and file-tool compatibility, before publication.
5. Replace the entire provider snapshot in one assignment. Return fresh catalog
   objects so clients of `listModels` cannot mutate dispatch/capability state.

Known non-generation modes (embedding, image, speech, rerank, etc.) are excluded
from the coding-model catalog. If any candidate for an alias has a known
non-generation mode or denies required tools, exclude the alias rather than
discarding that evidence and applying generic defaults. Contradictory mode/tool
metadata requires explicit local configuration asserting a qualified gateway
profile before that alias is selectable. Conflicting optional controls can stay
unknown only when all candidates meet the coding profile's baseline. Bare IDs
with genuinely absent metadata use the generic text/function-tool compatibility
profile, an integration assumption to qualify rather than a discovery proof.

Only declared combined `contextWindow` values become Harness context limits.
Do not map a generic `max_tokens` or sum input/output maxima. Positive
`max_output_tokens` can supply hard output capacity when uniform across rows.
Messages' required request cap is explicit model/instance configuration, else a
documented 8,192 request default; constrain that default to a known smaller hard
output maximum. Request caps are not hard catalog claims. Per-invocation caps
take precedence, and thinking budgets must fit the effective request cap.

Keep pricing unknown unless explicit local config or the validated Harness
annotation supplies a complete USD-per-million-token card. V1 does not convert
LiteLLM's mapped upstream rates into a claim about gateway billing. Sparse
metadata still provides selectable IDs, but unknown capacity means the existing
proactive compaction policy cannot establish a limit. State this consequence in
setup and status guidance.

Failed mandatory discovery preserves the previous snapshot; first boot preserves
explicitly configured models. Successful discovery replaces prior remote
entries, including when the remote roster is legitimately empty. Enrichment
failure publishes the new ID roster with generic defaults and explicit entries,
without retaining stale remote capabilities. A remote-invalid model annotation
is diagnosed and omitted; unaffected models remain. Invalid explicit
configuration fails startup instead of being downgraded to a remote warning.
Degraded discovery is not authority to reinterpret a matching saved fidelity
payload: the replay check above still applies before a resumed generation.

### Startup, failure classification, and presentation

Validate schemas and identities first; resolve credentials and construct
providers; refresh dynamic providers; then create the service and start RPC.
Providers with missing/unavailable credentials are not replaced with fake inert
providers. Their configured descriptors remain visible in application status.
Providers with a discovery failure still exist if construction succeeded and can
serve explicit models. Registration/catalog defects fail fast.

Use at most four concurrent instance operations, one 10-second discovery budget
for boot as a whole, and a 3-second maximum for optional enrichment within that
budget. Pending/active discovery is aborted when the boot budget expires. Do
not hide SDK retries within discovery; the first retry trigger is an explicit
restart. Wire process/connection startup cancellation into discovery, drain
pending fetches, and release the store lock on cancellation or startup failure.
Do not increase client connection timeouts to conceal slow startup.

Use bounded HTTP reads (2 MiB per endpoint), at most 5,000 metadata rows and
models per instance, and model IDs at most 512 characters. Limit the aggregate
serialized model result to 3 MiB, below the existing 4 MiB RPC frame maximum;
fail with a specific catalog-size diagnostic rather than truncating a successful
roster or disconnecting later. Verify configured/static models also respect
this aggregate boundary. Document bounds as V1 integration limits.

Only classified external conditions become degraded/failed status: missing or
locked credentials, authentication denial, unavailable metadata routes, transport
failure, deadline, malformed remote data, and response limits. Catch these
specifically. Unknown exceptions, unknown types, invalid local schemas, bad
factory identities, and impossible states propagate. Log sanitized event code,
instance ID, phase, HTTP status where known, and counts; exclude response bodies,
keys, raw URLs with credentials, and SDK error strings.

Expose a sanitized composition-owned provider-status RPC alongside the existing
`app.settings.get`/`app.auth.*` API; consume it through the public client feature
boundary in both shipped clients. Report instance ID, label, type, credential
presence/source, registration, catalog outcome, safe diagnostics, and model
count. Credential presence is not remote authentication proof. Distinguish:

- Ready, including a successful empty remote roster.
- Degraded metadata or a failed index with explicit models available.
- Discovery failed with no selectable models.
- Missing or inaccessible credentials.

Preserve unavailable saved selections in client controls and explain the actual
status. Never switch the global default or saved conversation to demo/another
provider because a configured connection failed. Existing demo defaults when no
selection was configured remain unchanged. CLI must stop deriving sign-in from
model rows; desktop must show configured instances and their labels.

### Legacy custom providers

Move the compatible-provider schemas/types from `@harness/config` into a
browser-safe entry in `@harness/custom-providers`. Register its three existing
compatible variants as provider types, preserving model-scoped validation.
Generic config must not import that provider package back, creating a cycle.

Continue accepting legacy `customProviders` as a global JSON envelope. Normalize
each entry at bootstrap to `{type, config}` and validate through the same
registered type schema, preserving the entry key as provider ID. This is an
in-memory compatibility bridge; no settings rewrite is needed. Existing inline
keys remain supported for those compatible types. New LiteLLM connections use
references. Generic settings writes preserve opaque provider config; production
bootstrap and any provider-edit RPC validate the owning type before use/write.

Unknown legacy fields/types now fail at the provider validation boundary with
the same source path rather than disappearing. Do not register duplicate
legacy/new IDs or reuse a user's instance ID as a plugin ID. Existing
custom-provider integration tests must continue through the new bridge.

## Delivery milestones and completion checks

- [x] Grounded design and primary-source audit.
  - GitHub/local baseline and current contracts inspected; evidence recorded.
  - Three independent read-only reviews completed; resulting corrections and
    planning validation are recorded below.
- [ ] Instance envelope and bootstrap factory contribution.
  - Depends on the design audit. Add shared pre-construction contributions,
    typed schema registration, scoped credential access, and server composition.
  - Move compatible schemas/types and add the legacy normalization bridge.
  - Complete when a test-only type can be added without editing config unions;
    configured/reserved/already available ID collisions and invalid
    global/local/override configs fail before I/O; deferred provider collisions
    fail at final registration; old identities and model-specific validation
    are preserved.
- [ ] Gateway profiles and LiteLLM discovery.
  - Depends on factory/credential construction. Add `@harness/litellm`, all three
    routes, explicit request controls, bounded parsing, and atomic snapshots.
  - Complete when real local HTTP fixtures exercise pinned SDKs with aliases,
    path prefixes, tool continuations, usage, cancellation, and sparse/conflicting
    metadata, while direct-provider request tests retain their existing behavior.
- [ ] Shipped bootstrap, diagnostics, and credential UX.
  - Depends on the previous two milestones. Wire boot budgets/cancellation,
    sanitized status RPCs, instance key management, CLI messages, desktop
    connection rows, and labeled model choices. Connection authoring stays in
    the global file; key/status controls go through JSON-RPC.
  - Complete when two keys for the same URL produce isolated catalogs/requests;
    offline startup stays usable with accurate diagnostics; key rotation needs
    restart; saved selections/presets never migrate implicitly; no secrets leak.
    Require CLI presentation regressions and an actual Windows Tauri native
    scenario using a controlled gateway HTTP edge for named labels/status,
    isolated stored keys, set/delete/restart, unavailable saved selections, and
    no implicit default model change. JSON-RPC fixtures alone do not close this
    runtime/interaction acceptance check.
- [ ] Live qualification, review, and documentation.
  - Depends on integrated shipped behavior. Run opted-in real gateway scenarios,
    full `npm run check`, `npm run test:native`, and independent
    correctness/architecture/testing review. Record unavailable platform or
    credential checks as still open; the full local check does not include native
    qualification.
  - Update models/kernel/interface architecture, root status, testing guidance,
    and the research note with the actual supported LiteLLM version and results.
  - Complete only after the required live gateway fidelity checks and shipped
    Windows runtime check pass with recorded results. Missing credentials or
    platform access leaves this milestone and delivery status open. Fixture HTTP
    success cannot close the real gateway fidelity checks.

## Required verification

| Boundary                | Scenarios and observable result                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration/factories | Strict type-owned schemas; instances rejected outside global settings; known IDs checked before I/O and deferred providers at registration; legacy/new ID equivalence; labels independent of identity; factory output mismatch fails                                                              |
| Credentials             | Two keys at one URL; exact env references with no fallback; stored key isolation; set/delete/restart through public RPC; source guidance; no implicit default model selection                                                                                                                     |
| Discovery               | Bare/additive index fields; duplicate IDs; legitimate empty list; denied/missing/malformed enrichment; array/object metadata; mixed chat/embedding and tool/non-tool aliases excluded; hidden explicit aliases; unsupported modes; row/byte/time budgets                                          |
| Snapshot semantics      | Successful replacement removes old remote rows; mandatory failure preserves snapshot; degraded enrichment does not retain stale remote controls; returned arrays cannot mutate canonical entries                                                                                                  |
| Adapter HTTP            | Exact gateway alias and auth on all routes; prefixed URLs; neutral unknown-model defaults; file-tool/preset validation; request versus hard capacity; two-turn tool/result and reasoning replay; restart plus lost metadata rejects incompatible saved payloads before generation; nullable usage |
| Server/client           | Real composition over JSON-RPC; bounded/offline boot; cancellation drains and releases SQLite; labeled instances with zero models; unavailable saved choices preserved; catalog frame bound checked                                                                                               |
| Shipped client runtime  | CLI status/model-picker regressions; actual Windows Tauri with a controlled HTTP gateway, named labels/status, isolated stored keys, set/delete/restart, preserved unavailable selections, and no implicit default-model change                                                                   |
| Real LiteLLM            | Record gateway version/config; restricted virtual keys with distinct visibility; all three supported routes; real tool-result continuation; Responses ciphertext and Messages signature replay; required affinity across supported load-balanced origins                                          |
| Existing behavior       | Direct API/Codex/OpenCode Go/custom providers; model-scoped presets; auto-approval/compaction/subagent invocation boundary; cancellation/accounting and durable payload identities                                                                                                                |

Prefer controllable HTTP servers with real SDK serialization to private protected
method assertions for new integration behavior. Keep pure parser/preset tests
where they establish exact normalization. Tests wait for requests/completion or
cancellation, never incidental sleeps. Real generations are credential-gated
and explicitly initiated; no paid endpoint probes during routine boot or CI.

## Review, status, and later work

Three independent read-only reviews covered correctness, architecture and
simplicity, and evidence/testing/documentation. All six P2 findings were accepted:
distinguish unsupported metadata from absent fields; reject incompatible saved
payload replay; expose type-owned credential descriptors with exact-source
resolution; narrow pre-I/O collision guarantees; keep required live qualification
open until passed; and require shipped Windows runtime/CLI evidence.

Planning validation: all three reviewers confirmed their findings resolved in
follow-up review, with no remaining consequential gap. Prettier checks and
`git diff --check` passed; all 32 relative Markdown links in the four changed
documents resolve. Formatting used the existing primary-checkout Prettier
installation because this worktree has no installed dependencies. This
documentation-only change did not run `npm run check` or native/provider tests.
Feature increment one committed as `8a886a6`: named built-in API/OAuth instances,
type-owned schema/auth construction and scoped storage. All TypeScript projects,
changed-code lint and 77 focused regressions passed. Independent implementation
review found an OAuth initial-read/logout race, unbounded refresh draining, an
environment-only CLI dead end, overbroad credential classification and login
validation ordering. These findings are accepted and being fixed with regressions.
The foundation review findings are fixed with regression evidence. Public named-key
RPC login/logout/restart and all three real-SDK HTTP continuation fixtures pass.
The second increment adds LiteLLM, bounded boot discovery, status RPCs, and client
credential/catalog presentation. Follow-up findings were accepted and fixed:
neutral Responses controls, request defaults separate from hard capacities,
nullable unknown metadata, conflicting output capacities, qualified unsupported
overrides, hidden-alias enrichment, local preset replacement, catalog identity
assertions, and abort/drain before releasing bootstrap resources. Forty-three
focused regressions and the full `npm run check` pass after these fixes (872 tests
passed, 30 environment-gated tests skipped). The CLI plugin fixture now uses an
isolated home; the full check had exposed its dependency on real user settings.
The legacy bridge and native/real-gateway qualification remain in progress.
Local commits are authorized; push/publication are not.

After V1, an explicit refresh action can reuse `refreshModels`, but its delivery
must include catalog replacement in clients and a captured model description for
in-flight requests, capabilities, context capacity, and pricing. Boot-only V1
needs no generation counters, concurrent refresh coordination, catalog events,
or persistent caches. Revisit a transport-factory registry only with an actual
independently installed transport implementation.
