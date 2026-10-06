# Floating composer and reliable conversation scrolling

Status: Complete (2026-10-06)

## Goal and accepted direction

Make the conversation canvas feel continuous and restore reliable scrolling,
while retaining the accepted neutral surfaces, pastel accents, tactile controls,
sidebar and centered 820px reading measure. The user accepted the floating
composer study on 2026-10-06 and authorized implementation. On 2026-10-07 the user
also authorized committing, pushing and merging the validated result directly
into `main`, without a pull request.

The conversation has one full-height native scrollbar. The composer remains
anchored over a short canvas-colored fade. Current status and optional last-turn
statistics share one aligned support row above it, wrapping when required.
A compact three-dot Jump to latest control appears only while a turn is running
and the reader is away from the bottom. It floats outside layout flow; visibility
must not enlarge the fade or move the composer.

One primary button shows Send while idle, Stop while running with an empty or
whitespace draft, and Steer while running with text. Steer is the normal running
delivery; Ctrl/Cmd+Enter queues. Existing stored Queue defaults must not override
this accepted interaction. Remove the superseded delivery selector while retaining
send/newline and statistics preferences. Empty Enter never interrupts; IME never
submits. Ctrl/Cmd+. interrupts without discarding a draft and is documented in
composer help. Distinct send/interrupt operation lifetimes remain separate.

Server delivery, pending inbox, cancellation, accounting, bounded history and
item-range semantics remain unchanged. Stop aborts the current turn; it does not
discard already accepted pending input. Steer is injected at the existing safe
boundary, without interrupting active model or tool work.

## Grounded evidence and design rationale

The previous [design delivery](2026-10-04-desktop-design-system.md) is complete.
This is a follow-up outcome, not a reopening of that plan. Current architecture is
in [the interface subsystem](../../subsystems/interface/README.md).

The existing Ready row already has no opaque background. Its abrupt boundary and
the short scrollbar result from separate transcript/status/activities/approvals/
composer sections consuming independent height. Status and statistics also use
different insets. Solve ownership and alignment before changing colors.

A read-only in-memory React/Virtuoso fixture using installed react-virtuoso
4.18.16 and production CSS reproduced Jump ending 172px short, with further
same-item text growth increasing the gap to 286px. User/tool vertical margins
escape the measured wrappers. Containing those margins reached exact bottom and
kept following as text grew. Explicit initial end alignment also fixed a tall
last item opening 551px above its end. These are headless Edge fixture findings,
not actual Tauri qualification. They agree with
[Virtuoso troubleshooting](https://virtuoso.dev/react-virtuoso/troubleshooting/).

History prepend currently has no explicit viewport anchoring and can regroup
nested tool rows when an earlier parent becomes available. Existing native
coverage proves static pagination and latest content appearing after Jump, not
exact bottom, resumed streaming follow or reader-offset preservation.

Prefer the existing virtualizer, correct measurement and semantic anchoring.
Do not add a custom scrollbar, replace the library or introduce a follow-state
machine unless a reproduced remaining case requires it. Full-height overlays
must reserve real content clearance and leave the scrollbar accessible. Approvals,
activities, draft growth and zoom must retain reachable controls.

## Milestones and completion checks

- [x] **Research and accepted composition.** Inspect current code, library, tests
      and docs; reproduce measurement/alignment failures headlessly; obtain the
      user's direction. Completed 2026-10-06.
- [x] **Scroll correctness and ownership.** Contain measured item spacing, open
      at the actual latest edge, preserve earlier-history visible anchors and
      retain virtualization. Completion: rendered regressions for tall messages,
      streaming growth, reading pause, resumed follow and pagination pass.
- [x] **Floating composer and primary action** (depends on scroll ownership).
      Implement the aligned support row, bounded support content, independent
      three-dot jump, fade and one Send/Stop/Steer button; retire delivery selector
      and update the isolated playground. Completion: headless light/dark/narrow
      inspection, primary/alternate/interrupt/IME/draft behavior checks pass.
- [x] **Review and repository validation** (depends on implementation). Synchronize
      docs, self-review and obtain three read-only lenses covering correctness,
      simplicity/architecture and tests/evidence/scope. Completion: actionable
      findings resolved, production/playground builds and root npm run check pass.
- [x] **Native qualification and handoff** (last). Rebuild and exercise actual
      Tauri/WebView2. Completion: applicable existing cases and added scroll/action
      regressions pass; record actual evidence and remaining platform limits.

## Validation tasks

1. Verify exact latest-edge visibility with mixed user/tool margins and tall final
   Markdown. Stream within one existing cell, scroll upward, jump during streaming
   and confirm continued follow. Disclosure and composer resizing must not lose it.
2. Load earlier byte-bounded history while preserving the visible message and
   pixel offset, including nested tools regrouping. Conversation switches must
   isolate scroll state; an idle conversation offers no Jump control.
3. Verify one primary action, whitespace handling, Steer default and Queue
   shortcut, empty Enter, composition/keyCode 229, swapped newline preference,
   disconnected/pending guards, draft editing during acknowledgement and failure,
   and interrupt with a retained draft.
4. Check aligned current/previous-turn information, unchanged unknown/incomplete
   accounting, approvals and activities, minimum window and 200% zoom. Showing or
   hiding Jump must leave the dock and gradient geometry unchanged.
5. Run focused regressions and headless inspection first, then independent review,
   npm run check and builds. Visible native E2E runs only at the end because its
   application windows interrupt the user.

## Delivery evidence

Implementation and validation are complete on `codex/desktop-composer-scroll-polish`.
The user authorized shipping this validated branch on 2026-10-07.
The production canvas and actual-router/Composer fixtures substitute presentation
session state and delivery acknowledgements. They do not stand in for real RPC or
native app qualification. Production and playground builds pass. Focused Vitest
passes five preference, row identity and session tests. Full `npm run check` passes
typecheck, lint, formatting and 1,018 tests (118 passing files; 36 skipped tests).
All ten headless Edge regressions pass, including expansion of the latest tool
through the production Disclosure control. Light, dark/minimum and paused-reading
screenshots were inspected. The rebuilt native Windows suite passes 24 ordinary
cases with two WSL opt-ins skipped (4.2m). A separate final
`HARNESS_REMOTE_WSL=Ubuntu` run passes both real WSL cases (37.6s), including
provisioning cancellation and an approval surviving switching/exit/reconnect.
The actual native floating-composer screenshot was inspected. Final typecheck,
focused browser-test lint and documentation formatting also pass after the last
test-only coverage addition; `git diff --check` is clean.

Three independent review lenses covered correctness, architecture/simplicity and
tests/evidence/scope. Review corrected independent Stop guards and labels during
pending delivery, app-owned layout-unit measurements, readable viewport bounds
and parent fallback priority. Added regressions exercise delayed/rejected delivery
and replacement drafts, plus visible children becoming grouped. Re-review found
no remaining material issue. Test-only review corrections isolate disconnected
guards from empty/busy guards and use disjoint durable history IDs.

Investigation preserved several distinctions: initial latest checks must wait for
the virtualized list to have its real height and final visible target; a low gap
before initial measurement is not readiness. A parent at the beginning of history
cannot retain a child's lower offset without a negative scroll position; fallback
preserves its nearest reachable position. Support-height changes must arm the
existing virtualizer before footer growth, while the reader is at bottom.

Anchor tolerance is 1.5 CSS pixels. An independent rendered investigation captured
a 55.75px child offset, 60px sticky header and actual 61.5px virtualizer header.
Virtuoso rounds that header to 62px and ceilings the target to 67px; the parent
lands at 54.5px, exactly 1.25px above the intended offset. The correct row is
visible, with one scroll call. This bounded quantization is distinct from the
original lost-position behavior; no retries or timeout increases mask it. Header
rounding contributes at most 0.5px and target ceiling at most 1px.

The first native run passed 23 ordinary cases, skipped both WSL opt-ins and failed
the added empty-to-stream case with a 1,980px latest-edge gap. A matching headless
case reproduced 2,027px: the first user row was attached while initial alignment
was pending, then fast assistant output arrived. The virtualizer had captured
numeric index zero for its deferred initial scroll. Using its public `LAST` target
resolves the latest row when that scroll executes. The original headless failure
and all ten browser cases pass after the correction. The unchanged focused native
regression passes against rebuilt assets (14s), followed by the passing full
ordinary native suite. Independent review also verified that a new tall assistant
follows after the first user row has already settled at bottom; ordinary Boolean
follow remains sufficient in that path.

Synthetic CSS zoom exposed mixed visual/layout coordinates. App-owned clearance
now uses layout height, and history offsets normalize that scale. Installed
Virtuoso also mixes these coordinates internally for item/header/footer and custom
viewport measurement. The inherited 200% check qualifies control reachability and
overflow, not follow/pagination at injected CSS zoom or real OS/browser zoom.
Avoiding a private library fork or custom virtualizer preserves this work's scope.

Release installers, other native platforms, screen readers and live credentialed
OAuth remain outside existing Windows qualification.
