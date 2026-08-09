# Provider follow-up hardening

**Status:** Complete — delivered 2026-08-09.

## Goal

Correct the semantic and evidence gaps found in the 2026-08-08/09 provider
changes without adding another provider abstraction. Completion means provider
selection, preset shaping, stream termination, usage accounting, and custom
configuration fail loudly or preserve their declared invariants through public
boundaries.

## Chosen approach

- Route every compiled OpenCode Go model through the transport documented by the
  gateway; keep reasoning fidelity on stateless Responses requests.
- Treat a caller's `ModelRequest.maxOutputTokens` as more specific than a preset
  cap. Preset `extraBody` remains an extension escape hatch, but may not replace
  Harness-owned structural fields (`model`, conversation input, tools, stream,
  storage, instructions, or output limits).
- Replace the whole model selection when a higher settings layer selects a model;
  presets are model-scoped and never inherit across selections.
- Validate a model before capabilities select tools or context. Custom provider
  capability lookup must reject unknown models.
- Make custom model schemas strict and use own-property preset lookup.
- Accept only complete chat tool calls and successful terminal reasons. Preserve
  streamed partial text, but fail the turn on truncation, filtering, malformed
  calls, or unsupported terminal reasons.
- Represent unavailable usage explicitly as `null` on completed events,
  invocation results, durable usage rows, and usage events. Do not price or add a
  null checkpoint to capacity estimates.
- Add a service/engine integration regression using a config-created custom
  provider and a controlled SDK client, alongside focused boundary tests.
- Consolidate the four earlier overlapping delivery plans into concise completed records,
  synchronize accepted architecture/testing docs, and remove inert roster
  metadata and misleading comments.

## Explicit non-goals

- Moving inline custom-provider API keys into the secret store in this change.
  The plaintext global-settings tradeoff remains accepted and must be documented
  accurately.
- General model discovery, retry, fallback routing, or a new terminal-state
  framework beyond the demonstrated chat semantics.
- Preserving the recently introduced behavior where arbitrary `extraBody` keys
  can replace Harness-owned request structure.

## Implementation slices

1. Correct OpenCode roster routing, Responses reasoning inclusion, comments, and
   live/unit coverage.
2. Harden custom schemas, scoped lookups, preset precedence, reserved extension
   fields, and atomic model selection; validate before capabilities.
3. Normalize chat terminal failures, malformed calls, and nullable usage across
   protocol, engine, stores, CLI aggregation, and provider tests.
4. Add a public-boundary custom-provider integration regression.
5. Reconcile plans, model architecture, testing guidance, and deferred/accepted
   limitations; remove dead metadata.

## Validation

- Focused post-review validation passed: 192 tests across config, custom
  providers, OpenAI Responses/chat streams, OpenCode Go, and the engine.
- `npm run check` passed: typecheck, lint, formatting, and 729 tests; 28 opt-in
  live tests were skipped.
- Independent read-only correctness, architecture/simplicity, and
  tests/documentation reviews were completed. Their accepted findings were
  fixed and revalidated; exporting a private CLI bootstrap solely for test
  access was rejected in favor of documenting that remaining boundary.
- Live OpenCode calls were not run because they remain credential-gated behind
  `OPENCODE_API_KEY`.
