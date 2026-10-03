# Dynamic provider catalogs and LiteLLM evidence

Research date: 2026-10-03. This is design evidence, not implemented behavior.

## Question and baseline

How should Harness load models from a gateway while supporting multiple named
connections, plugin-owned configuration, and the existing transport adapters?

GitHub `main` and this clean checkout both resolved to Harness commit
[`1f49b294`](https://github.com/usatiuk/harness/commit/1f49b2944ddaa6551d393a518eed75912e5ffe37).
GitHub was inspected with `gh`; no remote changes were made. LiteLLM source was
inspected at
[`4ece6c9f`](https://github.com/BerriAI/litellm/tree/4ece6c9fb8186e8a70df2c3cd5807d246b55a415).
Its moving documentation was read on the research date. Source on `main` is not
proof that an older deployed gateway supports every examined field.

## Harness findings

- [`ModelConfig` and `ModelProvider`](../../packages/protocol/src/model.ts)
  already separate provider/model identity from implementation. A provider ID
  can identify a named connection. There is no need to persist another instance
  field or change the engine invocation path.
- [`OpenCodeGoProvider`](../../packages/opencode-go/src/provider.ts) already
  delegates to Responses, Chat Completions, and Messages with one outer identity
  and gateway credentials. Its model dispatch and presets use a compiled roster.
- [`ProviderRegistry`](../../packages/core/src/registry.ts) asks providers for
  synchronous catalogs. It does not own another copy. Provider-owned snapshots
  fit this boundary.
- [`PluginDefinition`](../../packages/protocol/src/plugin.ts) is instantiated by
  [`HarnessService`](../../packages/service/src/service.ts) with a conversation
  configuration reader. The server cannot collect new bootstrap contributions
  only from runtime `Plugin` objects: some entries have not been created yet.
- [`settings.ts`](../../packages/config/src/settings.ts) centrally owns custom
  transport schemas and types. Moving those schemas into their owning provider
  package requires updating imports, settings tests, and legacy validation;
  adding an opaque envelope alone does not remove the existing central union.
- Project settings and profiles reject `customProviders`; programmatic overrides
  currently use the global settings schema and subsequently drop global-only
  fields. New provider instances must explicitly be rejected there as well.
- [`server/index.ts`](../../packages/server/src/index.ts) asynchronously builds
  built-in providers before service creation. Its broad provider-build catch
  predates this design. Copying that catch for new factories would also hide
  deterministic schema errors or packaged-program defects.
- Reusable protected adapter hooks already exist. Responses has direct-provider
  reasoning defaults and always requests encrypted reasoning. Messages resolves
  direct model controls by name and falls back to 8,192 output tokens for an
  unknown alias. Gateway construction must supply explicit request behavior,
  independently of the gateway alias.
- [`apiKeyCredentials`](../../packages/openai-api/src/index.ts) and the
  [Anthropic equivalent](../../packages/anthropic-api/src/index.ts) construct SDK
  clients without signing in. Existing OpenCode Go reuses those functions.
  Ordinary package dependencies suffice; runtime plugin lookup is unnecessary.
- [`ApiKeyAuth`](../../packages/auth/src/api-key.ts) already supports a custom
  storage key. New keys can be scoped to a provider instance without designing
  another secret store. Its `authenticated` status means credential presence,
  not successful remote verification.
- [`notifyModel`](../../packages/cli/src/index.tsx) derives registered providers
  from nonempty catalogs and reports absent entries as not signed in. Desktop
  [`app.settings.get`](../../packages/server/src/app-api.ts) only reports built-in
  authentication entries. Neither presently represents discovery failure.
- [`HarnessDomainClient.start`](../../packages/client/src/domain.ts) fetches the
  catalog once. Boot-only discovery works with this behavior. A future live
  refresh requires client replacement too.
- [`Engine.#contextCapacity`](../../packages/core/src/engine.ts) requires both
  context and hard output limits for proactive compaction. Sparse catalogs do
  not establish that protection. Unknown limits must stay unknown, with this
  limitation stated in setup/testing guidance.
- The current model wire catalog carries labels, presets, and context capacity;
  it does not expose internal pricing or hard output limits. A discovery feature
  does not itself require expanding those unrelated client fields.

## LiteLLM findings and consequences

### Listings and metadata

The pinned
[`model_list` implementation](https://github.com/BerriAI/litellm/blob/4ece6c9fb8186e8a70df2c3cd5807d246b55a415/litellm/proxy/proxy_server.py#L11563)
serves `/v1/models` and `/models`, uses caller access and alias information, and
returns public routing names. It documents that presentation-hidden models can
still be invoked directly. Newer indexes can contain additional limits; older
servers may return only IDs.

Use `/v1/models` as the roster and the same connection key for every discovery
request. Do not request expanded admin scope or promote metadata-only entries
into selectable models. Explicit configuration may add unadvertised aliases;
the gateway remains the invocation authorization boundary.

The pinned
[`model_info_v1` implementation](https://github.com/BerriAI/litellm/blob/4ece6c9fb8186e8a70df2c3cd5807d246b55a415/litellm/proxy/proxy_server.py#L16071)
serves both `/model/info` and `/v1/model/info`. It returns deployment rows and
enriches them with model data. It can return multiple rows for one public alias;
its single-model startup branch can return a `data` object instead of an array.
The [model management documentation](https://docs.litellm.ai/docs/proxy/model_management)
describes arbitrary `model_info` annotations. These are operator metadata,
not a standardized Harness transport/preset contract.

`/model/info` should be optional enrichment. Check the top-level envelope;
handle supported array and single-object forms; ignore unrelated fields. Retain
an ID roster if enrichment is absent, denied, malformed, or exceeds its budget.
Never expose raw deployment metadata or use it to replace connection credentials
or destinations. Join by exact public name only; do not guess team alias mappings.

LiteLLM also exposes
[`/model_group/info`](https://github.com/BerriAI/litellm/blob/4ece6c9fb8186e8a70df2c3cd5807d246b55a415/litellm/proxy/proxy_server.py#L16374),
which explicitly targets end users and returns aggregate providers, mode,
capabilities, limits, and costs. This is a useful alternative to deployment
enrichment. It does not supply the same arbitrary deployment annotations, and
aggregate values alone do not prove uniform transport/payload compatibility.
V1 selects `/model/info` for the annotation/route contract and does not probe both
rich endpoints or build an endpoint-negotiation framework.

### Metadata does not settle model behavior

[LiteLLM's model info types](https://github.com/BerriAI/litellm/blob/4ece6c9fb8186e8a70df2c3cd5807d246b55a415/litellm/types/utils.py#L272)
contain distinct `max_tokens`, `max_input_tokens`, `max_output_tokens`, modes,
costs, and capability flags. A generic input maximum is not evidence for a
combined context window. Capability booleans do not define reasoning effort
values or file-editing dialects.

For a shared alias, arbitrary first-row selection is unsafe. Keep only
consistent optional metadata across its candidate rows. Distinguish missing
metadata from mixed or positively unsupported mode/tool candidates; the latter
must not turn into a permissive generic coding profile. Explicit local model
overrides can assert a separately qualified gateway contract. Do not infer
the model vendor from an arbitrary public alias, sum independent limits, or copy
direct-provider prices into a gateway catalog. Costs that are mapped from
upstream models are not proof of the gateway user's bill.

### Transport and reasoning continuity

The official [Messages endpoint documentation](https://docs.litellm.ai/docs/anthropic_unified)
shows the Anthropic SDK pointed at the gateway root with a gateway key and public
alias; the SDK calls `/v1/messages`. The endpoint can also translate to
non-Anthropic models. The [Responses documentation](https://docs.litellm.ai/docs/response_api)
shows native and translated routes. Upstream provider identity alone therefore
does not dictate the client transport or guarantee feature fidelity.

Choose transports from explicit model settings or a recognized, consistent
gateway annotation. Otherwise use the configured generic chat default. Support
all three adapters in V1, but avoid paid probes or alias-name heuristics.

The Responses documentation's encrypted content affinity section explains that
reasoning ciphertext can belong to the upstream credentials that produced it.
The gateway's `encrypted_content_affinity` can route continuations without
`previous_response_id`. Outer Harness identity is necessary for replay but does
not establish this upstream affinity. Newer gateway versions can degrade replay
when an origin disappears; this is behavior outside Harness's guarantees.

Preserve item IDs and opaque payloads exactly. Qualify two real turns through
the supported gateway version, including load-balanced origins where supported.
Document required gateway affinity configuration; do not add Harness routing,
silently drop fidelity, or use provider server history as canonical truth.

Boot-only discovery still changes model interpretation across process restarts.
If metadata loss changes a previously Responses/Messages alias to generic Chat,
the existing chat request mapper would ignore its matching fidelity payloads.
The LiteLLM provider must reject such a continuation before network I/O unless
the resolved route can replay the matching payload. A new catalog mechanism does
not by itself establish continuity for saved histories.

## Limits of this evidence

No real LiteLLM gateway was exercised in this planning task; the user supplied no
gateway target for qualification. No model generations or spend were initiated.
Reading source and tests does not qualify deployed versions, translated custom
tools, encrypted reasoning, thinking signatures, or proxy path prefixes with the
pinned TypeScript SDKs. Those are implementation acceptance checks in the
[delivery plan](../plans/models/2026-10-03-dynamic-provider-catalogs.md).

## Implementation qualification on 2026-10-03

The implementation subsequently exercised the official LiteLLM **v1.103.2** image
at digest `sha256:f63fb81b831b170ec16851e23c36ac5bf52ef106b271406429524a2ed730bbfd`
with isolated Postgres and controlled HTTP/SSE upstreams. Real virtual keys
produced restricted catalogs and rejected a forbidden generation without an
upstream POST. Responses, Chat Completions and Messages completed two-turn tool
continuations with usage. Responses synthetic ciphertext/item IDs replayed on
each forced origin and retained affinity under one shared alias; Messages
synthetic signatures survived replay. This qualifies gateway serialization,
authorization and configured affinity, not vendor cryptographic acceptance.
No real upstream credentials or paid generations were used. The opt-in fixture
is `packages/litellm/src/live-gateway.test.ts`; its command is in
[testing guidance](../TESTING.md).

The pinned [model field definitions](https://github.com/BerriAI/litellm/blob/v1.103.2/model_prices_and_context_window.json)
define legacy `max_tokens` as an input **or** output maximum. It cannot establish
a combined context window. Harness preserves explicit input/output limits
separately and accepts combined context through qualified profile metadata.
The pinned [metadata types](https://github.com/BerriAI/litellm/blob/v1.103.2/litellm/types/utils.py)
also define `supports_reasoning`, adaptive/legacy/always-on thinking flags,
`reasoning_effort_levels` and `default_reasoning_effort`. These are normalized
informational catalog fields, including explicit false values; they do not prove
encrypted payload support or authorize invented request controls/presets.

Public RPC/domain regression verifies metadata delivery. Packaged Windows tests
verify DPAPI-isolated keys, restart discovery, model selection/generation, and
reopening existing unavailable selections without losing history. Real browser
login to multiple vendor accounts and vendor-encrypted continuation acceptance
remain unqualified.
