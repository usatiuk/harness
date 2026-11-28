# Context notices and process previews

## Scope

Keep repeated commands and clock facts out of model input without hiding where to
find them. Process identity and control stay independent of optional display names.
The new built-in plugin owns the clock, model-change and compaction-warning policy;
the engine owns request timing, token accounting, and the existing compaction decision.
No idle timers, compaction policy changes, new user settings, or desktop warnings.

## Delivery checklist

- [x] Request integration: provide the plugin with branch/window-local history,
      the actual agent model and the existing budget decision; verify request order,
      fresh windows, tool continuations, and retry behavior.
- [x] Built-in plugin (depends on request integration): verify opening snapshot,
      independent clock/model deltas, midnight and offset changes, and one warning
      per window at 90% of a known effective compaction threshold.
- [x] Process activities: accept optional names, identify unnamed processes by ID,
      show existing log paths before previews and keep the exact command in the
      log header. Verify duplicate labels, fileless quick commands, filtered output,
      and terminal status using the existing execution substrate.
- [x] Integration: synchronize the owning subsystem/testing docs, independently
      review the combined change, and run focused tests and `npm run check`.

## Validation

The composed-server test passes with a real demo continuation after `activity_list`:
the clock advances ten minutes, the opening system prefix is unchanged, and no
tool is repeated. Process/command/manager/local-execution tests on Windows
passed (92 passed, one platform skip), including two regressions that failed
before late bytes from inherited pipes were ignored.

Review reproduced a history-boundary issue: a rewind to the visible notice
could drop a separate following plugin bookkeeping item. The fix uses explicit
flat groups, not a recursive history type or a SQLite migration: rewind keeps
the group, fork-before excludes it, and ordinary batches are unaffected. AGENTS
instruction notices and their digests use the same mechanism.
Core tests verify retained vs. abandoned warnings and unchanged transport
retries. Both stores pass the shared boundary tests; SQLite also reopens the
notice group and rehydrates a recorded model request without its storage
metadata. An independent final review found no further group-boundary defects.

The Changes tree also has a 1px visual gap between adjacent file/folder
highlights without shrinking hit targets. Four real Edge tests passed, including
geometry, pointer interaction, and reduced-motion disclosure.

After consolidating the context hooks, 195 focused tests passed (3 skipped):
`systemContext` writes into the opening system message; `contextItems` adds
separate history items, including at the agent-request boundary. Ten focused
output tests passed: file reads keep the requested range, overflowing `eval`
output spills only once, and a process peek keeps its log path and last line
even when a subagent peek in the same batch needs generic truncation.

Final Windows `npm run check` passed typecheck, lint, formatting, and 2,200
tests (83 skipped). No live model-provider calls were made.
