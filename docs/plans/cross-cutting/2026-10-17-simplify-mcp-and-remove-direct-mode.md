# Simplify MCP and remove direct tool mode

Status: Complete

## Behavior and design

MCP tools use `mcp_<serverId>_<rawMcpToolName>` without sanitization,
truncation, or hashes. Existing catalog collision checks reject the affected
server atomically. MCP tools have `{ direct: false, code: true }` exposure:
discover with `tool_search`, inspect with `tool_describe`, and execute through
`eval` → `tools.call()`. Discovery never promotes tools into provider declarations.
The existing exposure and execution boundaries handle this without MCP-specific
core logic.

`ToolMode` is `"hybrid" | "code-only"`; Hybrid is the default. Settings and
wire schemas normalize legacy `"direct"` to `"hybrid"`, including persisted
conversation overrides. Reads do not rewrite stored history or settings files.
Both modes require eval, so engine and service composition require an evaluator.
GUI/TUI expose only the supported modes.

Explicit allowlists containing former hashed MCP names require updating; scopes
are not widened automatically. Old history retains its recorded names.
Search matching changes (issue #44) and new permission machinery are outside scope.

## Delivery checks

- [x] Simplify MCP identities and use code exposure; verify real SDK stdio/HTTP,
      raw-name discovery, eval execution and rejection of direct guesses.
- [x] Remove direct mode from types, engine branches, defaults and UI; require
      the evaluator and adapt composition/test fixtures. Typechecks pass.
- [x] Verify legacy file/profile/wire normalization and SQLite reopen followed
      by successful continuation. Existing code-mode tests cover essential/direct
      and deferred/eval behavior, approvals, cancellation and ordering.
- [x] Synchronize README, subsystem docs and generated client schema.
- [x] Review scope and simplicity, then run full validation after implementation.

## Validation

`TMPDIR=/var/tmp npm run check` passed: 156 test files, 1,444 tests and 41 skips,
plus root/CLI/desktop typechecks, lint and formatting. Protocol schema generation
and `git diff --check` passed. The tool-mode picker browser regression passes.
Native GUI interaction remains unverified.
