# Testing

Harness uses Vitest for tests, TypeScript for static checking, ESLint, and
Prettier. Tests are co-located with source as `*.test.ts` or `*.test.tsx` under
`packages/*/src/`.

Current coverage boundaries, platform evidence, and gaps are documented in the
[testing subsystem](subsystems/testing/README.md); its active checklist is in
[the testing plan](subsystems/testing/PLAN.md).

## Commands

```sh
npm test                         # all Vitest tests
npx vitest run path/to/test.ts   # focused test file
npm run typecheck                # root and CLI TypeScript projects
npm run lint                     # ESLint
npm run format:check             # Prettier verification
npm run check                    # complete local and CI validation
```

CI runs `npm run check` on Linux and Windows. Execution, process, filesystem,
credential, and terminal behavior may be platform-specific even when most logic
is shared.

## Finishing a change

Run focused tests while iterating and `npm run check` before handing off code
changes. For documentation-only changes, at minimum run Prettier on the affected
files and `git diff --check`; expand validation when configuration, scripts, links,
or generated content are involved.

## Coverage notes

- The `opencode-go` provider's roster is static and unit-tested against the
  2026-08-09 gateway-list and Models.dev metadata snapshots: documented family
  assignments (including Grok chat and GPT Luna Responses), exact model-scoped
  preset catalogs, validation, and Chat/Responses/Messages request mappings. Live
  smoke (one preset request per transport family and a preconstructed tool-call
  continuation shape with prior reasoning) is opt-in behind `OPENCODE_API_KEY`
  and is not run in CI. A credential-gated two-request encrypted-reasoning replay
  remains uncovered.
- The chat/completions transport's reasoning round-trip (plaintext
  `reasoning_content` folded into one native assistant message per generation, so
  a tool-calling turn's reasoning rides the message that carries its tool calls),
  same-chunk reasoning+boundary handling, the interleaved-reasoning fail-fast
  guard (reasoning after the finalized item throws rather than being silently
  dropped), malformed tool calls, truncation/filter terminal errors, nullable
  usage, and the missing-terminal-failure path are unit-tested via fixture streams;
  the live OVMS/chat-completions path is a documented smoke boundary.
- Chat reasoning is folded onto its generation's assistant message; a reasoning
  item with no following assistant output is flushed as a standalone assistant
  reasoning message instead — covered by the request-mapping tests.
- Custom providers have a public-boundary regression from a real settings file
  through factory composition, `HarnessService`, a controlled chat SDK stream,
  tool dispatch, durable usage, and SDK-signal cancellation. Protected request
  builder tests remain for exact transport-shape assertions. The test reproduces
  the production settings-to-plugin bridge; the private interactive CLI bootstrap
  itself is not invoked.
- Store contracts and CLI reducer tests cover durable nullable usage, incomplete
  totals, and context-checkpoint clearing. Engine tests cover record-before-fail
  terminal errors and validation before capability-dependent work.
- Config, engine/service, and CLI regressions cover atomic model selection across
  file/profile/plugin layers, global and conversation persistence, `--model`, and
  explicit preset selection/reset. Same-named presets never cross identities.
- Client/server regressions cover bidirectional request correlation,
  cancellation, invalid messages, first/repeat attachment ordering, failed and
  in-flight attach cleanup, multi-page history plus transient/durable overlap,
  large item reconstruction, attach-first operation admission, cancellation
  before disposal, root isolation, plugin snapshots and controls, queued
  approvals, connection-wide shell identity and collision rejection, sandbox
  mutation/reload, and fatal NDJSON limits. Local stdio is smoke-tested from the
  CLI; SSH smoke remains environment-dependent.
