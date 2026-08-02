# Models subsystem plan

## Objective

Make existing providers reliable and semantically consistent before expanding
the catalog. Keep provider quirks at adapter boundaries and keep the kernel free
of SDK-specific error, tool, and payload behavior.

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
- Automatic model discovery and pricing fetches.
- Guaranteed enforcement of advisory output caps on transports without a native
  parameter.
- Provider-native/server-side compaction until one adapter implements it through
  the existing compaction boundary.
