# Reasoning presets and code-only discovery

Status: complete locally. Delivery is a local commit only; no push or release.

## Scope

LiteLLM advertises selectable effort presets from exact effort levels, falling
back to per-level support flags. Explicit presets (including an empty map) win.
Unknown reasoning support alone does not invent levels. Transport stays unchanged.

Tool search accepts OR-separated queries with AND-separated words. Search remains
plugin-neutral, bounded and excludes definitions already in context. MCP contributes
available configured server IDs using scoped tool names. Workspace tools opt into
upfront descriptions only inside code-only eval instructions. Hybrid exposes only
essential tools directly; other tools use discovery/eval. It remains the shared
server's unset-setting default and is labeled Hybrid. Explicit saved modes remain.
Direct mode and execution permissions stay unchanged.

## Tasks

- [x] Implement preset normalization and representative request regressions.
- [x] Implement search semantics, scoped MCP hints and code-only upfront contracts.
- [x] Verify scope, compaction, model-specific rosters and direct-call rejection.
- [x] Run focused checks, full check, update owning docs and three independent reviews.

## Validation

Eighty focused tests pass across LiteLLM, service/code-mode, MCP and TUI hosts.
The full check passes 1,360 tests (38 existing skips). Two isolated production-route
browser cases verify model/preset selection and saved creation defaults. Three
independent review lenses report no blocking findings. Request-level tests cover
scoped child hints, no hint for an empty scope, direct-call rejection and actual
compaction. Provider fixtures verify generated defaults/off over Chat/Responses,
Messages-compatible levels and explicit preset overrides. Messages none/minimal
effort presets remain excluded by its existing transport contract; thinking
configuration is unchanged. Legacy off requires explicit support instead of
provider/model-name inference. Live gateway and native UI behavior were not
separately qualified. Existing reading-anchor browser failure remains documented
under conversation naming and was not rerun or changed by these scoped browser checks.

Protocol 10 accounts for empty advertised effort sets and the changed tool-search
contract. The shared server already defaults unset settings to Hybrid. Saved Direct
or Code-only preferences are not migrated, and developer preferences were not edited.

No MCP-specific search filter, new tool kind, registry, transport inference,
developer-profile testing or new execution path.
