# Desktop design system and conversation-first refactor

Status: Complete

## Outcome and scope

The user accepted the playground and authorized complete production implementation
on 2026-10-04 using ship-change and an active goal. This includes page composition,
spacing and alignment, not only replacing controls. Chat is the main surface;
settings, connections, creation and startup follow the same layout language.

Use neutral light/dark surfaces, pastel/custom accents and shallow tactile buttons
with neutral faces and colored lower edges. Tinted buttons derive face, border,
base and states from one color; destructive buttons use the same recipe with an
independent danger tint. Navigation remains flat and compact, distinct from
buttons. Preserve the accepted selection fill and quiet borders.

The latest feedback requires:

- One shared chat column for transcript, user bubbles, tools and composer rows.
  Retain the full-width Virtuoso scroller, bounded history and item ranges.
- Compact model/preset and sandbox chips in the composer, with controls revealed
  on demand. No permanent Queue/Steer switch or extra checkbox.
- Appearance only in Settings. Show one focused settings section at a time,
  instead of a long dump of every form.
- Folder-first, centered creation; aligned startup/connection states with recovery;
  compact Connections with rare server actions behind disclosure.
- Enter sends, Shift+Enter inserts a newline, Ctrl/Cmd+Enter uses the alternative
  Queue/Steer action while working. Settings can swap the first two and change
  default delivery. IME composition never submits.
- A context ring left of Send, authoritative popup facts, optional last-turn
  input/output/tok/s above the composer, and no textarea resize grip.
- Lucide throughout; no hand-authored SVG icons.

Separate npm-package extraction remains explicitly deferred. Keep the reusable
UI boundary in the desktop; do not publish. Preserve client/server ownership,
credentials, cancellation, drafts and execution semantics. No IDE, split chats,
onboarding wizard, web client or general theme engine. The user authorized commit,
push and merge to the default branch after qualification on 2026-10-04.

## Ownership and implementation

- `src/ui.tsx` wraps native controls and Radix Primitives. Buttons default to
  `type="button"`; form submitters are explicit. Radix owns popovers, dialogs,
  alert-dialogs, tooltips and tabs. Owners capture destructive intent and provide
  retained focus targets when openers disappear or become busy.
- Semantic token ramps map surfaces, fields, navigation and button states.
  `controls.css` owns shared recipes; `styles.css` owns page geometry. Tailwind v4
  supplies utilities. Radix Themes and class-inferred Button intent are removed.
- `appearance.ts` applies document-root preferences before render, including
  portals, retains old `theme` storage and follows System media changes. Typed
  client preferences own accents/depth/radius and composer behavior.
- Router loaders/actions/fetchers and DesktopSession/DesktopHosts remain the
  authorities. Fetchers stay mounted above popover portals. Force-mounted settings
  panels are hidden when inactive, preserving fields and active sign-in without
  adding a draft store. The existing per-host router location owns the selected
  section through a search parameter, preserving it across server restart.
- Transcript, tools and composer/support rows share centered measures. Cumulative
  usage moves into the context popup; current status and optional turn stats remain.
  The context indicator uses a single radial mask, keeping its inner and outer
  circles concentric and allowing the parent surface to show through.
- The playground consumes production controls/tokens; illustrative host/chat state
  and preference persistence stay isolated.

Research used official
[Radix Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction),
[Radix styling](https://www.radix-ui.com/themes/docs/overview/styling),
[Tailwind theme variables](https://tailwindcss.com/docs/theme) and
[shadcn/ui](https://ui.shadcn.com/docs). Existing primitives satisfy the interaction
contracts; no parallel component framework or select implementation is needed.

## Authoritative metrics

The usage-summary boundary carries the latest agent request attempt and latest
terminal turn. The ring compares reported input with that exact model's advertised
window. Drafts/later context are not estimated. Missing usage/capacity is unavailable.

Each model attempt records optional purpose and server-measured duration. Turn
totals include every model request owned by that turn (agent, reviewer, compaction
and plugin requests), excluding separate child-conversation turns. Throughput uses agent
output divided by agent request time, including latency and excluding tool/approval
waits. Missing accounting/timing stays unavailable; incomplete totals are lower
bounds. Aborted/failed attempts without observed accounting record unknown usage,
not fabricated zero. Usage is published before tools and terminal status. Scoped
model invocations settle before their turn closes, preventing late accounting.

SQLite v4 adds nullable purpose/timing and indexes to v3 databases. Historical
records retain unknown purpose/timing. Extra summary lookups are indexed/bounded
to the latest attempt and turn. Protocol v4 makes new nullable summary fields
required and rejects incompatible peers before attach. Public core/service/store
regressions and reopened native SQLite/RPC establish these meanings.

## Milestones and completion checks

- [x] **Accepted direction and grounded audit.** Read contracts, inspect routes,
      styles/native tests, research maintained primitives and build accepted playground.
- [x] **Reusable foundation** (depends on direction). Tokens, controls, client
      preferences, reduced motion/forced colors and legacy theme migration. Completion:
      build/typecheck, rendered contrast and integrated focus/form checks.
- [x] **Conversation and metrics** (depends on foundation). Preserve selection,
      approvals, drafts, delivery/stop, history, activities and errors. Completion:
      public regressions plus actual native interactions and persistence/reopening.
- [x] **Complete page composition** (depends on foundation). Shared chat bounds,
      focused settings, provider rows, creation, Connections and startup/disconnected
      states. Completion: inspect actual Tauri screens in both themes and verify all
      features, including retained tab field/sign-in state. Latest user feedback
      explicitly requires this slice.
- [x] **Qualification and handoff** (depends on all slices). Remove obsolete styles,
      synchronize docs and resolve three read-only review lenses: behavior/accessibility,
      simplicity/architecture and evidence/scope. Completion: root `npm run check`,
      frontend build and rebuilt native Windows/real WSL suite pass; record gaps.

Implementation and qualification are complete. At the user's request, native end-to-end runs took place at the
end of layout work because they open real application windows.

## Evidence and qualification limits

The final rebuilt Tauri/WebView2 ordinary suite passes 23 cases (4.3m), with two
opt-in WSL cases skipped. A separate final run with `HARNESS_REMOTE_WSL=Ubuntu`
passes both real WSL cases (42s), including provisioning cancellation and pending
approval across host switching, exit and reattachment. All 25 scenarios therefore
have passing final evidence, without describing the ordinary invocation as 25/25.
Frontend and playground builds pass.

Design checks cover preset/extreme accents, System media changes, reduced
motion/forced colors, forward/reverse Tab, Cancel initial focus,
cancellation/Escape return, acceptance while busy, retained fields/sign-in across
Settings sections, legacy preferences, reopening and persisted usage. Settings,
providers, creation and Connections have visible text audits and native screenshots
in both themes. CDP minimum viewport plus measured 200% CSS zoom establishes scaled
reachability/overflow, not OS resizing or native browser zoom.

The preceding 25-case layout run passed 22 cases and exposed three failures.
Restart reconstructed Settings on Appearance: the selected section now belongs
to the existing persisted router location. The new draft-retention scenario used
an exact label locator that did not find the select; it now uses the same semantic
combobox locator as the existing Defaults regression. All four affected native
checks passed on focused rerun before the complete final run above. No assertions
or timeouts were weakened.

Shared-control browser snapshots in light/dark each reported 82 text checks passed,
zero failed and zero needing review. These are rendered axe text-contrast snapshots,
not static analysis or complete accessibility certification. Control boundaries,
selected/hover/focus prominence and composition require visual review. Extreme
custom tint checks must prove that the rendered recipe changed, not only the
input's value.

Earlier CLI reconnect/background failures were traced to temporary cwd discovery
walking into the user's real `.harness/settings.json` when HARNESS_HOME was
redirected. Fixtures now establish isolated workspace `.harness` boundaries;
production discovery is unchanged. An overlapping validation run passed 1015
tests but timed out the server-ownership scenario at 20 seconds. Final independent
`npm run check` passes all 1016 tests (117 files, 36 skipped), plus typecheck,
lint and formatting. The timeout did not recur; concurrency was not established
as its cause. No timeout increase, retry or assertion weakening was applied.

Three read-only reviewer lenses report no remaining material findings. Closure
includes the shared 820px chat measure, same-turn metrics wording, controlled
focus return, startup recovery, bounded creation labels and route-owned settings
section. The final repository check after these corrections passes typecheck,
lint, formatting and all 1016 tests (117 files, 36 skipped; 56.38s test phase).
macOS/Linux native installation, live
credentialed OAuth and screen-reader qualification remain outside existing
Windows qualification scope. Media emulation is not a global OS setting change.
Release-installer qualification remains separate from rebuilt debug native tests.
