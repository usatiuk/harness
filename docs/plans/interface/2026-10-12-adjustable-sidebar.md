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
