# Configuration and interface subsystem plan

## Objective

Keep dependable local TUI and desktop clients over one reusable service/event
boundary. Improve diagnosis and daily operation. Desktop v1 delivery is tracked
in [its concrete plan](../../plans/interface/2026-10-03-desktop-v1.md).

## Diagnostics and supportability

- [ ] Add a focused diagnostic view/export for resolved model, provider limits,
      execution backend, loaded plugins, context-build purpose, and recent detailed
      failures.
- [ ] Redact credentials, OAuth tokens, provider payloads, and unrequested prompt
      content from support output by construction.
- [ ] Make retry/attempt information visible when model reliability middleware
      lands.
- [ ] Keep verbose transcript as the canonical content inspector rather than add
      parallel per-item state.

### Acceptance

- A user can explain which provider/model/backend/plugins were active and why a
  turn failed without opening SQLite or exposing secrets.
- Diagnostic state is derived from existing configuration/events/records rather
  than maintained independently by the TUI.

## Deliberately deferred

- Web, daemon, ACP, remote multi-user surfaces, and parallel TUI presentation.
- A general UI component framework shared with hypothetical clients.
- Full branch visualization without a branch-management workflow.
- Profile selection without an actual launch or session-switch workflow.
- Transcript search/export until conversation length demonstrates the need.
- Desktop side-by-side views, file explorers, editors, and worktree management.
- Silent provider or sandbox fallback in the name of smoother UX.
- Storing derived transcript/UI state durably.
