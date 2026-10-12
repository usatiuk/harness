# Compact, adjustable sidebar

Status: Complete

## Outcome

A resizable/hidable desktop sidebar with collapsible Recents and folder-derived
Projects. Recents initially shows 20 conversations from all folders. Each project
starts with five chats and Show more adds five. Hidden folders reappear only when
the user opens or creates a chat there; hiding does not remove chats from Recents.
Width defaults to 220px and can resize 160–400px without exhausting main content.

Only accepted nonempty user input, including queues, changes recent ordering.
Opening, tool/agent activity, approvals and Stop do not. New conversations use
creation time until first input. Projects sort by their newest eligible chat.
Ordering and paging happen server-side, including beyond the first 50 records.
Folder groups derive from conversation metadata; no project entities or scanning.
Keep subagents excluded through the existing durable spawn marks.

## Boundaries and defaults

Existing conversation list gains recent-input order and folder filtering. Persist
one timestamp in conversation metadata; retain creation-order callers. A bounded
folder-summary query belongs to the application composition; no project lifecycle.
Desktop refreshes after sends/creation/reconnection, without polling or new push
coordination. Sidebar width/visibility use existing desktop preferences; section,
project collapse and hiding use the existing host/server storage namespace.
Recents 20 and folder 5 increments are presentation constants, not settings.
Folder labels use names/full-path tooltips, parent paths distinguish collisions.
No pins, custom sections, search, drag ordering, renaming or sort-mode UI.

## Milestones and completion checks

- [x] Persist accepted-input recency; indexed ordering/filtering/folder queries;
      public RPC projection and bounded pagination. Validate rejects, queues,
      empty input, stable ties, restart and older conversations.
- [x] Desktop sections, five-per-folder paging, hide/reappear, remembered layout,
      pointer/keyboard resizing and accessible toggle. Preserve status marks and
      subagent exclusion; verify browser outcomes.
- [x] Full check, scoped independent correctness/simplicity/evidence reviews,
      owning documentation and local validated commits. No push or release.

## Implementation and review evidence

- Store schema 8 adds `lastUsedAt`, with creation-time backfill for existing chats.
  Accepted nonempty user input commits this timestamp synchronously before inbox
  admission. No async admission gap or new coordinator is introduced.
- `app.conversations.list` reuses the existing conversation list schema and shared
  projection, adding composition-owned subagent exclusion before the store limit.
  Folder summaries derive from the same metadata with bounded keyset pages.
- Refresh replaces page objects and preserves loaded counts; late responses to
  replaced pages cannot overwrite current data. No timers, generations, live
  synchronization or project lifecycle were added. The superseded list-more route
  action was removed.
- Independent correctness, simplicity and evidence reviewers approved the final
  architecture. Evidence review independently passed 173 core/store tests.
- Real RPC regression: 5 tests pass, including 66 folders, 120 subagents and
  accepted-send/create refresh. Earlier failures were fixture setup: attaching the
  conversation before delivery and advertising the fake model before creation.
- Full `npm run check` passes: typecheck, lint, formatting and 1,325 tests
  (38 existing skips). Browser regressions pass 36/36; the additional sidebar
  screenshot run passes and its rendered layout was inspected.
- Delivered as a local sidebar commit, separate from the AppImage fix. No push
  or release. All test homes and browser profiles are isolated.

## Separate AppImage work

The AppImage child-environment correction is committed separately as `53e01c9`.
It removes AppImage-injected loader/Python variables only from the external server
child. Desktop unit tests pass (8); two unchanged preparation integration tests
fail on reqwest blocking-runtime teardown within an async runtime. Rebuilt AppImage
GUI qualification is not claimed. Never test against the developer's profile or credentials.

## Publication

The user authorized release after local delivery. Commits `53e01c9` (AppImage) and
`26fe931` (sidebar) are pushed. Release run
[38303570706](https://github.com/usatiuk/harness/actions/runs/38303570706) passes its
source gate, Windows x64/Linux x64 glibc/Apple Silicon builds and artifact signature
verification. The workflow captures version bump `1a47083`.
[v0.1.10](https://github.com/usatiuk/harness/releases/tag/v0.1.10) is published.
Its exact Linux AppImage passes cold headless preparation through the extracted
AppRun launcher in an isolated temporary home. This does not establish interactive
GUI/tool execution; the source subprocess regressions qualify child environment
cleanup. The headless artifact probe used an isolated home. The later TUI-test investigation
found that a temporary Harness home alone did not isolate credentials; that fixture
is corrected below.

## Quiet labels follow-up

Status: Complete; published in v0.1.11. The accepted Quiet labels preview includes: muted ghost
Show more controls, uppercase section labels, small right-side Lucide chevrons,
flat project-chat alignment and unclipped selection rounding. Remove the folder
subtitle and shorten the conversation header. Use a muted one-pixel Markdown
separator with 14px margins; use 13px conversation text by default, configurable from 12–18px in existing
GUI Appearance preferences with proportionate headings. The font option uses the existing local Appearance preferences; no new preference store or RPC.

- [x] Implement scoped presentation changes and preserve sidebar interaction.
- [x] Verify long titles, compact header, divider styling, small typography and
      existing browser navigation/resize/hide flows in isolated browser fixtures.
- [x] Run the full check and complete scoped correctness/simplicity review.

The earlier credential-isolation correction remains included: real TUI sign-in
uses an explicitly selected temporary file/DPAPI backend and asserts its credential
artifact stays inside the fixture. Never use the developer keyring/profile.

Accepted follow-up scope includes a subtle spinner for running chats and a
session-only unread dot, cleared on opening; no server state or synchronization.
Linux native startup disables the public near-60-FPS preference with narrow FFI
and an explicit WebKitGTK 2.42 build/runtime minimum. This is an experiment in
render cadence, not a verified scrolling performance improvement.

Validation found a real smaller-font scroll defect: Virtuoso rounds each item's
height, accumulating a 5–10px initial error and losing stream follow. Its existing
`itemSize` hook now preserves fractional geometry, without timers, new offsets or
relaxed bottom assertions. Regression cases exercise sizes 12–18px.

The accepted design was extended during implementation: Projects precedes Recents;
section/project/chat navigation text is non-selectable including WebKit and layout
whitespace; shared dropdowns use existing Radix menus rather than OS menus. Named
forms submit canonical values, including empty options and disabled-field behavior.
Inputs, buttons, menus and popups share tighter spacing; touch controls retain
larger targets. Redundant model/sandbox headings are removed, popup heading top
margins are zero, composer row/bottom spacing is reduced, and shortcut/context
copy is concise with platform-correct Ctrl/Command labels. The title is outside the
scroll viewport so its scrollbar starts beneath it. Running work uses a muted
spinner, while unread output remains a separate session-local dot.

Direct + code (`hybrid`) is the shared application's default for new conversations;
explicit saved choices still win through the normal configuration cascade. The
standalone upgrade-test bundle now includes the code worker, matching production
payload construction. The original approval/upgrade regression passes after its
missing-worker root cause was established; no timeout or assertion changes.

Final follow-up validation: `npm run check` passes typecheck, lint, formatting and
1,327 tests (38 existing skips). All 47 browser regressions pass, including
fractional measurement at 12–18px, shared dropdown forms, unread/spinner behavior,
selection suppression, history anchors and large expansions. Nine native lib/bin
tests pass. Three independent reviewers found no unresolved correctness,
architecture or simplicity issue. Actual display cadence remains unmeasured.

The idle-history test captures the visible row's text/geometry and triggers prepend
in one browser evaluation, preserving its 1.5px assertion. Separate evaluations
could observe virtualizer corrections between baseline capture and prepend; no
product restoration defect was reproduced. Screenshot capture waits for its
Markdown divider to enter the viewport instead of capturing initial measurement.
The credential-isolation correction is committed separately as `2f57f55`.

### Follow-up publication

The user authorized committing, pushing and releasing all changes. Credential
isolation is `2f57f55`; desktop refinements are `652cc34`; the workflow captures
version bump `61bc28d`. Release run
[38309578256](https://github.com/usatiuk/harness/actions/runs/38309578256) passes its
clean-install source gate, Windows x64/Linux x64 glibc/Apple Silicon builds, and
artifact signature verification. [v0.1.11](https://github.com/usatiuk/harness/releases/tag/v0.1.11)
is published with signed desktop updates, including the AppImage. Linux updater
install/restart and actual rendering cadence remain unqualified; headless startup
does not establish either behavior.

The exact published Linux AppImage passes cold headless preparation through its
extracted AppRun launcher, with exit 0 and Node/server payload paths entirely
inside a new temporary home. No developer desktop profile or credentials are
used. This qualifies packaging/startup, not interactive GUI or updater execution.

### WebKit experiment cleanup

After publication, the user reported no benefit and authorized isolated native
frame samples and tracing. The
[frame-pacing investigation](../../research/2026-10-12-linux-frame-pacing.md) records
callbacks above 60 FPS with the preference enabled and sluggish scrolling in the
isolated conversation renderer. The user requested removal, commit and push.
The helper/FFI, test, direct dependencies and added 2.42 requirement are removed;
Linux returns to WebKit defaults. Historical v0.1.11 evidence above remains valid
for that published version. The follow-up also shortens the status/composer fade
to match the compact composer: 8px above the dock and solid by 28px through the
gradient, preserving its existing contrast and background coverage.

Cleanup validation: six native lib/bin tests pass with the locked offline
dependency graph. The full check passes (1,327 tests, 38 existing skips), and three
focused browser cases pass for reading/fade stability, support/composer growth and
compact conversation styling. The updated screenshot was inspected. The final
8px/28px revision passes the same three focused browser cases. The user resumed
commit/push/release after the preview.

The cleanup is committed as `10e5e84`, with workflow version bump `aa5595f`.
Release run [38312067506](https://github.com/usatiuk/harness/actions/runs/38312067506)
passes clean-install source checks, all three native platform builds, and artifact
signature verification. [v0.1.12](https://github.com/usatiuk/harness/releases/tag/v0.1.12)
is published with the shorter fade and WebKit defaults restored. The reported
scrolling cause remains unresolved; no replacement workaround is shipped.
