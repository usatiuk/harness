# Mistral connections and provider session routing

Status: Completed

Historical delivery. The [native-search integration](2026-10-10-native-search-and-assistant-phases.md)
supersedes its Chat transport with streaming Conversations for both connections,
preserving its auth, catalog, model controls and routing contracts.

## Outcome and scope

Deliver `mistral-api` and `mistral-vibe` API-key connections and fix OpenCode Go's
required `x-opencode-session` header in this worktree.
One native Mistral adapter owns requests, streams, thinking continuation, usage,
and cancellation. Existing named credentials, startup discovery, status, client
settings, and model selection remain the integration boundaries. No browser
authentication, new agent loop, periodic catalog refresh, or billing inference.

## Design and evidence

- API catalogs use authenticated `GET /v1/models`; Vibe catalogs use
  `GET /v1/model-catalog?surface=vibe-code`. The latter is experimental upstream.
  Neither the catalog surface nor a client identity proves billing eligibility.
- Use the existing OpenAI SDK for cancellable HTTP/SSE delivery with native
  Mistral request/stream mappers. Inspection of Mistral SDK 2.7.0 established that
  its usage parser defaults missing counts to zero, violating Harness's unknown
  accounting contract. Mistral thinking is structured content, unlike the current
  OpenAI chat mapper. Preserve native continuation data through opaque payloads.
- Add required `ModelCallContext { conversationId }` at the single core call
  boundary. Each conversation, including each subagent, keeps its own existing
  identity through turns, retries, compaction, auxiliary calls and resume.
  Neither an extra session store nor root-level cache sharing is needed.
- OpenCode Go sends `x-opencode-session` through connection-owned, per-call
  request-header callbacks on Chat, Responses and Messages transports. Never
  mutate shared SDK client headers. The user's observed HTTP 400 establishes
  the missing-header regression, and current Go docs require session routing
  and an identifiable user agent.
- Every Mistral generation sends `x-affinity` and a Harness user agent. Preserve ordered
  instructions, messages, and tool schemas; do not insert changing telemetry into
  prompt content. Record reported cached tokens without inventing unknown usage.
- Discover once at boot within existing cancellation/deadline ownership. Bound
  response bytes and rows, validate at the remote boundary, and publish a complete
  snapshot. Failures preserve prior state and appear in existing provider status.
- Catalogs establish explicit capabilities and capacities. Unsupported models
  are excluded; unknown limits/pricing remain unknown. Reasoning options become
  controls only where the native request mapping is verified.

Primary sources inspected on 2026-10-10:

- [Models API](https://docs.mistral.ai/api/endpoint/models)
- [Vibe catalog endpoint](https://github.com/mistralai/mistral-vibe/blob/main/vibe/core/model_catalog/_constants.py)
- [Vibe catalog schema](https://github.com/mistralai/mistral-vibe/blob/main/vibe/core/model_catalog/models.py)
- [Native adapter](https://github.com/mistralai/mistral-vibe/blob/main/harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/adapters/mistral.py)
- [Cache affinity and attribution](https://github.com/mistralai/mistral-vibe/blob/main/vibe/app_server/_completion_attribution.py)
- [OpenCode Go client requirements](https://opencode.ai/docs/go/#where-can-i-use-it)

## Milestones and checks

- [x] Provider context and native adapter.
  - Add typed context at the single core invocation boundary and forward it
    through delegating adapters. Check independent child, concurrent, retry,
    compaction and resume identities.
  - Send Go session/agent headers across every transport. Check the reported
    missing-header failure with real SDK/HTTP fixtures and concurrent shared clients.
  - Implement native requests and streaming with real SDK/HTTP fixtures. Check
    tools and thinking across two calls, opaque fidelity, cancellation, missing
    or malformed accounting, terminal stream errors, and stable headers/prefixes.
- [x] Catalogs and complete connection integration (depends on adapter).
  - Parse both bounded catalogs, preserve exact IDs, capabilities, limits and
    verified reasoning options. Check malformed/unsupported data, redirects,
    atomic replacement, abort, and discovery failure status.
  - Register connection types/defaults with independent credentials. Check public
    server RPC sign-in/status/catalog/generation and named connection isolation.
- [x] Validation, documentation, and independent review (depends on integration).
  - Update root/model/testing documentation and plan evidence.
  - Run focused integration tests, `npm run check`, and three independent read-only
    review lenses, including simplicity. Resolve material findings and revalidate.
  - Attempt opt-in vendor qualification only when usable credentials are present;
    report vendor/billing/cache qualification limits precisely. Build the shared
    server bundle to exercise dependency packaging.

## Evidence and remaining work

Implemented and fixture-verified the provider context, Go headers, native Mistral
adapter, both bounded catalogs, auth types/defaults, and public server integration.
Seven focused test files passed (42 tests); four additional native ID/alias cases
also passed in the full suite. The shared-server bundle builds. Three independent
read-only reviews covered behavior/correctness, architecture/failure/simplicity,
and tests/evidence/documentation/scope, with no material findings.

The first full check stopped on new lint type errors, corrected without changing
behavior. The next check passed types/lint/formatting and 1,058 tests, with one
stale server-process assertion expecting four default connections rather than six.
The assertion now checks all six exact IDs, and its child-process environment
clears both Mistral key references. Before rebasing, `npm run check` passed
typechecking, lint, formatting and all 1,059 tests (123 files); 36 tests were skipped.
The shared server bundle builds with the new provider included. Final diff and
documentation formatting checks pass.

Fixtures use synthetic API keys and native signatures; they establish transport
and payload fidelity, not live vendor acceptance. Neither Mistral environment key
was present. Native signed continuation across a SQLite/server restart is composed
coverage from native adapter and existing core payload persistence tests, not a
direct Mistral restart scenario. RPC auth tests substitute the credential backend;
they do not qualify real DPAPI storage. Vendor signature acceptance, cache-hit
rates and subscription billing remain unqualified.

No required implementation remains. Live vendor qualification requires credentials.
The user authorized commits and a push to main on 2026-10-10, with rebasing first.
The worktree is rebased onto `ea5827c` from `origin/main`; the overlapping root
delivery notes retain both changes. The repeated full `npm run check` passes
typechecking, lint, formatting and all 1,061 tests (124 files), with 36 skipped.
Code commits are `c3f8750` (per-conversation routing/OpenCode) and `1e2262a`
(Mistral API/Vibe); a final documentation commit records the validated delivery.
