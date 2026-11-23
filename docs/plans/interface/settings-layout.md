# Desktop settings and inspector layout

Scope: redesign Settings around the task in each section, using Appearance as the
reference rather than restyling its controls. Correct inconsistent project actions
and the composer popovers identified in the rendered desktop.

- [x] Give settings sections a shared measure, heading rhythm, navigation and
      group spacing. Preserve section URLs, keyboard navigation and draft lifetimes.
- [x] Group defaults, application, worktrees, instructions, composer and feedback
      by task; distinguish effective settings, editing, recovery and destructive actions.
- [x] Make MCP status-first and group provider configuration/credential actions.
      Verify edits, saves, disclosures and authentication remain reachable.
- [x] Unify project action geometry, picker field spacing and usage facts.
      Check dense values and constrained windows without changing accounting.
- [x] Exercise real desktop browser routes and inspect wide/narrow renders.
      Run repository checks, document evidence and review the integrated diff.
- [x] Autosave ordinary preferences; keep credentials, host destinations,
      MCP server definitions and destructive operations explicit. Verify persistence
      and that editing ordinary preferences cannot submit secret fields.
- [x] Clarify saved hosts versus setup in Connections. Exercise add, test, connect,
      discovery and remove flows and inspect the resulting dialog.
- [x] Let React Router own navigation history. Changing a Settings section
      must not show a conversation loader or refetch unchanged host settings.
      Exercise browser Back/Forward and keep host-specific routes isolated.

Initial visual pass used an isolated Windows Tauri process, Playwright attached
over WebView2 CDP, and seeded browser routes at 1120×800 and 720×520. The
Providers render exposed that fixing spacing alone still left every form open;
the second pass uses collapsed provider rows. The dark populated usage inspector
aligned all measured value edges at both widths.

The seven Edge tests for instruction loading, editing, persistence, feedback
collection and destructive-action recovery passed. The native two-theme design
and accessibility scenario also passed on the development window. A separate
restart probe encountered a disconnected server after reopening; these layout
checks do not establish restart qualification.

Ordinary preferences write scoped patches. The headless Edge regressions cover
rapid edits during a pending save, navigation during a write, failure/retry and
credential isolation. Defaults and MCP's default permissions are visible without
expansion. Add gateway and add/edit MCP use dialogs: the minimum-size check
verified the initial field and Escape focus restoration. The MCP suite exercised
the saved stdio/HTTP definitions, credentials and OAuth cancellation. Connection
fixtures covered explicit save/test/connect, WSL discovery, removal and
cancellation; live SSH/WSL provisioning was not part of this UI pass.

All 205 headless Edge scenarios passed after the final review fixes.
They include Back/Forward, legacy link and saved-route migration, a pending save
across a section switch, and Back across a host switch without a foreign RPC.
The saved-but-unavailable sandbox default is tested on a freshly opened host:
editing a fixture's server data must not mutate an earlier RPC response.
Repository validation (`npm run check`) passed: typecheck, ESLint, Prettier,
and 2,120 Vitest tests passed, with 83 skipped.

Final review reproduced an older queued edit overwriting a newer one after
reopening Settings. A per-session queue fixes that ordering and discards queued
writes on disposal. Focused Edge checks also covered returning from browser
OAuth, Back with a dialog open, blocking dismissal during gateway submission,
and reporting failed connection teardown rather than claiming success.

One integrated run overlapping the Edge suite hit the unchanged 10-second
timeout in the 32 MiB server feedback test. No timeout or assertion was changed.
