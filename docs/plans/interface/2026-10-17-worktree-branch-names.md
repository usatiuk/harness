# Worktree branch names

Status: Complete

## Scope

1. Accept optional `branch` only on `worktree_switch` / new-worktree selection.
2. Generate readable `harness/<adjective>-<animal>` branches by default; add a
   numeric suffix when that generated name conflicts with an existing ref.
3. Refresh the desktop picker from Git when opened, including external renames.

Git owns branch names. Checkout directories keep UUIDs; persistence, conversation
paths, Docker ownership and switching lifetimes remain unchanged. Explicit names
are validated by Git before allocation/ownership writes. Existing recovery of
partially created owned checkouts remains intact. There are no naming/rename GUI
controls, new rename tools, stored labels or CLI naming options. This is the agreed
narrow scope from issue #40, superseding its broader suggestions.

Concurrent generated-name claims use Git's atomic ref creation. Retry only the
two observed branch-exists diagnostics (preliminary check and atomic ref claim),
up to ten collisions, retaining the same checkout path and ownership entry.
The starting commit is captured once and reused on retry. Explicit names and
all other Git failures are never retried.

## Milestones

- [x] Extend the existing new-worktree selection and manager creation seam, with
      real-Git tests for explicit/invalid/conflicting names and generated collisions.
- [x] Refresh picker on opening; verify changed Git data through production UI.
- [x] Verify tool/service/RPC propagation, synchronize contract schema/docs, run
      full checks and independent review.

Delivery requested by the user: commit, push to main and close issue #40 with the
agreed narrower scope.

## Validation

- The 23 focused package/schema, workspace-switch and real RPC/Git tests pass.
- Six worktree browser cases pass, including picker refresh after a controlled
  server-side rename. Real Git rename and stable paths are separately verified
  by package/RPC tests.
- Review reproduced the concurrent allocation race. The initial classifier also
  missed actual Git exit255 and atomic `reference already exists` diagnostics;
  the final classifier covers both exact diagnostics in C locale. The deterministic
  regression passes, and independent replay produced 50 successful checkouts with
  no failures or ownership mismatches. A further regression confirms the captured
  starting commit/content survives collisions and source advancement.
- Three independent reviews are resolved. `TMPDIR=/var/tmp npm run check` passes:
  1,473 tests, 41 gated skips, typecheck, lint and formatting. The final six
  worktree browser cases also pass. The worktrees plugin contract is version 2;
  its generated JSON Schema is synchronized.

Tests use `TMPDIR=/var/tmp`: the current `/tmp/.git` is an unrelated empty directory.
Native desktop and live-agent qualification are outside this source/browser change.
