# Harness

A local-first, model/provider-agnostic coding-agent harness. It combines a
durable conversation core with Harness-owned tools, sandboxed execution,
approvals, project instructions, compaction, background activities, and
subagents through a typed plugin surface.

See `PLAN.md` for product direction and current subsystem status.

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

Repository guidance lives in `AGENTS.md`. See `docs/README.md` for the roles of
subsystem architecture, roadmaps, decisions, research, delivery plans, testing
guidance, and deferred-work records.

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

Sandbox configuration changes are saved globally and in the current conversation override, then
Harness reloads that conversation so backend, workspace-write, and network changes apply
immediately. A running foreground turn must finish or be interrupted first; live background work is
confirmed and stopped by the reload. Selecting `native` then fails normally if `bwrap` is missing or
cannot create namespaces; it never silently falls back to host execution. `/reload` performs the
same clean reactivation without changing settings.

Routine Native calls run inside Bubblewrap without approval. Harness-executed function tools can
opt into explicit host escape with `executionFunctionTool`; their schema then exposes
`sandbox_permissions: "require_escalated"` plus a required `justification`. The existing approval
middleware classifies that call as outside the workspace before execution. After approval, only
that tool invocation receives the host execution context. The Harness-owned Anthropic editor and
the OpenAI-style freeform `apply_patch` tool implement the same behavior in their own wire formats.
Provider-owned execution tools are intentionally outside the current product
surface; all execution tools offered by the shipped composition are controlled
by Harness.

### Project instructions

The standalone `agents` plugin loads hierarchical `AGENTS.md` guidance for every conversation,
including subagents. At session load it snapshots files from the host filesystem root through the
conversation cwd into the cache-stable instruction prefix, ordered broadest to most specific.
Because outside-workspace instruction reads share the approval boundary, compositions register
`approval` before `agents`; the plugin host rejects the unsafe reverse order.

When a Harness-owned structured file tool accesses a deeper or approved outside-cwd path, the
plugin appends newly applicable `AGENTS.md` files as keyed context items after the tool-call batch's
results.
Those keys deduplicate within the active context and follow the conversation branch automatically:
rewind restores the selected branch's loaded set, while compaction drops older nested markers so a
later file access reloads current instructions. V1 does not parse shell commands, watch files for
changes, or discover container-only instruction trees.

Native v1 treats Harness's own `.harness` output persistence as trusted internal IO, so large or
background command output may update `.harness` even when `workspaceWrite` is disabled. Built-in
write/remove operations reject paths that resolve outside the workspace, but that check and the
host operation are not atomic against a concurrent process replacing a path with a symlink. A
future version should execute these mutations inside the Bubblewrap boundary; v1 does not claim
protection against that race.

### Layout

Packages under `packages/*`, layered one-directionally:
`protocol → store → core → service → cli`. Tools and model providers are not
layers — they are plugin contributions wired in at the `cli` composition root. Providers declare
which file-tool dialect a model expects; `workspace` owns and executes every concrete file tool,
while `agents` independently supplies hierarchical project instructions around those calls.
