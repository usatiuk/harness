# Dedicated AGENTS.md support

Status: Complete

## Goal

Add hierarchical `AGENTS.md` instructions without coupling them to providers or
the workspace tool plugin. Completion means every conversation, including a
subagent, receives the host filesystem ancestor chain from root through its cwd,
and structured workspace file calls lazily inject deeper applicable files once
per active context window.

## Current behavior

- `ContextSource` contributes a cache-stable prefix but cannot see the active
  conversation or its workspace root.
- Keyed `context` items and `ToolMiddlewareContext.active`/`appendContext`
  already provide rewind-safe lazy context injection.
- Anthropic currently contributes its Harness-executed text editor from the
  provider plugin, while an unused native-tool protocol branch exists only in
  adapter tests.

## Chosen approach

- Make context sources conversation-aware through the existing per-conversation
  service lookup.
- Move the Claude-shaped editor into `@harness/workspace`; retain
  `ModelCapabilities.fileTools` only as the roster selector and delete the unused
  provider-native tool representation.
- Export structured file-target extraction from workspace. A new, separate
  `@harness/agents` plugin consumes that helper and owns all instruction
  discovery, prefix contribution, lazy middleware, and runtime snapshot state.
- Require approval middleware outside agents middleware, validate calls against
  the active tool roster before discovery, and avoid host-outside discovery for
  confined execution calls.
- Discover `AGENTS.md` using host filesystem name semantics. The initial
  root-to-cwd chain is snapshotted into the stable prefix. Deeper target chains
  are appended as keyed context items, broadest first, and deduplicated against
  the compacted active window.
- Let the triggering operation execute normally. Compaction or rewind removes
  lazy loaded markers with the active branch; later structured access reloads
  them. Shell/glob parsing, watching, configuration, size caps, and
  container-only instruction trees are not part of v1.

## Implementation slices

1. Remove native tool protocol/adapter branches and centralize every file tool in
   workspace.
2. Add contextual `ContextSource` invocation in core.
3. Add the agents package, host-path discovery, formatting, active-key dedup, and
   CLI registration.
4. Cover roster selection, target extraction, hierarchy, prefix snapshotting,
   lazy injection, rewind/compaction semantics, resume, and subagent cwd
   inheritance at the highest practical boundaries.
5. Document user-visible behavior and run focused tests, `npm run check`, and the
   independent review loop.

## Acceptance criteria

- Provider plugins contribute no filesystem tools and no native-tool protocol
  variants remain.
- Initial instructions are ordered filesystem root to cwd and remain stable for
  a loaded runtime.
- Structured reads/writes/edits/patches inject newly applicable instructions in
  deterministic hierarchy order without a separate durable loaded-state store.
- Rewind and compaction derive loaded state solely from the selected active
  window, and subagents load instructions independently from their inherited cwd.
- Full repository validation passes and review findings are resolved or
  explicitly deferred with evidence.

## Outcome

- `@harness/agents` owns host `AGENTS.md` discovery, stable initial snapshots,
  lazy nested context, and active-window dedup as a standalone plugin.
- Workspace owns every Harness-executed file tool, including the Claude-shaped
  editor; unused provider-native tool protocol and adapter branches are gone.
- Approval ordering, active-roster validation, realpath containment, cancellation,
  and complete tool-call/result batch adjacency are enforced and regression-tested.
- Rewind, compaction, resume, and independent conversation cwd behavior are covered
  through the service boundary. Shell parsing, file watching, configurable limits,
  and container-only instruction trees remain intentionally outside v1.

## Validation

- Focused final regressions: 118 passed, 1 platform-specific test skipped.
- `npm run check`: typecheck, ESLint, Prettier, and 550 tests passed; 34 skipped.
- Three independent review lenses (correctness/security, architecture, and
  simplicity/anti-overengineering) completed, followed by targeted blocker re-review.
