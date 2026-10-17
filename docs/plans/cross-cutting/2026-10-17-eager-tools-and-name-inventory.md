# Eager Harness tools and deferred names

Status: Complete

## Scope

Mark all Harness capability tools `essential` so Hybrid exposes their full
contracts directly and code-only includes them in eval instructions. Keep MCP
code-only. Reuse the scoped, sorted catalog to include deferred names in eval's
instructions by default; descriptions remain available through tool_describe.

Add one global `tools.showNames` boolean, default true, with GUI/TUI settings.
Project/profile/conversation overrides cannot set it. Like existing kernel
defaults, changes apply when a conversation is created or reloaded. No per-tool
name option, new mode, search algorithm, listing tool or catalog state.

## Delivery

- [x] Mark built-in tools eager; check both mode rosters and deferred MCP behavior.
- [x] Add global setting and scoped name inventory; check defaults, opt-out,
      allowlists and stable ordering through model requests.
- [x] Expose setting through existing RPC/GUI/TUI controls; verify persistence
      and global-only validation, then regenerate protocol schema.
- [x] Update owning docs, review simplicity/correctness and run npm run check
      plus affected browser tests after implementation.

## Validation

`TMPDIR=/var/tmp npm run check` passes: 1,461 tests, 41 skips, plus typechecking,
lint and formatting. Two focused browser regressions pass for Defaults persistence
and conversation creation. Tests cover scoped/stable inventories, production
built-in rosters in both modes, global-only configuration and reload. Protocol 15
and regenerated JSON Schema cover the new wire fields. Independent review found
no remaining issues; native GUI interaction was not exercised.
