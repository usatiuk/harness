# Models subsystem plan

## Objective

Keep existing providers reliable and semantically consistent as catalog support
expands. Keep provider quirks at adapter boundaries and keep the kernel free
of SDK-specific error, tool, and payload behavior.

## Named instances and dynamic gateway catalogs

The [dynamic provider catalog delivery plan](../../plans/models/2026-10-03-dynamic-provider-catalogs.md)
selects a bounded LiteLLM integration: plugin-owned provider types, global named
connections with independent credentials, boot-only discovery, and the existing
three neutral transport adapters. Named built-in API/OAuth instances,
LiteLLM discovery/metadata, diagnostics and client key controls are implemented.
Real LiteLLM with controlled upstreams and packaged Windows behavior are verified;
actual vendor cryptographic acceptance remains credential-dependent. Existing
transient reliability work remains open.

- [x] Deliver one instance/factory boundary for built-in and compatible types.
- [x] Remove pre-release compatibility and separate transport from vendor defaults.
- [x] Deliver LiteLLM discovery and all three gateway adapter routes.
- [x] Integrate bounded startup, safe connection status, and instance key controls.
- [x] Qualify real LiteLLM with controlled upstream continuations and packaged Windows behavior.
- [ ] Qualify vendor-encrypted continuations with real upstream credentials.

## Mistral and per-conversation session routing

The [Mistral and session-routing delivery plan](../../plans/models/2026-10-10-mistral-support.md)
adds API-key Mistral API/Vibe instances and fixes OpenCode Go's required session
header. A single model-call context supplies each conversation's existing ID;
provider-owned request headers keep concurrent calls isolated. Local SDK/HTTP
and RPC regressions pass. Full validation after rebasing passes 1,061 tests, the shared server
bundle builds, and three independent reviews report no material findings. Live
Mistral acceptance/billing/cache qualification lacks credentials.

## Bounded transient reliability

- [ ] Introduce one provider-neutral retryable model failure with adapters owning
      classification.
- [ ] Classify only demonstrated network disconnect, overload, rate-limit, and
      selected service-unavailable failures as retryable.
- [ ] Add one model middleware with a small bounded attempt count and
      cancellation-aware backoff.
- [ ] Retry only before the first yielded model event; never replay observable
      streamed output.
- [ ] Preserve the logical request, context build, tool roster, payloads, purpose,
      and cancellation signal across attempts.
- [ ] Prove deterministic 4xx/configuration/context failures do not retry.

### Acceptance

- Agent, compaction, subagent, and auto-approval calls share identical retry
  semantics without caller-specific code.
- Cancellation ends backoff promptly and no failed attempt records completed
  usage.
- Retry decisions use adapter-owned typed classification, not a middleware list
  of provider message regexes.

## Deliberately deferred

- Provider-native execution tools.
- `previous_response_id` or provider server state as canonical history.
- A general model fallback/router policy.
- Token-count endpoints without observed failures in the usage-checkpoint and
  local-estimate policy.
- Another provider without comparable request, stream, payload, cancellation,
  and live-boundary evidence.
- Splitting a shared provider catalog before backend divergence outgrows a
  small, complete per-model override map.
- Periodic/live catalog refresh, disk catalog caches, and automatic pricing
  fetches. LiteLLM boot discovery is selected in the plan above; `opencode-go`
  retains its static roster. Discovered upstream pricing is not automatically
  treated as a gateway billing rate.
- Guaranteed enforcement of advisory output caps on transports without a native
  parameter.
- Provider-native/server-side compaction until one adapter implements it through
  the existing compaction boundary.
