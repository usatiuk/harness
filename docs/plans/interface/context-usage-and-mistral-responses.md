# Context usage and Mistral Responses

Status: Complete

## Goal

Keep the desktop context ring useful when an agent request lacks a context
measurement. Show actual last-request usage and entire-conversation usage in the
same popover. Replace the deprecated Mistral Conversations transport with
Responses, without switching transports implicitly or rewriting stored history.

## Delivery

- [x] Select the last valid context measurement for the active provider/model
      using recorded usage. Keep the ring unfilled when no measurement or capacity
      is known; do not erase a valid measurement on an unusable response. Verify
      reopen and model switching.
- [x] Show **Last request** and **Entire conversation**, separating cache
      telemetry absence from a confirmed zero. Calculate aggregate cache reuse over
      input with reported cache counts and label partial coverage. Verify through
      the usage boundary and desktop popover.
- [x] Share one Mistral Responses generation path across the API and Vibe
      connections. Preserve credentials, discovery, history, and function-tool
      round trips. Delete legacy Conversations generation and hosted web search
      without introducing a transport picker or fallback. Send the conversation
      cache key and retain reported cached-token usage.
- [x] Verify streaming, resumed history, tools, and usage against both Mistral
      connections. Mocked transport coverage is not live credential qualification.
- [x] Run affected tests and repository checks, review the integrated diff, and
      record validation results and remaining blockers here.

No new dashboard, request capture system, draft token estimator, or history
rewrite is needed.

## Validation

- 18 focused browser tests passed for the final ring and popup in both themes.
- Typecheck, lint, and formatting passed. The full Vitest suite passed outside
  MXC (2,106 passed, 83 skipped); MXC denied Windows named-pipe and symlink
  operations in the sandboxed run.
- Integrated review found that the ordinary Anthropic stream dropped explicit
  cache misses. The stream now retains them, with a regression test.
- 234 focused Mistral, shared OpenAI transport and server tests passed; two
  unrelated tests were skipped.
- Synthetic live calls through the new adapter succeeded separately for API and
  Vibe, including plaintext reasoning, a function call and result, and another
  turn replayed statelessly. The adapter sent both `prompt_cache_key` and
  `x-affinity`. Vibe reported 1,408 cached tokens on one follow-up; API reported
  explicit zeros in that trial (an earlier direct API probe reported 1,280).
  This verifies representative requests, not every catalog model or billing tier.

## Stateless reasoning replay follow-up

- [x] Unify native Responses output replay and keep the legacy encrypted reader. Keep summaries visible and enforce origin and transport boundaries.
- [x] Exercise persisted plaintext and encrypted tool history after reopening SQLite and switching models.
- [x] Verify serialized prompt prefixes across ordinary tool use and follow-up turns.
- [x] Validate shared adapters and repository checks.

The final Windows check passed with two Vitest workers, including typecheck, lint, formatting and 2,107 tests (83 skipped). The local HTTP fixtures verified payload fidelity, the SQLite reopen and serialized prefix stability. This follow-up did not call a live provider.
