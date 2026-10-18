# Model metadata and portable tool inputs

Status: Complete

## Outcome and design

Separate endpoint support for plaintext/custom tool inputs and grammar syntaxes
from the model's preferred editing operation (`patch` or `replace`). Preserve
existing provider serialization, opaque payloads, usage, cancellation, approvals,
and immutable history. Keep function/JSON Schema/custom input kinds; custom tools
declare their JSON fallback field. One core adaptation boundary selects supported
input encoding, while the same parser/executor remains authoritative. Eval and
patch use this path. Remove the Anthropic-specific executable editor; retain old
call rendering. No probing, retry detection, grammar translation, or new switching
machinery.

Every shipped connection supports `config.models.<id>` for additions and overrides.
Use existing provider-specific model config and generation semantics; shared
metadata fields reuse one protocol schema. Native per-model controls are exposed
through narrow provider schemas: effort arrays/defaults for OpenAI/Codex and
Anthropic, Anthropic thinking, Go native preset controls/default, and Mistral
temperature/configured reasoning effort levels. Gemini adds no generation knobs. Config wins over discovered/maintained
metadata. Unknown custom-input support uses JSON; unknown editing preference uses
replacement. Unknown capacities remain unknown. OpenAI known supported models
use plaintext plus Lark/regex and patches; Codex known models use Lark and patches.
Go uses JSON and only explicitly known GPT entries prefer patches.

Codex's upstream catalog explicitly exposes `apply_patch_tool_type: "freeform"`;
consume that patch recommendation plus the required advertised reasoning choices
and default for new catalog IDs, without claiming arbitrary grammar support. Other inspected catalogs do not expose these settings. LiteLLM's existing
versioned Harness annotations can explicitly supply them. Existing discovery of
other metadata stays intact.

## Milestones and checks

- [x] Portable input and editing metadata: protocol types, single adaptation path,
      plaintext eval, JSON patch fallback, two editing rosters, historical display
      and replay. Check both encodings, invalid args, grammar omission, approval,
      and model switching through core/provider boundaries.
- [x] Consistent provider configuration and Codex discovery: all eleven connection
      types accept manual additions/overrides; exact model values override catalog
      defaults; adapter-incompatible custom support is rejected. Check catalog
      refresh, cancellation, limits, presets, and gateway annotation agreement.
- [x] Simplification, documentation, and independent review: remove superseded
      code/tests; synchronize README, owning subsystems, testing guidance and PLAN.
      Three read-only lenses cover correctness, simplicity, and evidence/scope.
      Run focused tests and `npm run check`; record actual limits.
- [x] Commit coherent validated increments. No push or release requested.

## Grounding

Read-only research checked all eleven shipped types. OpenAI standard models API
lists identities, not the target capabilities. Codex source has a richer catalog:
https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs
and https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs.
Go's live models list contains IDs; models.dev advertises ordinary tool calling,
not custom encodings. LiteLLM similarly separates ordinary tool metadata from
our explicit Harness annotation. Mistral/Vibe, Anthropic and Gemini catalogs have
useful limits/features but no editing preference or custom grammar list.

## Evidence

Implementation and validation are complete. Independent reviews found
and resolved mismatched JSON-patch approval contracts, missing manual generation
controls, discarded Codex reasoning choices, and inherited defaults after explicit
preset replacement. Three final read-only lenses cover correctness, simplicity,
and evidence/scope. The shared architecture was accepted without new abstractions.

Focused service cases pass for raw → JSON → raw switches, immutable wire arguments,
JSON patch allow/deny approvals with matching middleware contracts, and nested
AGENTS instructions. Native provider tests reach SDK/HTTP boundaries for manual
controls. Additional regression checks cover clearing preset defaults and Gemini
metadata overrides after discovery. Focused final provider regressions: 72 passed.

`npm run check` passes typechecking and lint, then stops at formatting an unrelated
untracked `work/sidebar-brainstorm/right-sidebar.html`; that file is preserved.
Typechecking and lint pass after the final code fixes. Formatting passes for all
tracked files plus the new task files. Full Vitest outside the sandbox with
`TMPDIR=/var/tmp` passes 1,671 tests (41 skipped), across 166 passing files and 10
skipped files. `git diff --check` passes. No live authenticated provider requests or paid model calls have
been made. Remote catalog availability and patch/replacement coding-quality parity
remain unverified; mocked HTTP tests establish mapping, not live service behavior.

Final review resolved empty preset inheritance for OpenAI/Codex, Anthropic and Go;
explicit invalid defaults still fail. OpenAI/Codex effort names remain bounded,
extensible provider tokens rather than a closed SDK enum. Missing direct Zod
dependencies are declared. A final correctness follow-up found no new actionable
issues. Typecheck, lint, tracked/task-file formatting and the full suite pass.

Implementation commit: `7789b37`. The final cleanup isolates direct OpenAI API
defaults in its maintained catalog rather than inferring Codex support from a
shared model name. A Codex regression verifies manual additions remain JSON-only
unless explicitly configured. Final full-suite rerun: 1,671 passed, 41 skipped;
final typecheck and targeted cleanup lint pass. The documentation/cleanup commit
completes the handoff. Unrelated untracked `work/` content remains untouched.
