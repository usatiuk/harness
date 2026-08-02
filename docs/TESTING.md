# Testing

Harness uses Vitest for tests, TypeScript for static checking, ESLint, and
Prettier. Tests are co-located with source as `*.test.ts` or `*.test.tsx` under
`packages/*/src/`.

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

## Test boundaries

- Prefer the highest practical public boundary that observes the behavior.
- Use real stores, middleware composition, and representative conversation items
  where practical. Use deterministic providers, tools, clocks, processes, and
  operating-system adapters where external control or reproducibility requires
  substitution.
- Reuse shared contracts from `@harness/testkit` for behavior implemented by more
  than one backend.
- Assert durable state and emitted outcomes, not private call order, unless order
  is itself a protocol or lifetime requirement.
- Avoid fixed sleeps. Use gates, completion events, fake clocks, or bounded
  polling tied to observable state.
- Test cancellation, partial failure, and retry classification at boundaries that
  own them. A failure test should also establish the resulting canonical state.
- Preserve opaque provider payloads byte-for-byte in round-trip tests when an
  adapter transforms model traffic.

Coverage is evidence, not a target by itself. Significant bug fixes should add a
regression scenario when practical; document meaningful gaps when they cannot be
automated yet.

## Finishing a change

Run focused tests while iterating and `npm run check` before handing off code
changes. For documentation-only changes, at minimum run Prettier on the affected
files and `git diff --check`; expand validation when configuration, scripts, links,
or generated content are involved.
