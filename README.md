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

On Windows, local command execution is exposed to models as `powershell`; Linux,
macOS, and Linux dev containers expose `bash`. Windows sign-in requires Credential
Manager (file-backed credentials are intentionally unsupported). Tool allowlists
that target both local Windows and dev-container sessions should include both
`powershell` and `bash`.

### Execution backends

The `sandbox` plugin selects one execution backend per loaded conversation:

- `local` runs workspace tools directly on the host.
- `native` (Linux only) runs commands in Bubblewrap. The host filesystem is readable, temporary
  and runtime directories are private, workspace writes and network access are independently
  configurable, and built-in file writes enforce the same workspace boundary.
- `docker` runs execution-backed tools in the workspace's dev container.

The global setting (also configurable with `/sandbox`) is:

```json
{
  "plugins": {
    "sandbox": {
      "backend": "native",
      "native": { "workspaceWrite": true, "network": true },
      "docker": {
        "configPath": ".devcontainer/devcontainer.json",
        "idleTimeoutMinutes": 10
      }
    }
  }
}
```

Sandbox configuration changes are saved globally and in the current conversation override, but
execution backends remain cached for the life of the Harness process. Restart Harness to apply any
backend, workspace-write, or network change. Selecting `native` then fails normally if `bwrap` is
missing or cannot create namespaces; it never silently falls back to host execution.

Routine Native calls run inside Bubblewrap without approval. Harness-executed function tools can
opt into explicit host escape with `executionFunctionTool`; their schema then exposes
`sandbox_permissions: "require_escalated"` plus a required `justification`. The existing approval
middleware classifies that call as outside the workspace before execution. After approval, only
that tool invocation receives the host execution context. The Harness-owned Anthropic editor and
the OpenAI-style freeform `apply_patch` tool implement the same behavior in their own wire formats.
Provider-executed tools such as web search are not claimed as sandboxed.

Native v1 treats Harness's own `.harness` output persistence as trusted internal IO, so large or
background command output may update `.harness` even when `workspaceWrite` is disabled. Built-in
write/remove operations reject paths that resolve outside the workspace, but that check and the
host operation are not atomic against a concurrent process replacing a path with a symlink. A
future version should execute these mutations inside the Bubblewrap boundary; v1 does not claim
protection against that race.

### Layout

Packages under `packages/*`, layered one-directionally:
`protocol → store → core → service → cli`. Tools and model providers are not
layers — they are plugin contributions, each shipping as its own `plugin-*`
package and wired in at the `cli` composition root.
