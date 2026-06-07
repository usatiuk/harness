# Harness

A local-first, model/provider-agnostic agent harness. Built incrementally:
a simple, proven conversation core with clean, one-directional layering so
tools, plugins, activities, subagents, and MCP slot in as additive layers
rather than rewrites.

Design doc / PRD is being refined; implementation of Phase 1 follows.

Prior attempts (reference only, not tracked here) live under `old/`.

## Development

Node >= 22 (see `.nvmrc`). The monorepo uses npm workspaces; cross-package
imports resolve to TypeScript **source** in dev via the `development` export
condition — there is no build step to run or test.

```sh
npm install          # link workspaces, install husky hook
npm run dev          # run the CLI from source (tsx --conditions=development)
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm run check        # typecheck + lint + format:check + test (also runs in CI)
```

### Layout

Packages under `packages/*`, layered one-directionally:
`protocol → store/model → core → tools → plugins → service → cli`.
