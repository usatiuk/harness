# Configuration and interface subsystem plan

## Objective

Keep dependable local TUI and desktop clients over one reusable service/event
boundary. Improve diagnosis and daily operation. Desktop v1 delivery is tracked
in [its concrete plan](../../plans/interface/2026-10-03-desktop-v1.md).

## Working, controls, and family navigation follow-up

The [cross-cutting follow-up](../../plans/cross-cutting/2026-10-19-agent-desktop-and-shell-follow-up.md)
is complete. It delivers the requested non-message Working grouping,
opened-preview retention, links/CSD control consistency, input-limit-aware
indicators, and readable non-dismissed family navigation. Its single checklist
records full-check/focused-browser evidence and the baseline history-anchor and
native-platform qualification limits.

## Desktop right sidebar

The [right-sidebar delivery](../../plans/interface/2026-10-18-right-sidebar.md)
adds Changes/Subagents tabs, continuous unified/split diffs via `@pierre/diffs` CodeView,
a compact file tree with line counts and comparison selector, five Git
comparisons and a root-anchored family tree with reused live side transcripts.
Validation evidence and qualification limits are tracked in that plan.

## Desktop streaming performance

The [approved refactor](../../plans/interface/2026-10-17-desktop-streaming-performance.md)
implements scoped notifications, 100 ms text/reasoning publication, stable
transcript references and lazy diff preparation. It is complete with full checks
passing 1,518 tests and Chromium passing 87/89; the delivery plan records both
baseline-reproduced history-anchor failures and native qualification limits.

## Desktop design refactor

The [conversation-first desktop design plan](../../plans/interface/2026-10-04-desktop-design-system.md)
is complete: reusable accessible components,
neutral light/dark surfaces, customizable pastel accents, shallow button depth,
and composer-triggered configuration. The user requested less density and more
focus on chat and accepted the playground direction. Production pages now share
chat bounds, focused retained Settings sections, folder-first creation and aligned
Connections/startup states. Root validation passes 1016 tests; rebuilt native
qualification passes 23 ordinary cases plus two real Ubuntu WSL cases separately.
Three independent reviews report no remaining material findings. Existing
client/server ownership and behavior remain intact. Separate UI-package extraction
and release-installer/other-platform qualification remain deferred.

## Release installation and updates

Installed-product delivery is separately tracked in the
[release, installation, and update plan](../../plans/cross-cutting/2026-10-10-release-installation-updates.md).
The bootstrap, payload and local IPC foundations are implemented with focused
headless evidence. Desktop now consumes shared prepared paths and retains its
own control helper; source startup uses complete immutable snapshots.
Cold preparation is a hidden, cancellable process; existing host cancellation
reaches it before admission, and app shutdown also awaits preparing operations.
The explicit desktop updater is implemented using Tauri, with headless UI and
shutdown evidence. Connect-time server replacement is implemented through existing
lifecycle controls. Native CLI updates are implemented; signed update and remote
qualification remain open.
Installed download/cross-version qualification, remote replacement and
platform qualification remain open in that plan.

## Diagnostics and supportability

- [ ] Add a focused diagnostic view/export for resolved model, provider limits,
      execution backend, loaded plugins, context-build purpose, and recent detailed
      failures.
- [ ] Redact credentials, OAuth tokens, provider payloads, and unrequested prompt
      content from support output by construction.
- [x] Make retry/attempt information visible when model reliability middleware
      lands (`model.retry` events folded into the Working presentation; delivered
      in the [model retry middleware plan](../../plans/models/2026-10-18-model-retry-middleware.md)).
- [ ] Keep verbose transcript as the canonical content inspector rather than add
      parallel per-item state.

### Acceptance

- A user can explain which provider/model/backend/plugins were active and why a
  turn failed without opening SQLite or exposing secrets.
- Diagnostic state is derived from existing configuration/events/records rather
  than maintained independently by the TUI.

## Remote-host delivery

[The cross-package delivery plan](../../plans/cross-cutting/2026-10-03-remote-hosts-background-servers.md)
delivers shared background servers, the Local-first host switcher, equivalent
desktop/TUI WSL/SSH editors, and client.json configuration. Shared RPC ownership
and the authenticated background owner/bridge are implemented and Windows process
regressions pass. Remote deployment passes on Ubuntu WSL and isolated OpenSSH;
real WSL desktop/TUI conversation flows qualify host switching, client exit,
reconnect and completion of pending work. Connection editors use the account's
normal Harness directory, without home/profile or executable-path controls.

## Deliberately deferred

- Web, ACP, remote multi-user surfaces, and parallel TUI presentation.
- A general UI component framework shared with hypothetical clients.
- Full branch visualization without a branch-management workflow.
- Profile selection without an actual launch or session-switch workflow.
- Transcript search/export until conversation length demonstrates the need.
- General file explorers and editors beyond the scoped Changes file tree.
- Silent provider or sandbox fallback in the name of smoother UX.
- Storing derived transcript/UI state durably.
