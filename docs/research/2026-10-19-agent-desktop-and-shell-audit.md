# Agent, desktop, and shell audit

Date: 2026-10-19. Repository baseline: `b215b8e` (`main`).
Status: read-only source research; proposals are not implemented behavior.
Delivery: [execution plan](../plans/cross-cutting/2026-10-19-agent-desktop-and-shell-follow-up.md).

## Scope and evidence limits

The user requested all twelve concerns below, cross-harness research (especially
shell initialization), and a simplicity/architecture review before implementation.
Three bounded researchers inspected the repository and primary upstream sources;
none delegated further. Upstream source/assertions were inspected, not executed.
No native UI, shell startup experiment, or live-model behavior evaluation was run.
GitHub API rate limiting bounded further upstream inspection. Do not infer closed
source desktop internals from product documentation or issue reports.

## Repository findings

| Concern                                | Current evidence                                                                                                                                                                                                    | Consequence                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-message content outside Working    | `packages/desktop/src/transcript.ts` groups only tools, reasoning, provider output, and plugin messages.                                                                                                            | Context, compaction, errors, worked markers, notes, and shell output remain standalone. Only actual user/assistant messages should break groups.                     |
| Open work drops out of the latest five | `StepGroup` in `packages/desktop/src/routes.tsx` computes a rolling last-five tail; captured boundary protects outer expansion only.                                                                                | An individually opened preview row unmounts when it leaves the tail. Stable keys alone cannot preserve an unmounted component.                                       |
| Excessive and relay delegation         | `packages/subagents/src/tool.ts` says prefer delegation over inline work; default catalog prompts in `config.ts` do not discourage unchanged whole-task relay.                                                      | Narrow prompt guidance, not another scheduling/permission framework, is the first intervention. Depth is already bounded.                                            |
| Dismissed children in navigator        | Model roster filtering in `subagents/src/family.ts` differs from historical paging in `server/src/subagents.ts`.                                                                                                    | Hiding dismissed branches changes the documented GUI contract; preserve accessible history and existing activity lifetime.                                           |
| Missing child parent briefing          | `subagents/src/activity.ts` seeds the task and stores parentage; no equivalent briefing reaches the child.                                                                                                          | Existing durable identity/ancestry can supply a small task-local briefing; full transcript inheritance is unnecessary.                                               |
| UUID-facing operations                 | Family send/dismiss use IDs; `SubagentActivity.id` is the child UUID, also used by activity wait/peek/kill and completion notices.                                                                                  | Readable addressing must cover both durable family tools and process-local activities without conflating their lifetimes.                                            |
| Global instructions                    | `agents/src/index.ts` discovers ancestor files, not a special Harness-home file. `config/src/merge.ts` replaces scalar strings; client baseline and child role overrides can shadow global settings `instructions`. | Add the global file through the existing agents-plugin instruction contribution, independently of role/config strings. No new role API is needed to accomplish this. |
| Shell/environment mismatch             | `execution/src/local.ts`: Unix `bash -lc`, Windows PowerShell `-NoProfile -NonInteractive`. `sandbox/src/native.ts`: deliberately `bash -c`; Docker uses container `bash -lc`.                                      | Interpreter selection, startup state, and shared-server environment ownership are distinct contracts. A universal `-i` or `-l` edit is incorrect.                    |
| Unknown context-window indicator       | Desktop `components/usage-inspector.tsx` uses only `contextWindow`. TUI `app.tsx` combines current model selection with generic last-input usage.                                                                   | Use the authoritative agent checkpoint/model and a correctly labeled input-limit fallback. Unknown is not zero.                                                      |
| Unstyled links                         | Transcript Markdown routes through `TranscriptLink`; reset removes ordinary affordances, with no content-link recipe restoring them.                                                                                | Add scoped content-link styling without changing navigation links or safe URL opening.                                                                               |
| CSD corner when sidebar hidden         | `styles.css` gives every main panel a top-left radius; sidebar-hidden changes layout but not radius.                                                                                                                | Square that corner in the requested CSD state; retain native/fullscreen behavior.                                                                                    |
| CSD controls/translucency              | Host button is ghost at rest, but hover tokens are opaque. Both sidebar toggles already use `IconButton`, with divergent sizes/local geometry.                                                                      | Reuse the existing primitive and one narrow chrome interaction recipe; do not invent another component framework.                                                    |

### Instruction boundary

The agents plugin already contributes cache-stable instruction-prefix content
independently of `conversation.config.instructions`. Loading
`$HARNESS_HOME/AGENTS.md` there makes it additive to the existing main/subagent
role strings. This is the smaller interpretation of the earlier role-separation
proposal: no new prompt registry, role configuration field, baseline migration,
global editor, or instruction database is required. Preserve the scalar setting's
current replacement semantics and document which source is additive.

### Shell boundary

Local server launch (`connections/src/connect.ts`) and the desktop Node bridge
(`src-tauri/src/runtime.rs`) directly launch executables with inherited environment;
there is no general shell initialization step. AppImage loader-variable scrubbing
is intentional. WSL/SSH bootstrap executes on the target; container environment
is container-owned. A second client attaching to an existing owner must not
silently replace its environment. The Bash/PowerShell tool descriptions in
`workspace/src/tools.ts` advertise a language contract; changing the interpreter
must update that contract rather than run incompatible syntax behind a Bash label.
Native sandbox login profiles were deliberately avoided because host startup
scripts can depend on services absent from the sandbox. Startup capture must not
reintroduce that failure or execute model commands outside confinement.

### Capacity boundary

`ModelInfo` independently represents context, input, and output limits. LiteLLM
preserves input/output limits without manufacturing a shared context window.
`Engine.#contextCapacity` already combines known input capacity with known
context-minus-output constraints and reserves compaction headroom. It is not
broken merely because the UI lacks an input-limit fallback. UI percentage and
compaction trigger have different semantics; do not merge them into one helper.

## Primary-source comparisons

Upstream revisions inspected through `gh`:

- Codex: `fbb2f9dbec300d59699e52a47ecd9fa49f28b948`.
- OpenCode: `52a10f573f1da5103c85990da9341e3645a39365`.
- Claude references below are live official documentation read during the audit,
  not proof of private implementation. In particular, current docs support nested
  agents; the older blanket assertion that Claude cannot nest is not applicable.

### Delegation, identity, and global instructions

- [Claude subagents](https://code.claude.com/docs/en/sub-agents): distinguishes
  quick/shared-context work from isolated delegated work; descriptions influence
  delegation; supports depth limits, useful nested work, and readable agent
  names. Do not equate its row-clear behavior with Harness subtree dismissal.
- [Codex subagent documentation](https://developers.openai.com/codex/subagents/):
  discusses explicit delegation and the cost of parallel agents.
- [Codex experimental collaboration template](https://github.com/openai/codex/blob/fbb2f9dbec300d59699e52a47ecd9fa49f28b948/codex-rs/core/templates/collab/experimental_prompt.md):
  discourages spawning for simple work and recursive delegation by a test-output
  worker. This is an experimental bundled template, not universal runtime policy.
- [OpenCode rules](https://opencode.ai/docs/rules/) and
  [Claude memory/instructions](https://code.claude.com/docs/en/memory): both provide
  user-global file instructions in addition to project guidance. OpenCode also
  supports configured additive instruction files; remote imports are not needed
  for Harness's requested global file.

Decision: improve the shipped tool/catalog guidance; retain bounded useful
nesting. Use existing durable names/slugs, family authorization, and the agents
plugin rather than introduce a new orchestration or prompt layer.

### Shell practices

- [Bash startup rules](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html)
  and [zsh startup rules](https://zsh.sourceforge.io/Doc/Release/Files.html): login
  and interactive initialization are distinct; shell identity alone does not
  guarantee that interactive rc configuration runs.
- [Codex shell detection](https://github.com/openai/codex/blob/fbb2f9dbec300d59699e52a47ecd9fa49f28b948/codex-rs/shell-command/src/shell_detect.rs#L61-L132)
  uses account information on Unix.
  [Startup handling](https://github.com/openai/codex/blob/fbb2f9dbec300d59699e52a47ecd9fa49f28b948/codex-rs/shell-command/src/startup.rs#L1-L29)
  explicitly sources matching rc files, with Bash respecting `BASH_ENV`.
  [Snapshot capture](https://github.com/openai/codex/blob/fbb2f9dbec300d59699e52a47ecd9fa49f28b948/codex-rs/shell-command/src/shell_snapshot_capture.rs#L125-L187)
  captures more than exports, including functions/options/aliases. Capture is not
  equivalent to a permanent live shell; interactive guards may still skip rc code.
  Its credential policy/cache/replay machinery is not a required Harness design.
- [OpenCode shell selection](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/core/src/shell/select.ts#L164-L188)
  uses configuration or shell environment with compatibility restrictions;
  [commands use fresh processes](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/core/src/shell.ts#L61-L67).
  [Desktop export discovery](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/desktop/src/main/service/shell-env.ts#L5-L109)
  separately probes an interactive login shell with bounded execution, then
  [merges exports into the app environment](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/desktop/src/main/lifecycle/environment.ts#L22-L34).
  This imports exports, not aliases/functions; startup chatter/hangs need handling.
- [Claude environment variables](https://code.claude.com/docs/en/env-vars) and
  [hook environment persistence](https://code.claude.com/docs/en/hooks#persist-environment-variables):
  document supported Bash/zsh selection and `CLAUDE_ENV_FILE` shell code before
  commands. They do not establish private snapshot internals or a persistent shell.

Decision: separate host startup/environment discovery from noninteractive command
execution; respect target ownership and truthful shell language. A bounded design
checkpoint must settle rc/alias/function compatibility and supported shells before
shipping. No library suitability or startup probes were verified in this audit;
check maintained facilities before building custom infrastructure.

### Desktop and context presentation

- [OpenCode tool-group tests](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/session-ui/component-tests/tool-group.spec.ts#L40-L115)
  preserve independent disclosure choices while adding work.
  [Timeline range exceptions](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/app/src/session/timeline/virtualizer.tsx#L140-L177)
  and keyed disclosure state support narrow lifetime exceptions. This is related
  precedent, not proof it implements Harness's proposed last-five/open-row union.
- [OpenCode Markdown styling](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/session-ui/src/components/markdown.css#L100-L109)
  supplies explicit interactive color and hover underline.
  [Icon-button recipes](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/ui/src/actions/icon-button/icon-button.css#L77-L125)
  centralize transparent/overlay states. Permanent content underlines are our
  accessibility/design choice; no exact external CSD corner/material rule was
  established. Browser CSS cannot establish native material qualification.
- [OpenCode context display](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/tui/src/util/session.ts#L46-L65)
  uses a context-only denominator and a different usage numerator.
  [Compaction](https://github.com/anomalyco/opencode/blob/52a10f573f1da5103c85990da9341e3645a39365/packages/core/src/session/compaction.ts#L937-L952)
  separately uses input/context limits with reserve. Do not copy that display
  denominator blindly or conflate UI capacity with a compaction threshold.

Decision: follow the user's concrete Working/CSD requirements; retain bounded
mounting with open/focus exceptions and existing primitives. Input-only Harness
usage should use a labeled input limit first, shared context limit second, and
explicit unknown otherwise. Never manufacture context as input plus output.
