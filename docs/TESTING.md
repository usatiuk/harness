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

- The `opencode-go` provider's roster is static and unit-tested against the live
  gateway model list; live smoke (one request per transport family, tool loop,
  prior-reasoning round-trip) is opt-in behind `OPENCODE_API_KEY` and is not run
  in CI.
- The chat/completions transport's reasoning round-trip (plaintext
  `reasoning_content`, merge into the following assistant output), same-chunk
  reasoning+boundary handling, `finish_reason: "length"` recovery, and the
  missing-terminal-failure path (no `completed` emitted, zero spend) are
  unit-tested via fixture streams; the live OVMS/chat-completions path is a
  documented smoke boundary.
- Chat reasoning is only merged onto assistant-role messages; a non-assistant
  message after a reasoning item receives a standalone assistant reasoning
  message instead — covered by the request-mapping tests.
- There is no engine-loop regression for the chat transport yet: the engine is
  exercised at the `ModelStreamEvent` boundary via the testkit fake provider, and
  the live smoke covers the true wire boundary. Add one when a chat-family
  conversation needs regression coverage.
