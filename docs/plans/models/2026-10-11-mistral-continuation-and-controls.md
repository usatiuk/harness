# Mistral continuation and catalog controls

Status: Complete

On 2026-10-11, the user authorized a coordinating chat to integrate this change
into main. This worktree supplies one validated commit; the coordinator owns
integration and pushing. No main-checkout, installed-app or GUI action is performed here.

## Outcome and evidence

Fix the reported second-request HTTP 422, expose advertised reasoning settings,
and distinguish model IDs that share a display label in desktop and TUI pickers.
The pasted production response rejects replayed output-entry `id` fields. The
adapter previously replayed those fields unchanged, and its HTTP fixture accepted
them. Strip only the top-level entry ID when rendering input; preserve stored
native output, signed/opaque content, model metadata and `tool_call_id`.

Catalog parsing previously filtered reasoning through a fixed off/low/medium/high/max
map and collapsed low to none and medium/max to high. The user's Vibe diagnostic
reports unsupported controls. Instead, expose bounded, validated advertised
strings and forward the selected value unchanged, except the legacy UI value
`off`, which means native `none`. A missing setting leaves the vendor default.
Preserve advertised reasoning capability even when no effort list is supplied;
do not invent effort levels from a boolean or model name.

Primary evidence checked on 2026-10-11:

- [Mistral reasoning](https://docs.mistral.ai/studio/conversations/reasoning)
  documents GLM 5.3 low/high/max and the Conversations `completion_args` boundary.
- [Vibe catalog types](https://github.com/mistralai/mistral-vibe/blob/main/vibe/core/model_catalog/models.py)
  declare reasoning as a list of strings, not a client-owned enum.
- [Mistral model capabilities](https://github.com/mistralai/client-python/blob/main/src/mistralai/client/models/modelcapabilities.py)
  include the reasoning boolean, currently omitted by Harness.

Aliases remain selectable exact IDs. Desktop uses existing Radix Select/Tooltip
primitives to show model names with dimmed exact IDs and move capacity/reasoning
details to hover/focus. TUI uses concise provider/ID labels. The creation form
previously had no preset selector at all; add it through the existing atomic
model selection, preserve its initial default and clear it on identity changes.
No registry, retry, transport fallback or store rewrite.

## Completion checks

- [x] Reproduce rejection through the real SDK/local HTTP boundary; correct replay
      and verify assistant-only and tool-continuation inputs preserve native content.
- [x] Expose advertised controls and capability, verifying exact effort delivery,
      aliases, omitted defaults and rejected unadvertised selections.
- [x] Qualify same-label selection in TUI and production desktop routes.
- [x] Synchronize architecture/testing/product evidence, run `npm run check`,
      self-review and resolve independent correctness, simplicity and evidence reviews.

## Validation and limits

Before correction, the real SDK/local HTTP regression reproduced the reported 422
for assistant-only history on both connections and signed tool continuation.
Catalog and picker regressions also failed for dropped efforts/capabilities and
indistinguishable labels. After correction, 64 focused provider/RPC/TUI tests pass.
All 16 headless browser tests pass, including production-route checks for dimmed
IDs, hover capacities, effort display, creation submission and clearing after a
model change. Settings regressions verify clearing a reviewer selection and
refreshing the saved default identity after loader revalidation.

Three independent read-only reviews cover correctness, failure/architecture and
explicit overengineering/leaky-abstraction risk, plus tests/evidence/docs/scope.
The simplicity review found that the settings picker no longer reset when its
saved identity changed. A narrow guarded state reset restores that behavior,
preserves unsaved selections while the saved identity stays unchanged, and passes
its production-route regression. The reviewer confirms resolution; no other
actionable findings remain.

Dependency installation and Vitest cache renames initially failed with sandbox
EPERM; unsandboxed retries succeeded. Headless Edge startup similarly required
unsandboxed profile writes. Typechecking, lint and formatting pass on Windows/Node
24.19.0. That full run passed 1,245 tests, skipped 36 and failed two unchanged MCP
OAuth cases (expiry timeout and refresh connection unavailable). Isolating the
file under Node 24 retains the expiry timeout; the same seven tests all pass
under the repository's pinned Node 22.23.3 without code or timeout changes.
Switching the full run to Node 22 initially exposed the SQLite dependency built
under Node 24 (`NODE_MODULE_VERSION` 137 versus 127). That invalid run was stopped;
rebuilding only the local SQLite dependency and executing a real in-memory query
verified the corrected ABI. The final `npm run check` passes on pinned Node 22.23.3:
typechecking, ESLint, repository formatting, 141 test files and 1,247 tests pass;
9 files and 36 tests are skipped. `git diff --check` also passes.
Node 24 OAuth compatibility remains outside this correction; the internal cause
has not been established.
Local synthetic HTTP/SSE establishes request fidelity; it does not establish live
vendor acceptance, subscription billing or native desktop packaging. Native test
selectors were updated but the visible native suite was not executed.
