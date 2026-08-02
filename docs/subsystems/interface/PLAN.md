# Configuration and interface subsystem plan

## Objective

Keep one dependable local TUI and one reusable service/event boundary. Improve
diagnosis and daily operation before multiplying client surfaces.

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

- Web, desktop, daemon, ACP, and remote multi-user surfaces.
- A general UI component framework shared with hypothetical clients.
- Full branch visualization without a branch-management workflow.
- Profile selection without an actual launch or session-switch workflow.
- Transcript search/export until conversation length demonstrates the need.
- Another client until a concrete consumer validates the service boundary.
- Silent provider or sandbox fallback in the name of smoother UX.
- Storing derived transcript/UI state durably.
