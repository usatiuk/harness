# Provider tool schema and desktop interaction corrections

Date: 2026-10-20. Status: Implemented, reviewed and locally validated; authorized patch delivery in progress.

## Requested outcomes

1. `worktree_switch` must be usable through the Anthropic connector and Gemini
   through default LiteLLM routing, without provider-side object-schema errors.
2. CSD window content must not scroll/bounce as a whole with touchpad gestures;
   conversation, sidebar and other intentional scroll areas remain functional.
3. Context/compaction disclosures must share the existing exclusive transcript
   detail behavior by construction, rather than each row remembering to opt in.
4. Each project heading gets an accessible new-conversation (+) shortcut next to
   Hide project, using that project's directory.

No installed app/server, credentials or saved host is to be changed. This work
is separate from the published 0.9.2 patch and compaction UX issue #49. The user
subsequently authorized commit, push and patch publication; use the existing
workflow-owned bump to 0.9.3, with actual hosted qualification before publication.

## Grounded design

- The worktree tool currently exposes the RPC discriminated union directly.
  Zod exports root `oneOf` without `type: object`; Anthropic rejects it locally,
  and default LiteLLM forwards it to Gemini. Use an object-shaped model input
  piped through the existing union validator, preserving valid call shapes and
  strict runtime rejection of invalid field combinations. Keep RPC unchanged;
  do not build a generic schema-flattening framework or loosen provider guards.
- Transcript tool/reasoning/plugin disclosures already use native named details;
  Context/compaction and shell omit the name. Centralize that inner transcript
  role in one wrapper. Preserve the separate outer Working group so opening a
  nested detail does not close its own ancestor.
- Root document CSS currently declares height but no overflow/overscroll policy.
  Establish a non-scrolling document boundary with native CSS, retaining all
  existing local scrolling. Verify browser semantics and distinguish actual GTK
  gesture/bounce evidence from Chromium wheel checks.
- Reuse existing `/new?cwd=...` navigation for the project shortcut. Query-only
  navigation must update the folder even when the New conversation route is
  already mounted; do not add another creation API or auto-create conversations.

## Milestones and checks

- [x] M1: Reproduce the schema rejection using the actual worktree tool, add a
      narrow object input/parser pipeline, and verify valid/invalid selections
      plus Anthropic and default LiteLLM request construction.
- [x] M2: Reproduce disclosure coexistence, unify inner transcript disclosure
      construction and verify exclusive switching across context, compaction,
      tools, reasoning and shell without closing outer Working.
- [x] M3: Add document scroll containment; verify root geometry/offset stability
      and continued local scrolling across conversation/sidebar/settings. Qualify
      GTK behavior where the isolated available engine permits; report limits.
- [x] M4: Add project (+), prove correct encoded project folder, no project
      toggle/hide and same-route query navigation. Check narrow/keyboard access.
- [x] M5 (depends on M1–M4): Run full local check and affected/full browser tests,
      independent correctness, simplicity and evidence reviews; resolve findings
      and synchronize architecture/testing/status docs with actual evidence.
- [ ] M6 (depends on M5): Commit/push reviewed changes, require fresh Windows,
      Linux x64 and ARM64 source CI, and dispatch normal `release.yml bump=patch`.
      Require four successful native builds and signed draft assembly, verify
      actual metadata/inventory, publish latest and check public downloads.
      Synchronize the generated version commit and final delivery documentation.

## Evidence and qualification limits

- Schema baseline used actual server-assembled tool parameters: Anthropic rejected
  the missing root object type before HTTP; default LiteLLM forwarded the original
  root `oneOf`. Tool-only pipeline correction passes 27 focused parser/core/
  provider-composition cases, including 14 valid/invalid execution cases and both
  real provider serializers under intercepted HTTP. No RPC/provider guard changes.
- Disclosure baseline shows Context remaining open after Compacted context opens
  (`act_f40abaaf`, transcript author). The corrected wrapper passes all 30 ordered
  six-kind pair transitions, with click/Enter/Space and outer Working still open.
  Seven affected browser cases pass (`act_d1ec17f7`), including preview/Eval
  retention and independent Activities.
- Project shortcut baseline was missing; implementing it exposed stale creation
  folder state during query-only navigation. Five focused cases pass after folder
  synchronization. Independent correctness and simplicity reviews then caught
  repeating the same project shortcut after editing the folder. The exact new
  scenario fails (`act_0223ce25`) before adding the existing router navigation key
  to the effect dependency, then passes with no whole-form remount or extra state
  (`act_af8860c7`, four final shortcut/viewport cases). The submitted directory,
  keyboard access, expanded/collapsed state, hiding and narrow layout are covered.
- Missing root containment fails the policy baseline saved under
  `.harness/desktop-20261020/viewport-baseline.txt`. The corrected three-mode wheel
  tests pass (`act_d97f2daf`, final rerun `act_af8860c7`), including local sidebar,
  transcript and settings scrolling and unchanged document/chrome geometry.
- Isolated engine-only probes load the exact source root CSS rule into ephemeral
  GTK WebViews: system **2.52.6** and extracted AppImage engine **2.50.4** both
  compute hidden/none, keep root offsets zero, and allow local scrollTop180
  (`act_6969e905`). This is a CSS-policy probe with synthetic HTML, not the
  production app or physical inertial touchpad qualification. The older engine
  probe reuses host GLib with bundled WebKit/JSC; no installed app/server starts.
- Full `npm run check` passes **2,153 / 46 skips**, including all type/lint/format
  stages (`act_b1113ec1`). The first complete browser run passes **189/189**
  (`act_d10c3628`); the final rerun including the reviewed navigation-key fix also
  passes **189/189** (`act_394f8bdb`). No existing assertion was weakened, skip added or timeout
  increased; chat-list link counts now exclude the new project-heading shortcut.
- Three independent lenses (`correction-correctness-review`,
  `correction-simplicity-review`, `correction-evidence-review`) cover behavior,
  architecture/minimality and evidence/scope. Correctness and simplicity identify
  the same concrete shortcut gap above; correctness re-review and fresh
  `shortcut-resolution-review` approve the correction without further blockers.
  Evidence review confirms the actual assembled-schema tests, failing baselines,
  unchanged assertions and explicit qualification limits; its outstanding full
  validation gate is satisfied by the final checks above.
- Parent self-review includes inspected sidebar screenshot and final diff.
  Documentation/status is synchronized. The user authorized commit/push/patch
  publication after reviewing the completed review-loop and simplicity summary.

Logs/probes are under `.harness/desktop-20261020/` and the referenced author output
directories. Live Anthropic/Gemini/LiteLLM acceptance, installed native touchpad
inertia and cross-platform native GUI behavior are not claimed by intercepted
serialization, Chromium or the engine-only CSS probe. Running app/server changes,
saved-host edits and real user worktree switches remain outside delivery scope.
