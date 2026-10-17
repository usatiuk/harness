# Worktree project grouping and picker

Status: Complete

## Scope

- Group conversations under `originalWorkspaceRoot ?? workspaceRoot`, retaining
  actual execution paths and existing worktree indicators. Apply grouping before
  pagination and preserve exact workspace filtering for existing consumers.
- Show a distinct, readable current checkout, recent worktrees and separated
  Original/New actions. Show at most five linked worktrees including the current
  linked worktree; the original checkout stays separate. An explicit Show all
  action preserves access to older worktrees.
- Order worktrees by existing conversation last-use or managed creation time,
  with stable path ties. Git remains authoritative for branch names/registration.
  No new activity tracking, stored labels, branch controls or workspace lifecycle.

## Delivery checks

- [x] Indexed project filter/grouping and additive SQLite upgrade, tested through
      both store implementations and application RPC/sidebar pagination.
- [x] Recent worktree ordering and picker presentation, including current/older
      selection, original/new actions, live refresh and running guards.
- [x] Synchronize docs/schema, run focused/full checks and independent review.

## Validation

- 94 focused tests pass across both stores, SQLite upgrade/index use, application
  RPC/sidebar pagination and real Git recency ordering.
- 15 sidebar/worktree browser cases pass, including current pinning, five linked
  worktree cap, Show all, older selection, original/new actions, external refresh,
  project grouping and reveal-on-navigation. The screenshot was visually inspected.
- Three independent read-only reviews found no functional issues. Their scope note
  is clarified above: the original checkout is separate from the linked-tree cap.
- `TMPDIR=/var/tmp npm run check` passes: 1,477 tests, 41 gated skips, typecheck,
  lint and formatting. Protocol 16, SQLite format 11 and the generated schema are
  synchronized. The SQLite upgrade adds only the project expression index.
- Headless UI tests qualify production presentation with
  controlled session data; real Git and application RPC tests establish server
  behavior separately. Native platform qualification is not established.
